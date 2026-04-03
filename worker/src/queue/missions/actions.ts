import type { JobRecord, MissionLaneRecord, MissionRecord, QueueEnvelope } from '../../contracts';
import { canonicalizeRepoKey } from '../../repo-aliases';
import { buildJobEventFeed } from '../projections';
import { fail, jsonResponse, nowIso, ok } from '../../utils';
import type { QueueRequestContext, QueueResponse } from '../actions/context';
import { jobNotFound } from '../actions/context';
import { scheduleMission } from './scheduler';
import { buildMissionEventFeed } from './projections';
import { normalizeMissionParallelism } from './reconcile';
import { handleJobControl } from '../actions/reviews';

function missionNotFound(missionId: string): QueueResponse {
	return jsonResponse(fail('mission_not_found', `mission ${missionId} not found`), 404);
}

function normalizeLane(input: MissionLaneRecord, timestamp: string): MissionLaneRecord {
	return {
		...input,
		status: input.status ?? 'queued',
		depends_on_lane_ids: Array.from(new Set(input.depends_on_lane_ids ?? [])),
		attempt: input.attempt ?? 0,
		current_job_id: input.current_job_id ?? null,
		launched_job_ids: Array.from(new Set(input.launched_job_ids ?? [])),
		updated_at: input.updated_at ?? timestamp,
	};
}

function assertAcyclicLanes(lanes: MissionLaneRecord[]): void {
	const lanesById = new Map(lanes.map((lane) => [lane.lane_id, lane]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (laneId: string) => {
		if (visited.has(laneId)) return;
		if (visiting.has(laneId)) throw new Error(`mission lane cycle detected at ${laneId}`);
		const lane = lanesById.get(laneId);
		if (!lane) throw new Error(`mission lane ${laneId} is missing`);
		visiting.add(laneId);
		for (const dependencyId of lane.depends_on_lane_ids) {
			if (!lanesById.has(dependencyId)) throw new Error(`mission lane dependency ${dependencyId} not found`);
			visit(dependencyId);
		}
		visiting.delete(laneId);
		visited.add(laneId);
	};
	for (const lane of lanes) {
		visit(lane.lane_id);
	}
}

function normalizeMissionRecord(input: Partial<MissionRecord> & { mission_id: string }): MissionRecord {
	const timestamp = nowIso();
	const lanes = (input.lanes ?? []).map((lane) => normalizeLane(lane as MissionLaneRecord, timestamp));
	assertAcyclicLanes(lanes);
	return {
		mission_id: input.mission_id,
		repo: canonicalizeRepoKey(input.repo ?? ''),
		base_branch: input.base_branch ?? 'main',
		title: input.title ?? input.mission_id,
		operation_type: input.operation_type,
		target_paths: input.target_paths ?? [],
		status: input.status ?? 'queued',
		max_parallelism: normalizeMissionParallelism(input.max_parallelism),
		yolo_mode: input.yolo_mode ?? false,
		lanes,
		detached_job_ids: input.detached_job_ids ?? [],
		notes: input.notes ?? [],
		created_at: input.created_at ?? timestamp,
		updated_at: timestamp,
		last_scheduler_at: input.last_scheduler_at ?? null,
		last_reconciled_at: input.last_reconciled_at ?? null,
	};
}

async function buildMissionFeedForResponse(context: QueueRequestContext, mission: MissionRecord, limit = 50) {
	const laneFeeds = [];
	for (const lane of mission.lanes) {
		if (!lane.current_job_id) continue;
		const job = await context.getJob(lane.current_job_id);
		if (!job) continue;
		const audits = await context.listAuditRecords(undefined, job.job_id, limit);
		laneFeeds.push({ lane_id: lane.lane_id, feed: buildJobEventFeed(job, audits) });
	}
	return buildMissionEventFeed(mission, laneFeeds);
}

export async function handleMissionCreate(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	if (!payload.mission?.mission_id) {
		return jsonResponse(fail('bad_request', 'mission_id is required'), 400);
	}
	const mission = normalizeMissionRecord(payload.mission as Partial<MissionRecord> & { mission_id: string });
	await context.persistMission(mission);
	await context.writeAudit('mission_create', { mission_id: mission.mission_id, repo: mission.repo, lane_count: mission.lanes.length });
	const scheduled = await context.reconcileMission(mission);
	return jsonResponse(ok({ mission: scheduled, progress: await context.buildMissionProgressSnapshot(scheduled) }));
}

export async function handleMissionGet(context: QueueRequestContext, missionId: string): Promise<QueueResponse> {
	const mission = await context.getMission(missionId);
	return mission ? jsonResponse(ok({ mission })) : missionNotFound(missionId);
}

export async function handleMissionList(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const missions = await context.listMissions({ status: payload.mission_status, repo: payload.repo_key });
	const progress = await Promise.all(missions.map((mission) => context.buildMissionProgressSnapshot(mission)));
	return jsonResponse(ok({ missions: progress }));
}

export async function handleMissionProgress(context: QueueRequestContext, missionId: string): Promise<QueueResponse> {
	const mission = await context.getMission(missionId);
	if (!mission) return missionNotFound(missionId);
	const reconciled = await context.reconcileMission(mission);
	return jsonResponse(ok({ progress: await context.buildMissionProgressSnapshot(reconciled) }));
}

export async function handleMissionEventFeed(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const missionId = payload.mission_id ?? '';
	const mission = missionId ? await context.getMission(missionId) : null;
	if (!mission) return missionNotFound(missionId);
	const feed = await buildMissionFeedForResponse(context, await context.reconcileMission(mission), payload.limit ?? 50);
	return jsonResponse(ok({ ...feed }));
}

export async function handleMissionControl(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const missionId = payload.mission_id ?? '';
	const mission = missionId ? await context.getMission(missionId) : null;
	if (!mission) return missionNotFound(missionId);
	const action = payload.mission_control_action;
	if (!action) return jsonResponse(fail('bad_request', 'mission_control_action is required'), 400);
	let nextMission = structuredClone(mission);
	if (action === 'enable_yolo' || action === 'disable_yolo') {
		nextMission.yolo_mode = action === 'enable_yolo';
	}
	if (action === 'retry_failed') {
		nextMission.lanes = nextMission.lanes.map((lane) =>
			lane.status === 'failed' || lane.status === 'detached'
				? { ...lane, status: 'queued', current_job_id: null, blocked_reason: null, last_error: null, updated_at: nowIso() }
				: lane,
		);
	}
	for (const lane of nextMission.lanes) {
		if (!lane.current_job_id) continue;
		const job = await context.getJob(lane.current_job_id);
		if (!job) continue;
		if (action === 'pause' || action === 'resume' || action === 'cancel') {
			await handleJobControl(context, {
				action: 'job_control',
				job_id: job.job_id,
				control_action: action,
			});
		}
	}
	await context.persistMission(nextMission, mission);
	await context.writeAudit('mission_control', { mission_id: nextMission.mission_id, repo: nextMission.repo, action });
	const reconciled = await context.reconcileMission(nextMission);
	return jsonResponse(ok({ mission_id: reconciled.mission_id, action, progress: await context.buildMissionProgressSnapshot(reconciled) }));
}
