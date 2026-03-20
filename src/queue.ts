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
	getDispatchDedupeWindowMs,
	getReviewStaleAfterMs,
	getWorkingStaleAfterMs,
	githubGet,
	githubPost,
	repoAllowed,
	buildDispatchFingerprint,
	nowIso,
	parseIsoMs,
	isOlderThan,
	jsonResponse,
	diagnosticLog,
	ok,
	fail
} from './utils';
import { githubAuthConfigured } from './github';
import {
	activeWorkspaceStorageKey,
	auditStorageKey,
	branchMatchScore,
	deliveryStorageKey,
	jobStorageKey,
	normalizeLookup,
	parseJobIdFromPrBody,
	verifyWebhookSignature,
	workspaceStorageKey,
} from './queue-helpers';
import { applyPullRequestEventToJob } from './queue-events';
import { findLatestWorkflowRunId, getWorkflowRunSnapshot } from './queue-github';
import { handleQueueAction } from './queue-requests';
import {
	buildJobIndexEntries,
	JobIndexPointer,
	jobBranchIndexKey,
	jobIndexReadyKey,
	jobRunIndexKey,
	jobStatusIndexPrefix,
} from './queue-index';
import {
	getWorkflowRunDiscoveryCandidate,
	isGitHubReconcileCandidate,
	shouldAttemptWorkingTimeoutRedispatch,
	shouldHandleReviewTimeout,
	shouldHandleWorkingTimeout,
} from './queue-reconcile';
import { getDispatchRequest, isDryRunJob, pushJobNote, recordWorkflowSnapshot, transitionJob } from './queue-state';
import { applyCompletedWorkflowRunDecision, decideCompletedWorkflowRun } from './queue-workflow';
import { findSimilarWorkspaceMatches, sortWorkspaces } from './queue-workspaces';

