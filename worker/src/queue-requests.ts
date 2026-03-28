import {
	AuditRecord,
	JobEventFeed,
	JobProgressSnapshot,
	JobRecord,
	JobStatus,
	NextActor,
	QueueEnvelope,
	ToolResultEnvelope,
	WorkspaceRecord,
} from './types';
import { mergeWorkerManifest } from './job-manifest';
import { buildBlockingState, buildJobEventFeed, buildRunSummary, computeRunAttentionStatus } from './queue-projections';
import { jsonResponse, fail, ok, nowIso } from './utils';
import { buildWorkspaceRecord } from './queue-workspaces';
import { ensureSafeWorkspacePath } from './queue-helpers';
import { pushJobNote, transitionJob } from './queue-state';

type QueueResponse = Response;

export interface QueueRequestContext {
	upsertJob(job: Partial<JobRecord> & { job_id: string }): Promise<void>;
	getJob(jobId: string): Promise<JobRecord | null>;
	reconcileJob(job: JobRecord): Promise<JobRecord>;
	persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void>;
	writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void>;
	buildJobAudit(job: JobRecord, extra?: Record<string, unknown>): Record<string, unknown>;
	buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot;
	listAuditRecords(eventType?: string, jobId?: string, limit?: number): Promise<AuditRecord[]>;
	listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]>;
	getWorkspace(repoKey: string): Promise<WorkspaceRecord | null>;
	listWorkspaces(): Promise<Array<WorkspaceRecord & { is_active?: boolean }>>;
	getActiveWorkspaceRepoKey(): Promise<string | null>;
	findSimilarWorkspaces(query?: string, repoKey?: string): Promise<ToolResultEnvelope>;
	tryRegisterDelivery(deliveryId?: string): Promise<boolean>;
	applyGithubEvent(
		payload: Record<string, unknown>,
		deliveryId: string,
	): Promise<{
		matched: boolean;
		job_id?: string;
		status?: string;
		next_actor?: string;
		pr_number?: number;
		work_branch?: string;
		delivery_id?: string;
		duplicate?: boolean;
	}>;
	putWorkspace(workspace: WorkspaceRecord): Promise<void>;
	setActiveWorkspace(repoKey: string): Promise<void>;
}

function jobNotFound(jobId: string): QueueResponse {
	return jsonResponse(fail('job_not_found', `job ${jobId} not found`), 404);
}

function workspaceNotFound(repoKey: string): QueueResponse {
	return jsonResponse(fail('workspace_not_found', `workspace ${repoKey} not found`), 404);
}

export async function handleQueueAction(
	context: QueueRequestContext,
	payload: QueueEnvelope,
	request: Request,
): Promise<QueueResponse | null> {
	switch (payload.action) {
		case 'job_create':
			if (!payload.job?.job_id) {
				return null;
			}
			await context.upsertJob(payload.job as JobRecord);
			return handleCreatedJob(context, payload.job.job_id);
		case 'job_upsert':
			if (!payload.job?.job_id) {
				return null;
			}
			await context.upsertJob(payload.job as JobRecord);
			return handleLoadedJob(context, payload.job.job_id);
		case 'job_get':
			if (!payload.job_id) {
				return null;
			}
			return handleLoadedJob(context, payload.job_id, true);
		case 'jobs_list':
			return handleJobsList(context, payload);
		case 'job_update_status':
			if (!payload.job_id || !payload.status || !payload.next_actor) {
				return null;
			}
			return handleJobStatusUpdate(context, payload);
		case 'job_append_note':
			if (!payload.job_id || !payload.note) {
				return null;
			}
			return handleJobAppendNote(context, payload.job_id, payload.note);
		case 'job_submit_review':
			if (!payload.job_id || !payload.review_verdict) {
				return null;
			}
			return handleJobSubmitReview(context, payload);
		case 'job_progress':
			if (!payload.job_id) {
				return null;
			}
			return handleJobProgress(context, payload.job_id);
		case 'job_event_feed':
			return handleJobEventFeed(context, payload);
		case 'workspace_register':
			if (!payload.workspace) {
				return null;
			}
			return handleWorkspaceRegister(context, payload.workspace);
		case 'workspace_activate':
			if (!payload.repo_key) {
				return null;
			}
			return handleWorkspaceActivate(context, payload.repo_key);
		case 'workspace_get':
			if (!payload.repo_key) {
				return null;
			}
			return handleWorkspaceGet(context, payload.repo_key);
		case 'workspace_list':
			return jsonResponse(
				ok({
					active_repo_key: await context.getActiveWorkspaceRepoKey(),
					workspaces: await context.listWorkspaces(),
				}),
			);
		case 'workspace_find_similar':
			return jsonResponse(await context.findSimilarWorkspaces(payload.query, payload.repo_key));
		case 'audit_list':
			return jsonResponse(
				ok({
					audits: await context.listAuditRecords(payload.event_type, payload.job_id, payload.limit),
				}),
			);
		case 'audit_write':
			if (!payload.event_type || !payload.payload || typeof payload.payload !== 'object') {
				return null;
			}
			await context.writeAudit(payload.event_type, payload.payload);
			return jsonResponse(ok({ written: true, event_type: payload.event_type }));
		case 'github_event':
			if (!payload.payload || typeof payload.payload !== 'object') {
				return null;
			}
			return handleGitHubEvent(context, payload, request);
		default:
			return null;
	}
}

