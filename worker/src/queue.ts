import { DurableObject } from 'cloudflare:workers';
import {
	AppEnv,
	JobRecord,
	JobStatus,
	NextActor,
	QueueEnvelope,
	WorkspaceRecord,
	AuditRecord,
	DeliveryRecord,
	JobProgressSnapshot,
	DispatchRequestRecord,
	ToolResultEnvelope
} from './types';
import {
	getAuditRetentionCount,
	getDeliveryRetentionCount,
	getReviewStaleAfterMs,
	getWorkingStaleAfterMs,
	githubGet,
	repoAllowed,
	nowIso,
	jsonResponse,
	diagnosticLog,
	ok,
	fail
} from './utils';
import { githubAuthConfigured } from './github';
import { autoRedispatchJob as autoRedispatchQueueJob } from './queue-dispatch';
import {
	enforceAuditRetention as enforceQueueAuditRetention,
	enforceDeliveryRetention as enforceQueueDeliveryRetention,
	listAuditRecords as listQueueAuditRecords,
	tryRegisterDelivery as tryRegisterQueueDelivery,
	writeAudit as writeQueueAudit,
} from './queue-audit';
import {
	activeWorkspaceStorageKey,
	jobStorageKey,
	normalizeLookup,
	verifyWebhookSignature,
	workspaceStorageKey,
} from './queue-helpers';
import { findLatestWorkflowRunId, getWorkflowRunSnapshot } from './queue-github';
import { listJobs as listQueueJobs, upsertJob as upsertQueueJob } from './queue-jobs';
import { buildJobAudit as buildQueueJobAudit, buildJobProgressSnapshot as buildQueueJobProgressSnapshot } from './queue-projections';
import { handleQueueAction } from './queue-requests';
import {
	ensureJobIndexes as ensureQueueJobIndexes,
	findJob as findStoredJob,
	getActiveWorkspaceRepoKey as getActiveWorkspaceKey,
	getJob as getStoredJob,
	getWorkspace as getStoredWorkspace,
	persistJob as persistStoredJob,
} from './queue-store';
import { applyGithubEvent as applyGitHubWebhookEvent } from './queue-webhooks';
import {
	buildJobIndexEntries,
	jobIndexReadyKey,
	JobIndexPointer,
} from './queue-index';
import { incrementReadCounter } from './read-observability';
import {
	handleWorkingTimeoutReconcile,
	reconcileGitHubRunState,
	shouldHandleReviewTimeout,
} from './queue-reconcile';
import { getDispatchRequest, isDryRunJob, pushJobNote, transitionJob } from './queue-state';
import { findSimilarWorkspaceMatches, sortWorkspaces } from './queue-workspaces';