export class JobQueueDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	private async enforceAuditRetention(): Promise<void> {
		const limit = getAuditRetentionCount(this.env);
		const records = await this.ctx.storage.list({ prefix: 'audit:' });
		const overflow = records.size - limit;
		if (overflow <= 0) {
			return;
		}
		const keysToDelete: string[] = [];
		let index = 0;
		for (const key of records.keys()) {
			if (index >= overflow) {
				break;
			}
			keysToDelete.push(key);
			index += 1;
		}
		if (keysToDelete.length > 0) {
			await this.ctx.storage.delete(keysToDelete);
		}
	}

	private async enforceDeliveryRetention(): Promise<void> {
		const limit = getDeliveryRetentionCount(this.env);
		const records = await this.ctx.storage.list<DeliveryRecord>({ prefix: 'delivery:' });
		const deliveries = Array.from(records.entries())
			.map(([key, record]) => ({ key, created_at: record.created_at }))
			.sort((left, right) => left.created_at.localeCompare(right.created_at));
		const overflow = deliveries.length - limit;
		if (overflow <= 0) {
			return;
		}
		await this.ctx.storage.delete(deliveries.slice(0, overflow).map((item) => item.key));
	}

	private async writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
		await this.ctx.storage.put(auditStorageKey(`${Date.now()}-${crypto.randomUUID()}`), {
			event_type: eventType,
			payload,
			created_at: nowIso(),
		});
		await this.enforceAuditRetention();
	}

	private async getJob(jobId: string): Promise<JobRecord | null> {
		return ((await this.ctx.storage.get(jobStorageKey(jobId))) as JobRecord | undefined) ?? null;
	}

	private async ensureJobIndexes(): Promise<void> {
		const ready = await this.ctx.storage.get<boolean>(jobIndexReadyKey());
		if (ready) {
			return;
		}
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		for (const [, job] of records) {
			for (const [key, value] of buildJobIndexEntries(job)) {
				await this.ctx.storage.put(key, value);
			}
		}
		await this.ctx.storage.put(jobIndexReadyKey(), true);
	}

	private async persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void> {
		const previousEntries = new Map(previous ? buildJobIndexEntries(previous) : []);
		const nextEntries = new Map(buildJobIndexEntries(job));
		const keysToDelete: string[] = [];
		for (const key of previousEntries.keys()) {
			if (!nextEntries.has(key)) {
				keysToDelete.push(key);
			}
		}
		if (keysToDelete.length > 0) {
			await this.ctx.storage.delete(keysToDelete);
		}
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		for (const [key, value] of nextEntries.entries()) {
			await this.ctx.storage.put(key, value);
		}
	}

	private async getWorkspace(repoKey: string): Promise<WorkspaceRecord | null> {
		return ((await this.ctx.storage.get(workspaceStorageKey(repoKey))) as WorkspaceRecord | undefined) ?? null;
	}

	private async getActiveWorkspaceRepoKey(): Promise<string | null> {
		return ((await this.ctx.storage.get(activeWorkspaceStorageKey())) as string | undefined) ?? null;
	}

	private async listAuditRecords(eventType?: string, jobId?: string, limit = 20): Promise<AuditRecord[]> {
		const safeLimit = Math.max(1, Math.min(limit, 100));
		const filtered: AuditRecord[] = [];
		const records = await this.ctx.storage.list<AuditRecord>({ prefix: 'audit:' });
		
		for (const [, record] of records) {
			if (eventType && record.event_type !== eventType) {
				continue;
			}
			if (jobId && record.payload.job_id !== jobId) {
				continue;
			}
			filtered.push(record);
		}
		
		return filtered.slice(Math.max(0, filtered.length - safeLimit)).reverse();
	}

	private buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
		return {
			job_id: job.job_id,
			repo: job.repo,
			status: job.status,
			next_actor: job.next_actor,
			work_branch: job.work_branch ?? null,
			pr_number: job.pr_number ?? null,
			workflow_run_id: job.workflow_run_id ?? null,
			stale_reason: job.stale_reason ?? null,
			latest_note: job.notes.at(-1) ?? null,
			recent_notes: job.notes.slice(-5),
			recent_audits: recentAudits,
			last_transition_at: job.last_transition_at,
			last_reconciled_at: job.last_reconciled_at ?? null,
			last_webhook_event_at: job.last_webhook_event_at ?? null,
			updated_at: job.updated_at,
		};
	}

	private async findJob(
		matcher: (job: JobRecord) => boolean,
		options: { reconcile?: boolean } = {},
	): Promise<JobRecord | null> {
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		for (const [, value] of records) {
			if (!matcher(value)) {
				continue;
			}
			return options.reconcile === false ? value : this.reconcileJob(value);
		}
		return null;
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
		return {
			job_id: job.job_id,
			repo: job.repo,
			status: job.status,
			next_actor: job.next_actor,
			work_branch: job.work_branch ?? null,
			workflow_run_id: job.workflow_run_id ?? null,
			auto_improve_cycle: job.auto_improve_cycle,
			stale_reason: job.stale_reason ?? null,
			...extra,
		};
	}

	private async tryRegisterDelivery(deliveryId?: string): Promise<boolean> {
		if (!deliveryId) {
			return true;
		}
		const key = deliveryStorageKey(deliveryId);
		const existing = await this.ctx.storage.get<DeliveryRecord>(key);
		if (existing) {
			return false;
		}
		await this.ctx.storage.put(key, { delivery_id: deliveryId, created_at: nowIso() });
		await this.enforceDeliveryRetention();
		return true;
	}

	private async shouldDeduplicateDispatch(
		job: JobRecord,
		owner: string,
		repo: string,
		workflowId: string,
		ref: string,
		inputs: Record<string, unknown>,
	): Promise<boolean> {
		if (job.status !== 'working') {
			return false;
		}
		const dispatchRequest = getDispatchRequest(job);
		if (!dispatchRequest || !dispatchRequest.fingerprint) {
			return false;
		}
		const workflow = (job.worker_manifest.last_workflow_run ?? null) as
			| {
					status?: string;
			  }
			| null;
		if (workflow?.status === 'completed') {
			return false;
		}
		if (parseIsoMs(dispatchRequest.dispatched_at) === null) {
			return false;
		}
		if (isOlderThan(dispatchRequest.dispatched_at, getDispatchDedupeWindowMs(this.env))) {
			return false;
		}
		const requestedFingerprint = await buildDispatchFingerprint(
			owner,
			repo,
			workflowId,
			ref,
			inputs,
			job.auto_improve_cycle,
		);
		return dispatchRequest.fingerprint === requestedFingerprint;
	}

	private async autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean> {
		const dispatchRequest = getDispatchRequest(job);
		if (!dispatchRequest || !githubAuthConfigured(this.env)) {
			return false;
		}
		const fingerprint = await buildDispatchFingerprint(
			dispatchRequest.owner,
			dispatchRequest.repo,
			dispatchRequest.workflow_id,
			dispatchRequest.ref,
			dispatchRequest.inputs,
			job.auto_improve_cycle,
		);
		await githubPost(
			this.env,
			`/repos/${dispatchRequest.owner}/${dispatchRequest.repo}/actions/workflows/${dispatchRequest.workflow_id}/dispatches`,
			{
				ref: dispatchRequest.ref,
				inputs: dispatchRequest.inputs,
			},
		);
		transitionJob(job, 'working', 'system');
		job.workflow_run_id = undefined;
		job.last_error = undefined;
		job.stale_reason = undefined;
		pushJobNote(job, `auto redispatch triggered: ${reason}`);
		job.worker_manifest = {
			...job.worker_manifest,
			dispatch_request: {
				...dispatchRequest,
				fingerprint,
				dispatched_at: nowIso(),
			},
			last_workflow_run: {
				status: 'queued',
				conclusion: null,
				html_url: null,
			},
		};
		return true;
	}

	private async reconcileJob(job: JobRecord): Promise<JobRecord> {
		job.last_reconciled_at = nowIso();
		if (shouldHandleWorkingTimeout(job, getWorkingStaleAfterMs(this.env))) {
			const previous = structuredClone(job);
			const staleChanged = job.stale_reason !== 'working_timeout';
			job.stale_reason = 'working_timeout';
			if (githubAuthConfigured(this.env) && repoAllowed(this.env, job.repo)) {
				if (getDispatchRequest(job) && shouldAttemptWorkingTimeoutRedispatch(job)) {
					job.auto_improve_cycle += 1;
					const redispatched = await this.autoRedispatchJob(job, 'working job stale without workflow run');
					if (!redispatched) {
						transitionJob(job, 'rework_pending', 'worker');
					}
				} else {
					transitionJob(job, 'rework_pending', 'worker');
				}
			} else {
				transitionJob(job, 'rework_pending', 'worker');
			}
			job.updated_at = nowIso();
			await this.persistJob(job, previous);
			if (staleChanged) {
				await this.markJobStale(
					job,
					'working_timeout',
					'working job exceeded stale threshold without a linked workflow run',
				);
			}
			return job;
		}
		if (!githubAuthConfigured(this.env) || !repoAllowed(this.env, job.repo)) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		if (!isGitHubReconcileCandidate(job)) {
			return job;
		}
		const runCandidate = getWorkflowRunDiscoveryCandidate(job);
		if (!job.workflow_run_id && runCandidate) {
			try {
				const discoveredRun = await findLatestWorkflowRunId(
					this.env,
					runCandidate.owner,
					runCandidate.repo,
					runCandidate.workflow_id,
					runCandidate.ref,
					runCandidate.dispatched_at,
					1,
					0,
				);
				if (discoveredRun?.id) {
					job.workflow_run_id = discoveredRun.id;
				}
			} catch {
				return job;
			}
		}
		if (!job.workflow_run_id) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		let run;
		try {
			run = await getWorkflowRunSnapshot(this.env, job.repo, job.workflow_run_id);
		} catch {
			return job;
		}
		if (!run) {
			return job;
		}
		if (run.status === 'completed') {
			const previous = structuredClone(job);
			const decision = decideCompletedWorkflowRun(job, run, 'reconcile');
			applyCompletedWorkflowRunDecision(job, run, decision);
			if (decision.shouldAutoRedispatch) {
				job.auto_improve_cycle += 1;
				const redispatched = await this.autoRedispatchJob(
					job,
					decision.redispatchReason ?? 'github run reconciliation failure',
				);
				if (!redispatched) {
					transitionJob(job, 'rework_pending', 'worker');
				}
			}
			job.stale_reason = undefined;
			job.updated_at = nowIso();
			await this.persistJob(job, previous);
		} else {
			recordWorkflowSnapshot(job, run);
		}
		if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(this.env))) {
			await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
		}
		return job;
	}

	private async listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]> {
		const jobs: JobRecord[] = [];
		if (status || nextActor) {
			await this.ensureJobIndexes();
		}
		const indexedRecords =
			status || nextActor
				? await this.ctx.storage.list<JobIndexPointer>({ prefix: jobStatusIndexPrefix(status, nextActor) })
				: null;
		const records: Array<JobRecord | null> = [];
		if (indexedRecords?.size) {
			for (const pointer of indexedRecords.values()) {
				records.push(await this.getJob(pointer.job_id));
			}
		} else {
			records.push(...Array.from((await this.ctx.storage.list<JobRecord>({ prefix: 'job:' })).values()));
		}
		for (const value of records) {
			if (!value) {
				continue;
			}
			const reconciled = await this.reconcileJob(value);
			if (status && reconciled.status !== status) {
				continue;
			}
			if (nextActor && reconciled.next_actor !== nextActor) {
				continue;
			}
			jobs.push(reconciled);
		}
		return jobs.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
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

	private async findByRepoAndBranch(repo: string, workBranch?: string): Promise<JobRecord | null> {
		if (!workBranch) {
			return null;
		}
		await this.ensureJobIndexes();
		const indexedPointer = await this.ctx.storage.get<JobIndexPointer>(jobBranchIndexKey(repo, workBranch));
		if (indexedPointer?.job_id) {
			const indexedJob = await this.getJob(indexedPointer.job_id);
			if (indexedJob?.repo === repo) {
				return indexedJob;
			}
		}
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		let bestMatch: { job: JobRecord; score: number; matchedLength: number } | null = null;
		for (const [, job] of records) {
			if (job.repo !== repo) {
				continue;
			}
			const score = branchMatchScore(workBranch, job);
			if (score === 0) {
				continue;
			}
			const matchedLength = Math.max(job.work_branch?.length ?? 0, job.job_id.length);
			if (
				!bestMatch ||
				score > bestMatch.score ||
				(score === bestMatch.score && matchedLength > bestMatch.matchedLength)
			) {
				bestMatch = { job, score, matchedLength };
			}
		}
		return bestMatch?.job ?? null;
	}

	private async findByRepoAndRun(repo: string, runId?: number): Promise<JobRecord | null> {
		if (!runId) {
			return null;
		}
		await this.ensureJobIndexes();
		const indexedPointer = await this.ctx.storage.get<JobIndexPointer>(jobRunIndexKey(repo, runId));
		if (indexedPointer?.job_id) {
			const indexedJob = await this.getJob(indexedPointer.job_id);
			if (indexedJob?.repo === repo && indexedJob.workflow_run_id === runId) {
				return indexedJob;
			}
		}
		return this.findJob((job) => job.repo === repo && job.workflow_run_id === runId, { reconcile: false });
	}

	private async findByRepoAndJobId(repo: string, jobId?: string | null): Promise<JobRecord | null> {
		if (!jobId) {
			return null;
		}
		const job = await this.getJob(jobId);
		return job?.repo === repo ? job : null;
	}

	private normalizeJob(input: Partial<JobRecord> & { job_id: string }): JobRecord {
		const timestamp = nowIso();
		return {
			job_id: input.job_id,
			repo: input.repo ?? '',
			base_branch: input.base_branch ?? 'main',
			work_branch: input.work_branch,
			pr_number: input.pr_number,
			workflow_run_id: input.workflow_run_id,
			operation_type: input.operation_type,
			target_paths: input.target_paths ?? [],
			status: input.status ?? 'queued',
			next_actor: input.next_actor ?? 'worker',
			auto_improve_enabled: input.auto_improve_enabled ?? false,
			auto_improve_max_cycles: input.auto_improve_max_cycles ?? 3,
			auto_improve_cycle: 0,
			worker_manifest: input.worker_manifest ?? {},
			review_findings: [],
			notes: input.notes ?? [],
			last_error: input.last_error,
			created_at: input.created_at ?? timestamp,
			updated_at: timestamp,
			last_transition_at: timestamp,
			last_reconciled_at: undefined,
			last_webhook_event_at: undefined,
			stale_reason: undefined,
		};
	}

	private async upsertJob(job: Partial<JobRecord> & { job_id: string }): Promise<void> {
		const existing = await this.getJob(job.job_id);
		if (existing) {
			const merged = { ...existing, ...job, updated_at: nowIso() };
			await this.persistJob(merged, existing);
		} else {
			const newJob = this.normalizeJob(job);
			await this.persistJob(newJob);
		}
	}

	private async applyGithubEvent(payload: Record<string, unknown>, deliveryId: string): Promise<{
		matched: boolean;
		job_id?: string;
		status?: string;
		next_actor?: string;
		pr_number?: number;
		work_branch?: string;
		delivery_id?: string;
		duplicate?: boolean;
	}> {
		if (!payload.repository || typeof payload.repository !== 'object') {
			return { matched: false };
		}
		const repoFullName = (payload.repository as { full_name?: string }).full_name;
		if (!repoFullName) {
			return { matched: false };
		}
		if (payload.action === 'completed' && payload.workflow_run) {
			const run = payload.workflow_run as
				| {
						id?: number;
						head_branch?: string;
						name?: string;
						status?: string;
						conclusion?: string;
						html_url?: string;
				  }
				| null;
			if (!run?.id) {
				return { matched: false };
			}
			const job =
				(await this.findByRepoAndRun(repoFullName, run.id)) ??
				(await this.findByRepoAndBranch(repoFullName, run.head_branch));
			if (job) {
				const previous = structuredClone(job);
				job.last_webhook_event_at = nowIso();
				job.workflow_run_id = run.id;
				if (run.status === 'completed') {
					const decision = decideCompletedWorkflowRun(job, run, 'webhook');
					applyCompletedWorkflowRunDecision(job, run, decision);
					if (decision.shouldAutoRedispatch) {
						job.auto_improve_cycle += 1;
						const redispatched = await this.autoRedispatchJob(
							job,
							decision.redispatchReason ?? 'webhook reported failure',
						);
						if (!redispatched) {
							transitionJob(job, 'rework_pending', 'worker');
						}
					}
					job.stale_reason = undefined;
				} else {
					recordWorkflowSnapshot(job, run);
				}
				job.updated_at = nowIso();
				await this.persistJob(job, previous);
				return {
					matched: true,
					job_id: job.job_id,
					status: job.status,
					next_actor: job.next_actor,
				};
			}
		}
		if (payload.pull_request) {
			const pr = payload.pull_request as
				| {
						number?: number;
						head?: { ref?: string };
						body?: string;
						state?: string;
				  }
				| null;
			if (pr?.head?.ref) {
				const hintedJobId = parseJobIdFromPrBody(pr.body);
				const job =
					(await this.findByRepoAndJobId(repoFullName, hintedJobId)) ??
					(await this.findByRepoAndBranch(repoFullName, pr.head.ref));
				if (job) {
					const previous = structuredClone(job);
					applyPullRequestEventToJob(job, pr, nowIso());
					await this.persistJob(job, previous);
					return {
						matched: true,
						job_id: job.job_id,
						status: job.status,
						next_actor: job.next_actor,
						pr_number: job.pr_number,
						work_branch: job.work_branch,
					};
				}
			}
		}
		return { matched: false };
	}

	private async findSimilarWorkspaces(query?: string, repoKey?: string): Promise<ToolResultEnvelope> {
		const workspaces = await this.listWorkspaces();
		const matches = findSimilarWorkspaceMatches(workspaces, query, repoKey);
		return ok({ matches });
	}

	private async putWorkspace(workspace: WorkspaceRecord): Promise<void> {
		await this.ctx.storage.put(workspaceStorageKey(workspace.repo_key), workspace);
	}

	private async setActiveWorkspace(repoKey: string): Promise<void> {
		await this.ctx.storage.put(activeWorkspaceStorageKey(), repoKey);
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
						applyGithubEvent: this.applyGithubEvent.bind(this),
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
