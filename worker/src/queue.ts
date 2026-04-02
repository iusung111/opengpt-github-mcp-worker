import { DurableObject } from 'cloudflare:workers';
import {
	AppEnv,
	BROWSER_REMOTE_COMMAND_KINDS,
	BrowserRemoteCommandKind,
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
	githubPost,
	repoAllowed,
	nowIso,
	jsonResponse,
	diagnosticLog,
	ok,
	fail
} from './utils';
import { githubAuthConfigured } from './github';
import { mergeWorkerManifest } from './job-manifest';
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
import {
	buildJobAudit as buildQueueJobAudit,
	buildJobProgressSnapshot as buildQueueJobProgressSnapshot,
	computeRunAttentionStatus,
} from './queue-projections';
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
import {
	findSimilarWorkspaceMatches,
	normalizeWorkspaceRecord,
	sortWorkspaces,
	workspaceRecordNeedsNormalization,
} from './queue-workspaces';
import {
	claimBrowserRemoteCommand,
	completeBrowserRemoteCommand,
	disconnectBrowserRemoteSession,
	enqueueBrowserRemoteCommand,
	GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY,
	normalizeBrowserRemoteControl,
	upsertBrowserRemoteSession,
} from './browser-remote-control';

function parseBrowserCommandKind(value: unknown): BrowserRemoteCommandKind | null {
	if (typeof value !== 'string') {
		return null;
	}
	return BROWSER_REMOTE_COMMAND_KINDS.includes(value as BrowserRemoteCommandKind)
		? (value as BrowserRemoteCommandKind)
		: null;
}

