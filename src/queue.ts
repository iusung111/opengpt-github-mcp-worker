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

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLatestWorkflowRunId(
	env: AppEnv,
	owner: string,
	repo: string,
	workflowId: string,
	ref: string,
	dispatchedAtIso: string,
	maxAttempts = 5,
	delayMs = 1000,
): Promise<
	| {
			id: number;
			created_at?: string;
			head_branch?: string;
			name?: string;
			status?: string;
			conclusion?: string;
			html_url?: string;
	  }
	| undefined
> {
	const dispatchedAt = Date.parse(dispatchedAtIso);
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const data = (await githubGet(
			env,
			`/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`,
			{ params: { branch: ref, event: 'workflow_dispatch', per_page: 10 } },
		)) as {
			workflow_runs?: Array<{
				id?: number;
				created_at?: string;
				head_branch?: string;
				name?: string;
				status?: string;
				conclusion?: string;
				html_url?: string;
			}>;
		};
		const run = (data.workflow_runs ?? []).find((item) => {
			if (!item.id || !item.created_at) {
				return false;
			}
			return Date.parse(item.created_at) >= dispatchedAt - 15_000;
		});
		if (run?.id) {
			return {
				id: run.id,
				created_at: run.created_at,
				head_branch: run.head_branch,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
			};
		}
		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}
	return undefined;
}

function jobStorageKey(jobId: string): string {
	return `job:${jobId}`;
}

function auditStorageKey(id: string): string {
	return `audit:${id}`;
}

function deliveryStorageKey(deliveryId: string): string {
	return `delivery:${deliveryId}`;
}

function workspaceStorageKey(repoKey: string): string {
	return `workspace:${repoKey.toLowerCase()}`;
}

function activeWorkspaceStorageKey(): string {
	return 'workspace:active_repo_key';
}

function normalizeLookup(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
}

function isAbsoluteWorkspacePath(path: string): boolean {
	return (
		path.startsWith('/') ||
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith('\\\\')
	);
}

function ensureSafeWorkspacePath(path: string): void {
	const normalized = String(path ?? '').trim();
	if (!normalized || !isAbsoluteWorkspacePath(normalized) || normalized.includes('..')) {
		throw new Error(`unsafe workspace path: ${path}`);
	}
}

