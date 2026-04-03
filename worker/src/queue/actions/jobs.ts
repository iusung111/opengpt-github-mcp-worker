import type { JobRecord, JobStatus, NextActor, QueueEnvelope } from '../../contracts';
import { mergeWorkerManifest } from '../../job-manifest';
import { buildJobEventFeed, buildRunSummary, buildBlockingState, computeRunAttentionStatus, computeRunnableDiagnostics } from '../projections';
import { normalizeBrowserRemoteControl } from '../../browser-remote-control';
import { fail, jsonResponse, nowIso, ok } from '../../utils';
import { isSmokeTraceJob, pushJobNote, transitionJob } from '../../queue-state';
import type { QueueRequestContext, QueueResponse } from './context';
import { jobNotFound } from './context';

async function reconcileLinkedMission(context: QueueRequestContext, job: JobRecord): Promise<void> {
	if (!job.mission_id) {
		return;
	}
	const mission = await context.getMission(job.mission_id);
	if (mission) {
		await context.reconcileMission(mission);
	}
}

export async function handleCreatedJob(context: QueueRequestContext, jobId: string): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (job) {
		await context.writeAudit('job_create', context.buildJobAudit(job));
		const sessionContext = job.worker_manifest?.browser?.session_context;
		if (sessionContext?.provider === 'chatgpt_web' && sessionContext.session_url) {
			await context.writeAudit('browser_session_seeded', {
				job_id: job.job_id,
				repo: job.repo,
				session_url: sessionContext.session_url,
				conversation_id: sessionContext.conversation_id ?? null,
				source_layer: 'mcp',
				attention_status: computeRunAttentionStatus(job),
				message: 'Browser session metadata was linked to the job.',
			});
		}
	}
	return jsonResponse(ok({ job, runnable_analysis: job ? computeRunnableDiagnostics(job) : null }));
}

export async function handleLoadedJob(context: QueueRequestContext, jobId: string, includeProgressState = false): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	return jsonResponse(ok({ job: includeProgressState ? await context.reconcileJob(job) : job }));
}

export async function handleJobStatusUpdate(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
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
	await reconcileLinkedMission(context, job);
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

export async function handleJobAppendNote(context: QueueRequestContext, jobId: string, note: string): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	const previous = structuredClone(job);
	pushJobNote(job, note);
	job.updated_at = nowIso();
	await context.persistJob(job, previous);
	await reconcileLinkedMission(context, job);
	await context.writeAudit('job_append_note', { job_id: job.job_id, note });
	return jsonResponse(ok({ job }));
}

export async function handleJobProgress(context: QueueRequestContext, jobId: string): Promise<QueueResponse> {
	const job = await context.getJob(jobId);
	if (!job) {
		return jobNotFound(jobId);
	}
	const audits = await context.listAuditRecords(undefined, jobId, 10);
	return jsonResponse(ok({ progress: context.buildJobProgressSnapshot(job, audits) }));
}

export async function handleJobsList(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const jobs = (await context.listJobs(payload.status, payload.next_actor)).filter((job) => !isSmokeTraceJob(job));
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
				control_state: job.worker_manifest?.control ?? null,
				approval_request: job.worker_manifest?.attention?.approval ?? null,
				browser_control: normalizeBrowserRemoteControl(job.worker_manifest?.browser?.remote_control),
			};
		}),
	);
	return jsonResponse(ok({ jobs: enrichedJobs }));
}

function countAttentionStates(items: Array<{ status: string }>) {
	return {
		idle: items.filter((item) => item.status === 'idle').length,
		pending_approval: items.filter((item) => item.status === 'pending_approval').length,
		running: items.filter((item) => item.status === 'running').length,
		paused: items.filter((item) => item.status === 'paused').length,
		cancelled: items.filter((item) => item.status === 'cancelled').length,
		interrupted: items.filter((item) => item.status === 'interrupted').length,
		completed: items.filter((item) => item.status === 'completed').length,
		failed: items.filter((item) => item.status === 'failed').length,
	};
}

function filterEventFeed(feed: ReturnType<typeof buildJobEventFeed>, payload: QueueEnvelope) {
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
	return { items, logs, counts: countAttentionStates(items) };
}

export async function handleJobEventFeed(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const jobs = payload.job_id
		? [await context.getJob(payload.job_id)].filter((job): job is JobRecord => Boolean(job))
		: (await context.listJobs()).filter((job) => !isSmokeTraceJob(job));
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
	return jsonResponse(ok({ items: itemAccumulator.slice(0, limit), logs: logAccumulator.slice(0, limit), counts: countAttentionStates(itemAccumulator.slice(0, limit)) }));
}