function recordBody(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

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
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			control: {
				last_interrupt: {
					kind: 'stale_reconcile',
					source: 'queue',
					message: note,
					recorded_at: nowIso(),
				},
			},
		});
		job.updated_at = nowIso();
		await this.persistJob(job, previous);
		await this.writeAudit('job_reconcile_stale', this.buildJobAudit(job, { reason }));
		await this.writeAudit('job_interrupt_recorded', {
			job_id: job.job_id,
			repo: job.repo,
			interrupt_kind: 'stale_reconcile',
			source_layer: 'system',
			attention_status: 'interrupted',
			message: note,
		});
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

	private async cancelWorkflowRun(
		job: JobRecord,
	): Promise<{ attempted: boolean; cancelled: boolean; error: string | null }> {
		if (!job.workflow_run_id || !githubAuthConfigured(this.env) || !repoAllowed(this.env, job.repo)) {
			return { attempted: false, cancelled: false, error: null };
		}
		const [owner, repo] = job.repo.split('/');
		if (!owner || !repo) {
			return { attempted: false, cancelled: false, error: 'invalid repo key' };
		}
		try {
			await githubPost(this.env, `/repos/${owner}/${repo}/actions/runs/${job.workflow_run_id}/cancel`);
			return { attempted: true, cancelled: true, error: null };
		} catch (error) {
			return {
				attempted: true,
				cancelled: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
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
			const normalized = normalizeWorkspaceRecord(value);
			workspaces.push(normalized);
			if (workspaceRecordNeedsNormalization(value)) {
				await this.putWorkspace(normalized);
			}
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

	private async getBrowserRemoteControlState() {
		return normalizeBrowserRemoteControl(await this.getStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY));
	}

	private async persistBrowserRemoteControlState(value: unknown) {
		const normalized = normalizeBrowserRemoteControl(value);
		if (!normalized) {
			await this.deleteStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY);
			return null;
		}
		await this.putStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY, normalized);
		return normalized;
	}

	private async handleBrowserControlRequest(request: Request, url: URL): Promise<Response> {
		const parts = url.pathname.split('/').filter(Boolean);
		if (parts.length === 1 && request.method === 'GET') {
			return jsonResponse(ok({ browser_control: await this.getBrowserRemoteControlState() }));
		}
		if (parts.length === 2 && parts[1] === 'session' && request.method === 'POST') {
			const body = recordBody(await request.json().catch(() => null));
			if (!body) {
				return jsonResponse(fail('bad_request', 'invalid json body'), 400);
			}
			const nextState = upsertBrowserRemoteSession(await this.getBrowserRemoteControlState(), {
				session_id: typeof body.session_id === 'string' ? body.session_id : null,
				agent_name: typeof body.agent_name === 'string' ? body.agent_name : null,
				page_url: typeof body.page_url === 'string' ? body.page_url : null,
				page_title: typeof body.page_title === 'string' ? body.page_title : null,
				browser_name: typeof body.browser_name === 'string' ? body.browser_name : null,
				cdp_origin: typeof body.cdp_origin === 'string' ? body.cdp_origin : null,
			});
			return jsonResponse(ok({ browser_control: await this.persistBrowserRemoteControlState(nextState) }));
		}
		if (parts.length === 3 && parts[1] === 'session' && parts[2] === 'disconnect' && request.method === 'POST') {
			const nextState = disconnectBrowserRemoteSession(await this.getBrowserRemoteControlState());
			return jsonResponse(ok({ browser_control: await this.persistBrowserRemoteControlState(nextState) }));
		}
		if (parts.length === 2 && parts[1] === 'commands' && request.method === 'POST') {
			const body = recordBody(await request.json().catch(() => null));
			if (!body) {
				return jsonResponse(fail('bad_request', 'invalid json body'), 400);
			}
			const kind = parseBrowserCommandKind(body.kind);
			if (!kind) {
				return jsonResponse(
					fail('bad_request', `kind must be one of ${BROWSER_REMOTE_COMMAND_KINDS.join(', ')}`),
					400,
				);
			}
			const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
			if (!jobId) {
				return jsonResponse(fail('bad_request', 'job_id is required'), 400);
			}
			const job = await this.getJob(jobId);
			if (!job) {
				return jsonResponse(fail('job_not_found', `job ${jobId} not found`), 404);
			}
			let nextState;
			try {
				nextState = enqueueBrowserRemoteCommand(await this.getBrowserRemoteControlState(), {
					kind,
					job_id: jobId,
					job_title: typeof body.job_title === 'string' ? body.job_title : job.job_id,
					repo: typeof body.repo === 'string' ? body.repo : job.repo,
					run_status: computeRunAttentionStatus(job),
					label: typeof body.label === 'string' ? body.label : null,
					prompt: typeof body.prompt === 'string' ? body.prompt : null,
					page_url_hint: typeof body.page_url_hint === 'string' ? body.page_url_hint : null,
					created_by: typeof body.created_by === 'string' ? body.created_by : null,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonResponse(fail('browser_control_enqueue_failed', message), 409);
			}
			await this.writeAudit('browser_control_command_enqueued', {
				job_id: job.job_id,
				repo: job.repo,
				command_kind: kind,
				command_label: typeof body.label === 'string' ? body.label : null,
				created_by: typeof body.created_by === 'string' ? body.created_by : null,
				source_layer: 'gpt',
				attention_status: computeRunAttentionStatus(job),
				message: `Browser companion queued ${kind} for the run console.`,
			});
			return jsonResponse(ok({ browser_control: await this.persistBrowserRemoteControlState(nextState) }));
		}
		if (parts.length === 3 && parts[1] === 'commands' && parts[2] === 'next' && request.method === 'GET') {
			const sessionId = url.searchParams.get('session_id')?.trim();
			if (!sessionId) {
				return jsonResponse(fail('bad_request', 'session_id is required'), 400);
			}
			const jobIdFilter = url.searchParams.get('job_id')?.trim() || null;
			const currentState = await this.getBrowserRemoteControlState();
			const currentCommand = currentState?.pending_command ?? null;
			if (jobIdFilter && currentCommand?.job_id && currentCommand.job_id !== jobIdFilter) {
				return jsonResponse(ok({ browser_control: currentState, command: null }));
			}
			const claimed = claimBrowserRemoteCommand(currentState, { session_id: sessionId });
			const browserControl = await this.persistBrowserRemoteControlState(claimed.control);
			return jsonResponse(ok({ browser_control: browserControl, command: claimed.command }));
		}
		if (parts.length === 4 && parts[1] === 'commands' && parts[3] === 'complete' && request.method === 'POST') {
			const commandId = decodeURIComponent(parts[2] ?? '').trim();
			if (!commandId) {
				return jsonResponse(fail('bad_request', 'command_id is required'), 400);
			}
			const body = recordBody(await request.json().catch(() => null));
			if (!body) {
				return jsonResponse(fail('bad_request', 'invalid json body'), 400);
			}
			const currentState = await this.getBrowserRemoteControlState();
			const pendingCommand = currentState?.pending_command ?? null;
			let nextState;
			try {
				nextState = completeBrowserRemoteCommand(currentState, {
					command_id: commandId,
					ok: body.ok === true,
					summary: typeof body.summary === 'string' ? body.summary : null,
					error: typeof body.error === 'string' ? body.error : null,
					matched_actions: Array.isArray(body.matched_actions) ? body.matched_actions.map((item) => String(item)) : [],
					page_url: typeof body.page_url === 'string' ? body.page_url : null,
					page_title: typeof body.page_title === 'string' ? body.page_title : null,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonResponse(fail('browser_control_complete_failed', message), 409);
			}
			const browserControl = await this.persistBrowserRemoteControlState(nextState);
			if (pendingCommand?.job_id) {
				const job = await this.getJob(pendingCommand.job_id);
				await this.writeAudit('browser_control_command_completed', {
					job_id: pendingCommand.job_id,
					repo: pendingCommand.repo ?? job?.repo ?? null,
					command_kind: pendingCommand.kind,
					command_label: pendingCommand.label ?? null,
					ok: body.ok === true,
					summary: typeof body.summary === 'string' ? body.summary : null,
					error: typeof body.error === 'string' ? body.error : null,
					matched_actions: Array.isArray(body.matched_actions) ? body.matched_actions.map((item) => String(item)) : [],
					page_url: typeof body.page_url === 'string' ? body.page_url : null,
					page_title: typeof body.page_title === 'string' ? body.page_title : null,
					source_layer: 'gpt',
					attention_status: job ? computeRunAttentionStatus(job) : pendingCommand.run_status ?? null,
					message:
						body.ok === true
							? `Browser companion completed ${pendingCommand.kind}.`
							: typeof body.error === 'string'
								? body.error
								: `Browser companion failed ${pendingCommand.kind}.`,
				});
			}
			return jsonResponse(ok({ browser_control: browserControl }));
		}
		return jsonResponse(fail('not_found', 'not found'), 404);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/browser-control' || url.pathname.startsWith('/browser-control/')) {
			try {
				return await this.handleBrowserControlRequest(request, url);
			} catch (error) {
				return jsonResponse(
					fail('browser_control_error', error instanceof Error ? error.message : String(error)),
					500,
				);
			}
		}
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
						autoRedispatchJob: this.autoRedispatchJob.bind(this),
						cancelWorkflowRun: this.cancelWorkflowRun.bind(this),
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