async function handleCreatedJob(context: QueueRequestContext, jobId: string): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (job) {
		await context.writeAudit('job_create', context.buildJobAudit(job));
	}
	return jsonResponse(ok({ job }));
}

async function handleLoadedJob(
	context: QueueRequestContext,
	jobId: string,
	includeProgressState = false,
): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	const resolvedJob = includeProgressState ? await context.reconcileJob(job) : job;
	return jsonResponse(ok({ job: resolvedJob }));
}

async function handleJobStatusUpdate(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const job = await context.getJob(payload.job_id as string);
	if (!job) {
		return jobNotFound(payload.job_id as string);
	}
	const previous = structuredClone(job);
	transitionJob(job, payload.status as JobStatus, payload.next_actor as NextActor);
	if (payload.job) {
		if (payload.job.work_branch !== undefined) job.work_branch = payload.job.work_branch;
		if (payload.job.workflow_run_id !== undefined) job.workflow_run_id = payload.job.workflow_run_id;
		if (payload.job.pr_number !== undefined) job.pr_number = payload.job.pr_number;
		if (payload.job.last_error !== undefined) job.last_error = payload.job.last_error;
		if (payload.job.worker_manifest !== undefined) {
			job.worker_manifest = mergeWorkerManifest(job.worker_manifest, payload.job.worker_manifest);
		}
		if (payload.job.auto_improve_cycle !== undefined) job.auto_improve_cycle = payload.job.auto_improve_cycle;
	}
	job.updated_at = nowIso();
	await context.persistJob(job, previous);
	await context.writeAudit(
		'job_update_status',
		context.buildJobAudit(job, {
			previous_status: previous.status,
			previous_next_actor: previous.next_actor,
			source_layer: 'system',
			attention_status: computeRunAttentionStatus(job),
		}),
	);
	return jsonResponse(ok({ job }));
}

async function handleJobAppendNote(
	context: QueueRequestContext,
	jobId: string,
	note: string,
): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	const previous = structuredClone(job);
	pushJobNote(job, note);
	job.updated_at = nowIso();
	await context.persistJob(job, previous);
	await context.writeAudit('job_append_note', { job_id: job.job_id, note });
	return jsonResponse(ok({ job }));
}

async function handleJobSubmitReview(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const job = await context.getJob(payload.job_id as string);
	if (!job) {
		return jobNotFound(payload.job_id as string);
	}
	if (job.status !== 'review_pending' || job.next_actor !== 'reviewer') {
		return jsonResponse(fail('invalid_state', 'job is not waiting for reviewer input'), 409);
	}
	const previous = structuredClone(job);
	job.review_verdict = payload.review_verdict;
	job.review_findings = payload.findings ?? [];
	if (payload.review_verdict === 'blocked') {
		transitionJob(job, 'failed', 'system');
		job.last_error = `review blocked: ${payload.next_action}`;
	} else if (payload.review_verdict === 'approved') {
		transitionJob(job, 'done', 'system');
	} else if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
		job.auto_improve_cycle += 1;
		transitionJob(job, 'rework_pending', 'worker');
	} else {
		transitionJob(job, 'failed', 'system');
		job.last_error = 'rework limit reached';
	}
	job.updated_at = nowIso();
	await context.persistJob(job, previous);
	await context.writeAudit('job_submit_review', {
		job_id: job.job_id,
		verdict: payload.review_verdict,
		findings: payload.findings,
		next_action: payload.next_action ?? null,
		source_layer: 'repo',
		attention_status: computeRunAttentionStatus(job),
	});
	return jsonResponse(ok({ job }));
}

async function handleJobProgress(context: QueueRequestContext, jobId: string): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	const audits = await context.listAuditRecords(undefined, jobId, 10);
	return jsonResponse(ok({ progress: context.buildJobProgressSnapshot(job, audits) }));
}

async function handleJobsList(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const jobs = await context.listJobs(payload.status, payload.next_actor);
	const enrichedJobs = await Promise.all(
		jobs.map(async (job) => {
			const audits = await context.listAuditRecords(undefined, job.job_id, 10);
			const feed = buildJobEventFeed(job, audits);
			return {
				...job,
				run_summary: buildRunSummary(job, audits),
				blocking_state: buildBlockingState(job),
				latest_notification: feed.items[0] ?? null,
				notification_counts: feed.counts,
			};
		}),
	);
	return jsonResponse(ok({ jobs: enrichedJobs }));
}