async function sha256HmacHex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function verifyWebhookSignature(secret: string, payload: string, signatureHeader: string | null): Promise<boolean> {
	if (!secret) {
		return true;
	}
	if (!signatureHeader?.startsWith('sha256=')) {
		return false;
	}
	const expected = `sha256=${await sha256HmacHex(secret, payload)}`;
	return expected === signatureHeader;
}

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

	private transitionJob(job: JobRecord, status: JobStatus, nextActor: NextActor): void {
		if (job.status !== status || job.next_actor !== nextActor) {
			job.status = status;
			job.next_actor = nextActor;
			job.last_transition_at = nowIso();
		} else {
			job.status = status;
			job.next_actor = nextActor;
		}
	}

	private pushJobNote(job: JobRecord, note: string): void {
		if (!job.notes.includes(note)) {
			job.notes.push(note);
		}
	}

	private async markJobStale(job: JobRecord, reason: string, note: string): Promise<boolean> {
		if (job.stale_reason === reason) {
			return false;
		}
		job.stale_reason = reason;
		this.pushJobNote(job, note);
		job.updated_at = nowIso();
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
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

	private getDispatchRequest(job: JobRecord): DispatchRequestRecord | null {
		const raw = (job.worker_manifest.dispatch_request ?? null) as Partial<DispatchRequestRecord> | null;
		if (!raw?.owner || !raw.repo || !raw.workflow_id || !raw.ref || !raw.dispatched_at) {
			return null;
		}
		return {
			owner: raw.owner,
			repo: raw.repo,
			workflow_id: raw.workflow_id,
			ref: raw.ref,
			inputs: raw.inputs ?? {},
			fingerprint: raw.fingerprint,
			dispatched_at: raw.dispatched_at,
		};
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
		const dispatchRequest = this.getDispatchRequest(job);
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
		const dispatchRequest = this.getDispatchRequest(job);
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
		this.transitionJob(job, 'working', 'system');
		job.workflow_run_id = undefined;
		job.last_error = undefined;
		job.stale_reason = undefined;
		this.pushJobNote(job, `auto redispatch triggered: ${reason}`);
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
		if (job.status === 'working' && !job.workflow_run_id && isOlderThan(job.updated_at, getWorkingStaleAfterMs(this.env))) {
			const staleChanged = job.stale_reason !== 'working_timeout';
			job.stale_reason = 'working_timeout';
			if (githubAuthConfigured(this.env) && repoAllowed(this.env, job.repo)) {
				const dispatchRequest = this.getDispatchRequest(job);
				if (dispatchRequest && job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
					job.auto_improve_cycle += 1;
					const redispatched = await this.autoRedispatchJob(job, 'working job stale without workflow run');
					if (!redispatched) {
						this.transitionJob(job, 'rework_pending', 'worker');
					}
				} else {
					this.transitionJob(job, 'rework_pending', 'worker');
				}
			} else {
				this.transitionJob(job, 'rework_pending', 'worker');
			}
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
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
			if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		if (job.status !== 'working' && job.status !== 'review_pending') {
			return job;
		}
		const dispatchRequest = (job.worker_manifest.dispatch_request ?? null) as
			| {
					owner?: string;
					repo?: string;
					workflow_id?: string;
					ref?: string;
					dispatched_at?: string;
			  }
			| null;
		if (!job.workflow_run_id && dispatchRequest?.owner && dispatchRequest?.repo && dispatchRequest.workflow_id && dispatchRequest.ref && dispatchRequest.dispatched_at) {
			try {
				const discoveredRun = await findLatestWorkflowRunId(
					this.env,
					dispatchRequest.owner,
					dispatchRequest.repo,
					dispatchRequest.workflow_id,
					dispatchRequest.ref,
					dispatchRequest.dispatched_at,
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
			if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		let run:
			| {
					name?: string;
					status?: string;
					conclusion?: string;
					html_url?: string;
			  }
			| undefined;
		try {
			run = (await githubGet(
				this.env,
				`/repos/${job.repo}/actions/runs/${job.workflow_run_id}`,
			)) as {
				name?: string;
				status?: string;
				conclusion?: string;
				html_url?: string;
			};
		} catch {
			return job;
		}
		if (!run) {
			return job;
		}
		job.worker_manifest = {
			...job.worker_manifest,
			last_workflow_run: {
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
			},
		};
		if (run.status === 'completed') {
			if (run.conclusion === 'success') {
				this.transitionJob(job, 'review_pending', 'reviewer');
			} else if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
				job.auto_improve_cycle += 1;
				const redispatched = await this.autoRedispatchJob(job, 'webhook reported failure');
				if (!redispatched) {
					this.transitionJob(job, 'rework_pending', 'worker');
				}
			} else {
				this.transitionJob(job, 'failed', 'system');
				job.last_error = `${run.name ?? 'workflow'} concluded with ${run.conclusion ?? 'unknown'}`;
			}
			job.stale_reason = undefined;
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		}
		if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
			await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
		}
		return job;
	}

	private async listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]> {
		const jobs: JobRecord[] = [];
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		for (const [, value] of records) {
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
		
		const workspacesWithMeta = workspaces.map((workspace) => ({
			workspace,
			isActive: workspace.repo_key === activeRepoKey,
			usedMs: parseIsoMs(workspace.last_used_at) ?? 0,
			updatedMs: parseIsoMs(workspace.updated_at) ?? 0,
		}));
		
		return workspacesWithMeta
			.sort((left, right) => {
				if (left.isActive !== right.isActive) {
					return right.isActive ? 1 : -1;
				}
				if (left.usedMs !== right.usedMs) {
					return right.usedMs - left.usedMs;
				}
				if (left.updatedMs !== right.updatedMs) {
					return right.updatedMs - left.updatedMs;
				}
				return left.workspace.repo_key.localeCompare(right.workspace.repo_key);
			})
			.map((item) => ({
				...item.workspace,
				is_active: item.isActive,
			}));
	}

	private async findByRepoAndBranch(repo: string, workBranch?: string): Promise<JobRecord | null> {
		if (!workBranch) {
			return null;
		}
		return this.findJob((job) => {
				if (job.repo !== repo || !job.work_branch) {
					return false;
				}
				return (
					job.work_branch === workBranch ||
					workBranch.startsWith(`${job.work_branch}-`)
				);
			});
	}

	private async findByRepoAndRun(repo: string, runId?: number): Promise<JobRecord | null> {
		if (!runId) {
			return null;
		}
		return this.findJob((job) => job.repo === repo && job.workflow_run_id === runId);
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
			await this.ctx.storage.put(jobStorageKey(job.job_id), merged);
		} else {
			const newJob = this.normalizeJob(job);
			await this.ctx.storage.put(jobStorageKey(job.job_id), newJob);
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
				job.last_webhook_event_at = nowIso();
				job.workflow_run_id = run.id;
				if (run.conclusion === 'success') {
					this.transitionJob(job, 'review_pending', 'reviewer');
				} else if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
					job.auto_improve_cycle += 1;
					const redispatched = await this.autoRedispatchJob(job, 'webhook reported failure');
					if (!redispatched) {
						this.transitionJob(job, 'rework_pending', 'worker');
					}
				} else {
					this.transitionJob(job, 'failed', 'system');
					job.last_error = `${run.name ?? 'workflow'} failed (webhook)`;
				}
				job.updated_at = nowIso();
				await this.ctx.storage.put(jobStorageKey(job.job_id), job);
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
						state?: string;
				  }
				| null;
			if (pr?.head?.ref) {
				const job = await this.findByRepoAndBranch(repoFullName, pr.head.ref);
				if (job) {
					job.last_webhook_event_at = nowIso();
					if (pr.number && job.pr_number !== pr.number) {
						job.pr_number = pr.number;
						this.pushJobNote(job, `linked PR #${pr.number}`);
					}
					if (pr.head.ref !== job.work_branch) {
						job.work_branch = pr.head.ref;
					}
					job.updated_at = nowIso();
					await this.ctx.storage.put(jobStorageKey(job.job_id), job);
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
		const target = normalizeLookup(query || repoKey || '');
		const repoSlug = normalizeLookup((repoKey || '').split('/').pop() ?? '');
		const matches = workspaces
			.map((workspace) => {
				const candidates = [
					workspace.repo_key,
					workspace.repo_slug,
					workspace.display_name,
					workspace.workspace_path,
					...(workspace.aliases ?? []),
				].map(normalizeLookup);
				let score = 0;
				if (repoKey && candidates.includes(normalizeLookup(repoKey))) {
					score = 100;
				} else if (repoSlug && candidates.includes(repoSlug)) {
					score = 90;
				} else if (target && candidates.some((item) => item === target)) {
					score = 80;
				} else if (target && candidates.some((item) => item.includes(target))) {
					score = 50;
				}
				return { workspace, score };
			})
			.filter((match) => match.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((match) => match.workspace);
		return ok({ matches });
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/queue') {
			try {
				const payload = (await request.json()) as QueueEnvelope;
				switch (payload.action) {
					case 'job_create':
						if (payload.job && payload.job.job_id) {
							await this.upsertJob(payload.job as JobRecord);
							const job = await this.getJob(payload.job.job_id);
							if (job) {
								await this.writeAudit('job_create', this.buildJobAudit(job));
							}
							return jsonResponse(ok({ job }));
						}
						break;
					case 'job_upsert':
						if (payload.job && payload.job.job_id) {
							await this.upsertJob(payload.job as JobRecord);
							const job = await this.getJob(payload.job.job_id);
							return jsonResponse(ok({ job }));
						}
						break;
					case 'job_get':
						if (payload.job_id) {
							const job = await this.getJob(payload.job_id);
							if (!job) {
								return jsonResponse(fail('job_not_found', `job ${payload.job_id} not found`), 404);
							}
							const reconciled = await this.reconcileJob(job);
							return jsonResponse(ok({ job: reconciled }));
						}
						break;
					case 'jobs_list':
						const jobs = await this.listJobs(payload.status, payload.next_actor);
						return jsonResponse(ok({ jobs }));
					case 'job_update_status':
						if (payload.job_id && payload.status && payload.next_actor) {
							const job = await this.getJob(payload.job_id);
							if (!job) {
								return jsonResponse(fail('job_not_found', `job ${payload.job_id} not found`), 404);
							}
							this.transitionJob(job, payload.status, payload.next_actor);
							if (payload.job) {
								if (payload.job.work_branch !== undefined) job.work_branch = payload.job.work_branch;
								if (payload.job.workflow_run_id !== undefined) job.workflow_run_id = payload.job.workflow_run_id;
								if (payload.job.pr_number !== undefined) job.pr_number = payload.job.pr_number;
								if (payload.job.last_error !== undefined) job.last_error = payload.job.last_error;
								if (payload.job.worker_manifest !== undefined) {
									job.worker_manifest = { ...job.worker_manifest, ...payload.job.worker_manifest };
								}
								if (payload.job.auto_improve_cycle !== undefined) job.auto_improve_cycle = payload.job.auto_improve_cycle;
							}
							job.updated_at = nowIso();
							await this.ctx.storage.put(jobStorageKey(job.job_id), job);
							return jsonResponse(ok({ job }));
						}
						break;
					case 'job_append_note':
						if (payload.job_id && payload.note) {
							const job = await this.getJob(payload.job_id);
							if (!job) {
								return jsonResponse(fail('job_not_found', `job ${payload.job_id} not found`), 404);
							}
							this.pushJobNote(job, payload.note);
							job.updated_at = nowIso();
							await this.ctx.storage.put(jobStorageKey(job.job_id), job);
							await this.writeAudit('job_append_note', { job_id: job.job_id, note: payload.note });
							return jsonResponse(ok({ job }));
						}
						break;
					case 'job_submit_review':
						if (payload.job_id && payload.review_verdict) {
							const job = await this.getJob(payload.job_id);
							if (!job) {
								return jsonResponse(fail('job_not_found', `job ${payload.job_id} not found`), 404);
							}
							if (job.status !== 'review_pending' || job.next_actor !== 'reviewer') {
								return jsonResponse(
									fail('invalid_state', 'job is not waiting for reviewer input'),
									409,
								);
							}
							job.review_verdict = payload.review_verdict;
							job.review_findings = payload.findings ?? [];
							if (payload.review_verdict === 'blocked') {
								this.transitionJob(job, 'failed', 'system');
								job.last_error = `review blocked: ${payload.next_action}`;
							} else if (payload.review_verdict === 'approved') {
								this.transitionJob(job, 'done', 'system');
							} else {
								if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
									job.auto_improve_cycle += 1;
									this.transitionJob(job, 'rework_pending', 'worker');
								} else {
									this.transitionJob(job, 'failed', 'system');
									job.last_error = 'rework limit reached';
								}
							}
							job.updated_at = nowIso();
							await this.ctx.storage.put(jobStorageKey(job.job_id), job);
							await this.writeAudit('job_submit_review', {
								job_id: job.job_id,
								verdict: payload.review_verdict,
								findings: payload.findings,
							});
							return jsonResponse(ok({ job }));
						}
						break;
					case 'job_progress':
						if (payload.job_id) {
							const job = await this.getJob(payload.job_id);
							if (!job) {
								return jsonResponse(fail('job_not_found', `job ${payload.job_id} not found`), 404);
							}
							const audits = await this.listAuditRecords(undefined, payload.job_id, 5);
							return jsonResponse(
								ok({ progress: this.buildJobProgressSnapshot(job, audits) }),
							);
						}
						break;
					case 'workspace_register':
						if (payload.workspace) {
							const timestamp = nowIso();
							const existing = payload.workspace.repo_key
								? await this.getWorkspace(payload.workspace.repo_key)
								: null;
							const ws = {
								...(existing ?? {}),
								...(payload.workspace as WorkspaceRecord),
							} as WorkspaceRecord;
							ensureSafeWorkspacePath(ws.workspace_path);
							ws.created_at = existing?.created_at ?? timestamp;
							ws.updated_at = timestamp;
							ws.last_used_at = timestamp;
							ws.repo_slug = ws.repo_slug || normalizeLookup(ws.repo_key.split('/').pop());
							ws.display_name = ws.display_name || ws.repo_key;
							ws.aliases = ws.aliases ?? [];
							await this.ctx.storage.put(workspaceStorageKey(ws.repo_key), ws);
							await this.ctx.storage.put(activeWorkspaceStorageKey(), ws.repo_key);
							return jsonResponse(ok({ workspace: ws }));
						}
						break;
					case 'workspace_activate':
						if (payload.repo_key) {
							const existing = await this.getWorkspace(payload.repo_key);
							if (!existing) {
								return jsonResponse(fail('workspace_not_found', `workspace ${payload.repo_key} not found`), 404);
							}
							existing.last_used_at = nowIso();
							await this.ctx.storage.put(workspaceStorageKey(existing.repo_key), existing);
							await this.ctx.storage.put(activeWorkspaceStorageKey(), existing.repo_key);
							return jsonResponse(ok({ workspace: existing }));
						}
						break;
					case 'workspace_get':
						if (payload.repo_key) {
							const workspace = await this.getWorkspace(payload.repo_key);
							if (!workspace) {
								return jsonResponse(fail('workspace_not_found', `workspace ${payload.repo_key} not found`), 404);
							}
							return jsonResponse(ok({ workspace }));
						}
						break;
					case 'workspace_list':
						const workspaces = await this.listWorkspaces();
						return jsonResponse(
							ok({
								active_repo_key: await this.getActiveWorkspaceRepoKey(),
								workspaces,
							}),
						);
					case 'workspace_find_similar':
						return jsonResponse(await this.findSimilarWorkspaces(payload.query, payload.repo_key));
					case 'audit_list':
						const records = await this.listAuditRecords(
							payload.event_type,
							payload.job_id,
							payload.limit,
						);
						return jsonResponse(ok({ audits: records }));
					case 'github_event':
						if (payload.payload && typeof payload.payload === 'object') {
							const deliveryId = (payload.delivery_id ||
								request.headers.get('x-github-delivery') ||
								`delivery-${Date.now()}`) as string;
							const registered = await this.tryRegisterDelivery(deliveryId);
							if (!registered) {
								return jsonResponse(
									ok({
										outcome: {
											matched: false,
											duplicate: true,
											delivery_id: deliveryId,
										},
									}),
								);
							}
							const outcome = await this.applyGithubEvent(
								payload.payload as Record<string, unknown>,
								deliveryId,
							);
							await this.writeAudit('github_event_processed', {
								delivery_id: deliveryId,
								outcome,
							});
							return jsonResponse(ok({ outcome }));
						}
						break;
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
