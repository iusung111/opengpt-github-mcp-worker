import type { JobRecord, MissionLaneRecord, MissionRecord } from '../../contracts';
import { nowIso } from '../../utils';
import { aggregateMissionStatus } from './projections';
import { computeRunAttentionStatus, getApprovalManifest } from '../projections';

const YOLO_BLOCKED_ACTION_DENYLIST = [
	'workflow_dispatch',
	'pr_merge',
	'deploy_',
	'release_',
	'db_reset',
	'deploy_promote',
	'deploy_rollback',
	'self_deploy',
];

export function normalizeMissionParallelism(rawValue: number | undefined): number {
	const value = Number.isFinite(rawValue) ? Math.trunc(rawValue as number) : 3;
	return Math.max(1, Math.min(value, 4));
}

export function missionLaneDependenciesSatisfied(mission: MissionRecord, lane: MissionLaneRecord): boolean {
	return lane.depends_on_lane_ids.every((dependencyId) => mission.lanes.find((entry) => entry.lane_id === dependencyId)?.status === 'completed');
}

export function missionLaneStateFromJob(job: JobRecord): MissionLaneRecord['status'] {
	const attention = computeRunAttentionStatus(job);
	if (attention === 'failed') return 'failed';
	if (attention === 'completed' || job.status === 'done') return 'completed';
	if (attention === 'cancelled') return 'cancelled';
	if (attention === 'pending_approval' || attention === 'paused' || attention === 'interrupted') return 'blocked';
	if (job.status === 'queued' || attention === 'idle') return 'launched';
	return 'working';
}

export function missionLaneFromChildJob(lane: MissionLaneRecord, job: JobRecord): MissionLaneRecord {
	const approval = getApprovalManifest(job.worker_manifest);
	return {
		...lane,
		status: missionLaneStateFromJob(job),
		current_job_id: job.job_id,
		last_error: job.last_error ?? null,
		blocked_reason: approval?.pending ? approval.reason ?? null : null,
		last_event: job.notes.at(-1) ?? null,
		updated_at: nowIso(),
	};
}

export function missionCanAutoApprove(job: JobRecord): boolean {
	const approval = getApprovalManifest(job.worker_manifest);
	if (!approval?.pending) {
		return false;
	}
	const blockedAction = String(approval.blocked_action ?? '').toLowerCase();
	if (YOLO_BLOCKED_ACTION_DENYLIST.some((token) => blockedAction.includes(token))) {
		return false;
	}
	const approvedTools = Array.isArray(approval.bundle?.approved_tools)
		? approval.bundle?.approved_tools.map((value) => String(value).toLowerCase())
		: [];
	return !approvedTools.some((tool) => YOLO_BLOCKED_ACTION_DENYLIST.some((token) => tool.includes(token)));
}

export function reconcileMissionFromJobs(mission: MissionRecord, jobsById: Map<string, JobRecord>): MissionRecord {
	const nextMission: MissionRecord = {
		...mission,
		max_parallelism: normalizeMissionParallelism(mission.max_parallelism),
		lanes: mission.lanes.map((lane) => {
			if (!lane.current_job_id) {
				return {
					...lane,
					status: missionLaneDependenciesSatisfied(mission, lane) ? 'runnable' : 'queued',
					updated_at: lane.updated_at ?? nowIso(),
				};
			}
			const job = jobsById.get(lane.current_job_id);
			if (!job) {
				return { ...lane, status: 'detached', updated_at: nowIso() };
			}
			return missionLaneFromChildJob(lane, job);
		}),
		last_reconciled_at: nowIso(),
	};
	nextMission.detached_job_ids = Array.from(
		new Set(
			Array.from(jobsById.values())
				.filter((job) => job.mission_id === mission.mission_id)
				.filter(
					(job) =>
						!nextMission.lanes.some(
							(lane) => lane.current_job_id === job.job_id || lane.launched_job_ids.includes(job.job_id),
						),
				)
				.map((job) => job.job_id),
		),
	);
	nextMission.status = aggregateMissionStatus(nextMission);
	nextMission.updated_at = nowIso();
	return nextMission;
}