export class JobQueueDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	private async getStorageValue<T>(key: string): Promise<T | null> {
		return (await this.ctx.storage.get<T>(key)) ?? null;
	}

	private async putStorageValue(key: string, value: unknown): Promise<void> {
		await this.ctx.storage.put(key, value);
	}

	private async deleteStorageValue(keys: string[] | string): Promise<void> {
		if (Array.isArray(keys)) {
			await this.ctx.storage.delete(keys);
			return;
		}
		await this.ctx.storage.delete(keys);
	}

	private async listStoredJobs(): Promise<JobRecord[]> {
		incrementReadCounter('queue_storage_list_call');
		return Array.from((await this.ctx.storage.list<JobRecord>({ prefix: 'job:' })).values());
	}

	private async listStoredAudits(): Promise<Map<string, AuditRecord>> {
		incrementReadCounter('queue_storage_list_call');
		return this.ctx.storage.list<AuditRecord>({ prefix: 'audit:' });
	}

	private async listStoredDeliveries(): Promise<Map<string, DeliveryRecord>> {
		incrementReadCounter('queue_storage_list_call');
		return this.ctx.storage.list<DeliveryRecord>({ prefix: 'delivery:' });
	}

	private createQueueAuditContext() {
		return {
			getAuditRetentionCount: () => getAuditRetentionCount(this.env),
			getDeliveryRetentionCount: () => getDeliveryRetentionCount(this.env),
			listAuditStorage: this.listStoredAudits.bind(this),
			listDeliveryStorage: this.listStoredDeliveries.bind(this),
			putStorage: this.putStorageValue.bind(this),
			deleteStorage: this.deleteStorageValue.bind(this),
		};
	}

	private createQueueStoreContext() {
		return {
			getStorage: this.getStorageValue.bind(this),
			putStorage: this.putStorageValue.bind(this),
			deleteStorage: this.deleteStorageValue.bind(this),
			listJobs: this.listStoredJobs.bind(this),
			reconcileJob: this.reconcileJob.bind(this),
		};
	}

	private async enforceAuditRetention(): Promise<void> {
		await enforceQueueAuditRetention(this.createQueueAuditContext());
	}

	private async enforceDeliveryRetention(): Promise<void> {
		await enforceQueueDeliveryRetention(this.createQueueAuditContext());
	}

	private async writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
		await writeQueueAudit(this.createQueueAuditContext(), eventType, payload);
	}

	private async getJob(jobId: string): Promise<JobRecord | null> {
		return getStoredJob(this.createQueueStoreContext(), jobId);
	}

	private async ensureJobIndexes(): Promise<void> {
		await ensureQueueJobIndexes(this.createQueueStoreContext());
	}

	private async persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void> {
		await persistStoredJob(this.createQueueStoreContext(), job, previous);
	}

	private async getWorkspace(repoKey: string): Promise<WorkspaceRecord | null> {
		return getStoredWorkspace(this.createQueueStoreContext(), repoKey);
	}

	private async getActiveWorkspaceRepoKey(): Promise<string | null> {
		return getActiveWorkspaceKey(this.createQueueStoreContext());
	}

	private async listAuditRecords(eventType?: string, jobId?: string, limit = 20): Promise<AuditRecord[]> {
		return listQueueAuditRecords(this.createQueueAuditContext(), eventType, jobId, limit);
	}

	private buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
		return buildQueueJobProgressSnapshot(job, recentAudits);
	}

	private async findJob(
		matcher: (job: JobRecord) => boolean,
		options: { reconcile?: boolean } = {},
	): Promise<JobRecord | null> {
		return findStoredJob(this.createQueueStoreContext(), matcher, options);
	}

	private async markJobStale(job: JobRecord, reason: string, note: string): Promise<boolean> {
		if (job.stale_reason === reason) {
			return false;
		}
		const previous = structuredClone(job);
		job.stale_reason = reason;
		pushJobNote(job, note);
		job.updated_at = nowIso();
		await this.persistJob(job, previous);
		await this.writeAudit('job_reconcile_stale', this.buildJobAudit(job, { reason }));
		return true;
	}

	private buildJobAudit(job: JobRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
		return buildQueueJobAudit(job, extra);
	}

	private async tryRegisterDelivery(deliveryId?: string): Promise<boolean> {
		return tryRegisterQueueDelivery(this.createQueueAuditContext(), deliveryId);
	}

	private async autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean> {
		return autoRedispatchQueueJob({ env: this.env }, job, reason);
	}

	private async reconcileJob(job: JobRecord): Promise<JobRecord> {
		job.last_reconciled_at = nowIso();
		if (
			await handleWorkingTimeoutReconcile(
				{
					env: this.env,
					persistJob: this.persistJob.bind(this),
					markJobStale: this.markJobStale.bind(this),
					autoRedispatchJob: this.autoRedispatchJob.bind(this),
				},
				job,
				getWorkingStaleAfterMs(this.env),
			)
		) {
			return job;
		}
		if (!githubAuthConfigured(this.env) || !repoAllowed(this.env, job.repo)) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		await reconcileGitHubRunState(
			{
				env: this.env,
				persistJob: this.persistJob.bind(this),
				markJobStale: this.markJobStale.bind(this),
				autoRedispatchJob: this.autoRedispatchJob.bind(this),
			},
			job,
		);
		if (!job.workflow_run_id) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
			await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
		}
		return job;
	}

	private async listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]> {
		return listQueueJobs(
			{
				ensureJobIndexes: this.ensureJobIndexes.bind(this),
				getJob: this.getJob.bind(this),
				reconcileJob: this.reconcileJob.bind(this),
				listJobIndexPointers: async (prefix) =>
					Array.from((await this.ctx.storage.list<JobIndexPointer>({ prefix })).values()),
			},
			status,
			nextActor,
		);
	}

	private async listWorkspaces(): Promise<Array<WorkspaceRecord & { is_active?: boolean }>> {
		const workspaces: WorkspaceRecord[] = [];
		const records = await this.ctx.storage.list<WorkspaceRecord>({ prefix: 'workspace:' });
		for (const [, value] of records) {
			if (!value || typeof value !== 'object' || !('repo_key' in value) || !('workspace_path' in value)) {
				continue;
			}
			workspaces.push(value);
		}
		const activeRepoKey = await this.getActiveWorkspaceRepoKey();

		return sortWorkspaces(workspaces, activeRepoKey);
	}

	private async upsertJob(job: Partial<JobRecord> & { job_id: string }): Promise<void> {
		await upsertQueueJob(
			{
				getJob: this.getJob.bind(this),
				persistJob: this.persistJob.bind(this),
			},
			job,
		);
	}

	private async findSimilarWorkspaces(query?: string, repoKey?: string): Promise<ToolResultEnvelope> {
		const workspaces = await this.listWorkspaces();
		const matches = findSimilarWorkspaceMatches(workspaces, query, repoKey);
		return ok({ matches });
	}

	private async putWorkspace(workspace: WorkspaceRecord): Promise<void> {
		await this.putStorageValue(workspaceStorageKey(workspace.repo_key), workspace);
	}

	private async setActiveWorkspace(repoKey: string): Promise<void> {
		await this.putStorageValue(activeWorkspaceStorageKey(), repoKey);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/queue') {
			try {
				const payload = (await request.json()) as QueueEnvelope;
				const response = await handleQueueAction(
					{
						upsertJob: this.upsertJob.bind(this),
						getJob: this.getJob.bind(this),
						reconcileJob: this.reconcileJob.bind(this),
						persistJob: this.persistJob.bind(this),
						writeAudit: this.writeAudit.bind(this),
						buildJobAudit: this.buildJobAudit.bind(this),
						buildJobProgressSnapshot: this.buildJobProgressSnapshot.bind(this),
						listAuditRecords: this.listAuditRecords.bind(this),
						listJobs: this.listJobs.bind(this),
						getWorkspace: this.getWorkspace.bind(this),
						listWorkspaces: this.listWorkspaces.bind(this),
						getActiveWorkspaceRepoKey: this.getActiveWorkspaceRepoKey.bind(this),
						findSimilarWorkspaces: this.findSimilarWorkspaces.bind(this),
						tryRegisterDelivery: this.tryRegisterDelivery.bind(this),
						applyGithubEvent: (payload, _deliveryId) =>
							applyGitHubWebhookEvent(
								{
									ensureJobIndexes: this.ensureJobIndexes.bind(this),
									getJob: this.getJob.bind(this),
									findJob: this.findJob.bind(this),
									storageGetIndex: this.getStorageValue.bind(this),
									listJobIndexPointers: async (prefix) =>
										Array.from((await this.ctx.storage.list<JobIndexPointer>({ prefix })).values()),
									persistJob: this.persistJob.bind(this),
									autoRedispatchJob: this.autoRedispatchJob.bind(this),
								},
								payload,
							),
						putWorkspace: this.putWorkspace.bind(this),
						setActiveWorkspace: this.setActiveWorkspace.bind(this),
					},
					payload,
					request,
				);
				if (response) {
					return response;
				}
				return jsonResponse(fail('invalid_action', 'unknown action or missing parameters'), 400);
			} catch (error) {
				return jsonResponse(
					fail('queue_error', error instanceof Error ? error.message : String(error)),
					500,
				);
			}
		}
		return jsonResponse(fail('not_found', 'not found'), 404);
	}
}