function filterEventFeed(
	feed: JobEventFeed,
	payload: QueueEnvelope,
): JobEventFeed {
	const since = payload.since ? payload.since.trim() : '';
	const limit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? payload.limit : 50;
	const items = feed.items
		.filter((item) => !payload.attention_status || item.status === payload.attention_status)
		.filter((item) => !payload.source_layer || item.source_layer === payload.source_layer)
		.filter((item) => !since || item.created_at >= since)
		.slice(0, Math.max(1, Math.min(limit, 200)));
	const logs = feed.logs
		.filter((log) => !payload.source_layer || log.source_layer === payload.source_layer)
		.filter((log) => !since || log.created_at >= since)
		.slice(0, Math.max(1, Math.min(limit, 200)));
	return {
		items,
		logs,
		counts: {
			idle: items.filter((item) => item.status === 'idle').length,
			pending_approval: items.filter((item) => item.status === 'pending_approval').length,
			running: items.filter((item) => item.status === 'running').length,
			completed: items.filter((item) => item.status === 'completed').length,
			failed: items.filter((item) => item.status === 'failed').length,
		},
	};
}

async function handleJobEventFeed(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const jobs = payload.job_id
		? [await context.getJob(payload.job_id)].filter((job): job is JobRecord => Boolean(job))
		: await context.listJobs();
	if (payload.job_id && jobs.length === 0) {
		return jobNotFound(payload.job_id);
	}
	const itemAccumulator = [];
	const logAccumulator = [];
	for (const job of jobs) {
		const audits = await context.listAuditRecords(undefined, job.job_id, payload.limit ?? 50);
		const filtered = filterEventFeed(buildJobEventFeed(job, audits), payload);
		itemAccumulator.push(...filtered.items);
		logAccumulator.push(...filtered.logs);
	}
	itemAccumulator.sort((left, right) => right.created_at.localeCompare(left.created_at));
	logAccumulator.sort((left, right) => right.created_at.localeCompare(left.created_at));
	const limit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? Math.max(1, Math.min(payload.limit, 200)) : 50;
	const items = itemAccumulator.slice(0, limit);
	const logs = logAccumulator.slice(0, limit);
	return jsonResponse(
		ok({
			items,
			logs,
			counts: {
				idle: items.filter((item) => item.status === 'idle').length,
				pending_approval: items.filter((item) => item.status === 'pending_approval').length,
				running: items.filter((item) => item.status === 'running').length,
				completed: items.filter((item) => item.status === 'completed').length,
				failed: items.filter((item) => item.status === 'failed').length,
			},
		}),
	);
}

async function handleWorkspaceRegister(
	context: QueueRequestContext,
	workspaceInput: Partial<WorkspaceRecord> & { repo_key?: string },
): Promise<QueueResponse> {
	const timestamp = nowIso();
	const existing = workspaceInput.repo_key ? await context.getWorkspace(workspaceInput.repo_key) : null;
	const workspace = buildWorkspaceRecord(workspaceInput as WorkspaceRecord, existing, timestamp);
	ensureSafeWorkspacePath(workspace.workspace_path);
	await context.putWorkspace(workspace);
	await context.setActiveWorkspace(workspace.repo_key);
	return jsonResponse(ok({ workspace }));
}

async function handleWorkspaceActivate(context: QueueRequestContext, repoKey: string): Promise<QueueResponse> {
	const existing = await context.getWorkspace(repoKey);
	if (!existing) {
		return workspaceNotFound(repoKey);
	}
	existing.last_used_at = nowIso();
	await context.putWorkspace(existing);
	await context.setActiveWorkspace(existing.repo_key);
	return jsonResponse(ok({ workspace: existing }));
}

async function handleWorkspaceGet(context: QueueRequestContext, repoKey: string): Promise<QueueResponse> {
	const workspace = await context.getWorkspace(repoKey);
	if (!workspace) {
		return workspaceNotFound(repoKey);
	}
	return jsonResponse(ok({ workspace }));
}

async function handleGitHubEvent(
	context: QueueRequestContext,
	payload: QueueEnvelope,
	request: Request,
): Promise<QueueResponse> {
	const deliveryId = (payload.delivery_id || request.headers.get('x-github-delivery') || `delivery-${Date.now()}`) as string;
	const registered = await context.tryRegisterDelivery(deliveryId);
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
	const outcome = await context.applyGithubEvent(payload.payload as Record<string, unknown>, deliveryId);
	await context.writeAudit('github_event_processed', { delivery_id: deliveryId, outcome });
	return jsonResponse(ok({ outcome }));
}
