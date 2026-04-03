import type { JobRecord, MissionLaneRecord, MissionRecord } from '../../contracts';
import { nowIso } from '../../utils';
import { missionCanAutoApprove, normalizeMissionParallelism, reconcileMissionFromJobs } from './reconcile';

export interface MissionSchedulerContext {
	getJob(jobId: string): Promise<JobRecord | null>;
	listMissionJobs(missionId: string): Promise<JobRecord[]>;
	upsertJob(job: Partial<JobRecord> & { job_id: string }): Promise<void>;
	persistMission(mission: MissionRecord, previous?: MissionRecord | null): Promise<void>;
	writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void>;
	autoApproveJob?(job: JobRecord, note: string): Promise<JobRecord | null>;
}

function encodeSegment(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
}

function childJobIdForLane(mission: MissionRecord, lane: MissionLaneRecord, attempt: number): string {
	return `${encodeSegment(mission.mission_id)}-${encodeSegment(lane.lane_id)}-a${attempt}`.slice(0, 80);
}

function childWorkBranch(jobId: string): string {
	return `agent/${jobId}`;
}

function activeExecutionCount(mission: MissionRecord): number {
	return mission.lanes.filter((lane) => lane.status === 'launched' || lane.status === 'working').length;
}

async function launchLane(
	context: MissionSchedulerContext,
	mission: MissionRecord,
	lane: MissionLaneRecord,
): Promise<{ lane: MissionLaneRecord; job: JobRecord | null }> {
	const attempt = Math.max(1, lane.attempt + 1);
	const jobId = childJobIdForLane(mission, lane, attempt);
	await context.upsertJob({
		job_id: jobId,
		repo: mission.repo,
		base_branch: mission.base_branch,
		work_branch: childWorkBranch(jobId),
		operation_type: lane.title,
		target_paths: mission.target_paths,
		mission_id: mission.mission_id,
		lane_id: lane.lane_id,
		lane_role: lane.role,
		attempt,
		depends_on_lane_ids: lane.depends_on_lane_ids,
		status: 'queued',
		next_actor: 'worker',
		notes: [`Spawned by mission ${mission.mission_id} lane ${lane.lane_id}.`],
	});
	const job = await context.getJob(jobId);
	await context.writeAudit('mission_lane_launched', {
		mission_id: mission.mission_id,
		repo: mission.repo,
		lane_id: lane.lane_id,
		job_id: jobId,
		attempt,
	});
	return {
		lane: {
			...lane,
			status: 'launched',
			attempt,
			current_job_id: jobId,
			launched_job_ids: Array.from(new Set([...lane.launched_job_ids, jobId])),
			spawn_token: `${mission.mission_id}:${lane.lane_id}:${attempt}`,
			last_error: null,
			blocked_reason: null,
			started_at: lane.started_at ?? nowIso(),
			updated_at: nowIso(),
		},
		job,
	};
}

export async function scheduleMission(
	context: MissionSchedulerContext,
	mission: MissionRecord,
	options: { launchEligible?: boolean; allowYolo?: boolean } = {},
): Promise<MissionRecord> {
	const previous = structuredClone(mission);
	const jobs = await context.listMissionJobs(mission.mission_id);
	const jobsById = new Map(jobs.map((job) => [job.job_id, job]));
	let nextMission = reconcileMissionFromJobs(mission, jobsById);

	if (nextMission.yolo_mode && options.allowYolo !== false && context.autoApproveJob) {
		for (const lane of nextMission.lanes) {
			if (!lane.current_job_id || lane.status !== 'blocked') {
				continue;
			}
			const job = jobsById.get(lane.current_job_id);
			if (!job || !missionCanAutoApprove(job)) {
				continue;
			}
			const approvedJob = await context.autoApproveJob(job, `Auto-approved by mission ${mission.mission_id} YOLO mode.`);
			if (approvedJob) {
				jobsById.set(approvedJob.job_id, approvedJob);
				await context.writeAudit('mission_lane_auto_approved', {
					mission_id: mission.mission_id,
					repo: mission.repo,
					lane_id: lane.lane_id,
					job_id: approvedJob.job_id,
				});
			}
		}
		nextMission = reconcileMissionFromJobs(nextMission, jobsById);
	}

	if (options.launchEligible !== false) {
		const slots = normalizeMissionParallelism(nextMission.max_parallelism) - activeExecutionCount(nextMission);
		if (slots > 0) {
			let launchesRemaining = slots;
			const updatedLanes = [...nextMission.lanes];
			for (let index = 0; index < updatedLanes.length && launchesRemaining > 0; index += 1) {
				const lane = updatedLanes[index];
				if (lane.status !== 'runnable' || lane.current_job_id) {
					continue;
				}
				const launched = await launchLane(context, nextMission, lane);
				updatedLanes[index] = launched.lane;
				if (launched.job) {
					jobsById.set(launched.job.job_id, launched.job);
				}
				launchesRemaining -= 1;
			}
			nextMission = reconcileMissionFromJobs({ ...nextMission, lanes: updatedLanes }, jobsById);
		}
	}

	nextMission.last_scheduler_at = nowIso();
	nextMission.updated_at = nowIso();
	if (JSON.stringify(previous) !== JSON.stringify(nextMission)) {
		await context.persistMission(nextMission, previous);
	}
	return nextMission;
}
