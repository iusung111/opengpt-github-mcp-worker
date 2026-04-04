import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
	AppEnv,
	JobRecord,
	MissionRecord,
} from '../contracts';
import {
	nowIso,
} from '../utils';
import { mergeWorkerManifest } from '../job-manifest';
import { autoRedispatchJob as autoRedispatchQueueJob } from '../queue-dispatch';
import {
	findJob as findStoredJob,
} from '../queue-store';
import { applyGithubEvent as applyGitHubWebhookEvent } from '../queue-webhooks';
import {
	JobIndexPointer,
} from '../queue-index';
import { computeRunAttentionStatus } from '../queue-projections';
import { scheduleMission } from './missions/scheduler';
import { createQueueStoreContext } from './durable-object-storage';
import { createJobActions } from './durable-object-job-actions';
import { createMissionActions } from './durable-object-mission-actions';
import { createWorkspaceActions } from './durable-object-workspace-actions';

export function createQueueActions(
	ctx: DurableObjectState,
	env: AppEnv,
	helpers: any,
	reconcile: { reconcileJob: (job: JobRecord) => Promise<JobRecord> }
) {
	// 1. Initialize action groups with circular-safe getters for reconcile functions
	const jobActions = createJobActions(ctx, env, helpers, () => reconcile.reconcileJob);
	
	const workspaceActions = createWorkspaceActions(ctx, env, helpers, () => reconcile.reconcileJob);

	const missionActions = createMissionActions(
		ctx, 
		helpers, 
		{
			getJob: jobActions.getJob,
			reconcileJob: reconcile.reconcileJob,
			ensureJobIndexes: jobActions.ensureJobIndexes,
			listAuditRecords: workspaceActions.listAuditRecords,
			buildJobProgressSnapshot: jobActions.buildJobProgressSnapshot,
		},
		() => reconcileMission
	);

	// 2. Define reconcileMission (needs job and audit actions)
	const reconcileMission = async (mission: MissionRecord): Promise<MissionRecord> => {
		return scheduleMission(
			{
				getJob: jobActions.getJob,
				listMissionJobs: missionActions.listMissionJobs,
				upsertJob: jobActions.upsertJob,
				persistMission: missionActions.persistMission,
				writeAudit: workspaceActions.writeAudit,
				autoApproveJob: async (job, note) => {
					const approval = job.worker_manifest?.attention?.approval;
					if (!approval?.request_id) return job;
					const previous = structuredClone(job);
					const resolvedAt = nowIso();
					job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
						attention: {
							approval: { ...approval, pending: false, status: 'approved', note, resolved_at: resolvedAt, cleared_at: resolvedAt },
						},
						control: { state: 'active', reason: null, resolved_at: resolvedAt, last_interrupt: null },
					});
					job.updated_at = resolvedAt;
					await jobActions.persistJob(job, previous);
					await workspaceActions.writeAudit('permission_request_resolved', {
						job_id: job.job_id,
						repo: job.repo,
						request_id: approval.request_id,
						resolution: 'approved',
						note,
						blocked_action: approval.blocked_action ?? null,
						source_layer: 'gpt',
						attention_status: computeRunAttentionStatus(job),
						message: note,
					});
					return job;
				},
			},
			mission,
		);
	};

	// 3. Return combined actions
	return {
		...jobActions,
		...missionActions,
		...workspaceActions,
		reconcileMission,
		autoRedispatchJob: (job: JobRecord, reason: string) => autoRedispatchQueueJob({ env }, job, reason),
		applyGithubEvent: (payload: Record<string, unknown>, _deliveryId: string) =>
			applyGitHubWebhookEvent(
				{
					ensureJobIndexes: jobActions.ensureJobIndexes,
					getJob: jobActions.getJob,
					findJob: (matcher, options) => findStoredJob(createQueueStoreContext(helpers, reconcile.reconcileJob), matcher, options),
					storageGetIndex: helpers.getStorageValue,
					listJobIndexPointers: async (prefix) =>
						Array.from((await ctx.storage.list<JobIndexPointer>({ prefix })).values()),
					persistJob: jobActions.persistJob,
					autoRedispatchJob: (job: JobRecord, reason: string) => autoRedispatchQueueJob({ env }, job, reason),
				},
				payload,
			),
	};
}
