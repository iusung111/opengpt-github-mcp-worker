import {
	AuditRecord,
	JobEventFeed,
	JobProgressSnapshot,
	JobRecord,
	JobStatus,
	NextActor,
	QueueEnvelope,
	PermissionResolution,
	ToolResultEnvelope,
	WorkspaceRecord,
} from './types';
import { mergeWorkerManifest } from './job-manifest';
import { buildBlockingState, buildJobEventFeed, buildRunSummary, computeRunAttentionStatus } from './queue-projections';
import { jsonResponse, fail, ok, nowIso } from './utils';
import { buildWorkspaceRecord } from './queue-workspaces';
import { ensureSafeWorkspacePath } from './queue-helpers';
import { normalizeBrowserRemoteControl } from './browser-remote-control';
import {
	getControlState,
	getDispatchRequest,
	hasExecutionRelatedInterrupt,
	isSmokeTraceJob,
	pushJobNote,
	transitionJob,
} from './queue-state';

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
	autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean>;
	cancelWorkflowRun(job: JobRecord): Promise<{ attempted: boolean; cancelled: boolean; error: string | null }>;
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
		case 'job_control':
			if (!payload.job_id || !payload.control_action) {
				return null;
			}
			return handleJobControl(context, payload);
		case 'job_append_note':
			if (!payload.job_id || !payload.note) {
				return null;
			}
			return handleJobAppendNote(context, payload.job_id, payload.note);
		case 'permission_request_resolve':
			if (!payload.job_id || !payload.request_id || !payload.resolution) {
				return null;
			}
			return handlePermissionRequestResolve(context, payload);
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

function interruptKindForResolution(resolution: PermissionResolution) {
	if (resolution === 'rejected') return 'approval_rejected';
	if (resolution === 'superseded') return 'approval_superseded';
	return 'approval_expired';
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

async function buildProgressPayload(context: QueueRequestContext, job: JobRecord, extra: Record<string, unknown> = {}) {
	const audits = await context.listAuditRecords(undefined, job.job_id, 10);
	return {
		...extra,
		progress: context.buildJobProgressSnapshot(job, audits),
	};
}

async function handlePermissionRequestResolve(
	context: QueueRequestContext,
	payload: QueueEnvelope,
): Promise<QueueResponse> {
	const job = await context.getJob(payload.job_id as string);
	if (!job) {
		return jobNotFound(payload.job_id as string);
	}
	const approval = job.worker_manifest?.attention?.approval;
	if (!approval || typeof approval !== 'object' || typeof approval.request_id !== 'string') {
		return jsonResponse(fail('permission_request_not_found', 'no active permission request was found for this job'), 404);
	}
	if (approval.request_id !== payload.request_id) {
		return jsonResponse(fail('permission_request_mismatch', 'permission request id does not match the current job state'), 409);
	}
	const previous = structuredClone(job);
	const resolvedAt = nowIso();
	const resolution = payload.resolution as PermissionResolution;
	const note = typeof payload.note === 'string' ? payload.note : null;
	const resolvedApproval = {
		...approval,
		pending: false,
		status: resolution,
		note,
		resolved_at: resolvedAt,
		cleared_at: resolution === 'approved' ? resolvedAt : approval.cleared_at ?? null,
	};
	const controlPatch =
		resolution === 'approved'
			? {
					state: 'active',
					reason: null,
					resolved_at: resolvedAt,
					last_interrupt: null,
			  }
			: {
					state: 'active',
					reason: note ?? approval.reason ?? null,
					resolved_at: resolvedAt,
					last_interrupt: {
						kind: interruptKindForResolution(resolution),
						source: 'gpt',
						message: note ?? approval.reason ?? 'Approval resolution blocked the run.',
						recorded_at: resolvedAt,
					},
			  };
	job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
		attention: {
			approval: resolvedApproval,
		},
		control: controlPatch,
	});
	job.updated_at = resolvedAt;
	await context.persistJob(job, previous);
	await context.writeAudit('permission_request_resolved', {
		job_id: job.job_id,
		repo: job.repo,
		request_id: approval.request_id,
		resolution,
		note,
		blocked_action: approval.blocked_action ?? null,
		source_layer: 'gpt',
		attention_status: resolution === 'approved' ? computeRunAttentionStatus(job) : 'interrupted',
		message:
			resolution === 'approved'
				? 'Approval was recorded and the run can continue.'
				: note ?? approval.reason ?? 'Approval resolution blocked the run.',
	});
	return jsonResponse(
		ok(
			{
				request_id: approval.request_id,
				status: resolution,
				requested_at: approval.requested_at ?? null,
				resolved_at: resolvedAt,
				bundle: approval.bundle ?? null,
				notification: {
					job_id: job.job_id,
					run_id: job.job_id,
					status: resolution === 'approved' ? 'running' : 'interrupted',
					source_layer: 'gpt',
					request_id: approval.request_id,
					reason: note ?? approval.reason ?? null,
					resolution,
					created_at: resolvedAt,
				},
				current_progress: context.buildJobProgressSnapshot(
					job,
					await context.listAuditRecords(undefined, job.job_id, 10),
				),
			},
		),
	);
}

async function handleJobControl(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const job = await context.getJob(payload.job_id as string);
	if (!job) {
		return jobNotFound(payload.job_id as string);
	}
	const currentAttention = computeRunAttentionStatus(job);
	const currentControl = getControlState(job)?.state ?? 'active';
	if (
		payload.expected_state &&
		payload.expected_state !== currentAttention &&
		payload.expected_state !== currentControl
	) {
		return jsonResponse(
			fail(
				'state_conflict',
				`job state changed from expected ${payload.expected_state} to ${currentAttention}/${currentControl}`,
			),
			409,
		);
	}
	const previous = structuredClone(job);
	const timestamp = nowIso();
	const action = payload.control_action;
	const reason = typeof payload.reason === 'string' ? payload.reason : null;
	const dispatchRequest = getDispatchRequest(job);
	let workflowCancel = { attempted: false, cancelled: false, error: null as string | null };
	if (action === 'pause') {
		if (currentControl === 'cancelled') {
			return jsonResponse(fail('invalid_state', 'cancelled jobs cannot be paused'), 409);
		}
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			control: {
				state: 'paused',
				reason: reason ?? 'Paused from the run console.',
				requested_by: 'gpt',
				requested_at: timestamp,
				resolved_at: null,
			},
		});
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await context.writeAudit('job_control_paused', {
			job_id: job.job_id,
			repo: job.repo,
			reason: reason ?? 'Paused from the run console.',
			control_state: 'paused',
			source_layer: 'gpt',
			attention_status: computeRunAttentionStatus(job),
		});
		return jsonResponse(ok(await buildProgressPayload(context, job, { action })));
	}
	if (action === 'cancel') {
		const approval = job.worker_manifest?.attention?.approval;
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			attention:
				approval && approval.pending
					? {
							approval: {
								...approval,
								pending: false,
								status: 'superseded',
								note: reason ?? approval.reason ?? null,
								resolved_at: timestamp,
							},
					  }
					: undefined,
			control: {
				state: 'cancelled',
				reason: reason ?? 'Cancelled from the run console.',
				requested_by: 'gpt',
				requested_at: timestamp,
				resolved_at: timestamp,
				resume_strategy: null,
				last_interrupt: null,
			},
		});
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		workflowCancel = await context.cancelWorkflowRun(job);
		await context.writeAudit('job_control_cancelled', {
			job_id: job.job_id,
			repo: job.repo,
			reason: reason ?? 'Cancelled from the run console.',
			control_state: 'cancelled',
			source_layer: 'gpt',
			attention_status: 'cancelled',
			workflow_cancel_attempted: workflowCancel.attempted,
			workflow_cancelled: workflowCancel.cancelled,
			workflow_cancel_error: workflowCancel.error,
		});
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, workflow_cancel: workflowCancel })));
	}
	if (action === 'resume') {
		if (currentControl === 'cancelled') {
			return jsonResponse(fail('invalid_state', 'cancelled jobs must be retried explicitly'), 409);
		}
		const resumeStrategy =
			payload.resume_strategy ?? (dispatchRequest && hasExecutionRelatedInterrupt(job) ? 'redispatch' : 'refresh');
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			control: {
				state: 'active',
				reason: null,
				requested_by: 'gpt',
				resolved_at: timestamp,
				resume_strategy: resumeStrategy,
				last_interrupt: null,
			},
		});
		if (resumeStrategy === 'redispatch') {
			if (!dispatchRequest) {
				return jsonResponse(fail('resume_unavailable', 'resume redispatch requires a stored dispatch request'), 409);
			}
			const redispatched = await context.autoRedispatchJob(job, reason ?? 'manual resume');
			if (!redispatched) {
				return jsonResponse(fail('resume_unavailable', 'run could not be re-dispatched'), 409);
			}
		}
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await context.writeAudit('job_control_resumed', {
			job_id: job.job_id,
			repo: job.repo,
			reason,
			control_state: 'active',
			resume_strategy: resumeStrategy,
			source_layer: 'gpt',
			attention_status: computeRunAttentionStatus(job),
		});
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, resume_strategy: resumeStrategy })));
	}
	if (action === 'retry') {
		if (currentAttention !== 'failed' && currentAttention !== 'interrupted') {
			return jsonResponse(fail('retry_unavailable', 'retry is only available from failed or interrupted runs'), 409);
		}
		if (!dispatchRequest) {
			return jsonResponse(fail('retry_unavailable', 'retry requires a stored dispatch request'), 409);
		}
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			control: {
				state: 'active',
				reason: null,
				requested_by: 'gpt',
				resolved_at: timestamp,
				resume_strategy: 'redispatch',
				last_interrupt: null,
			},
		});
		const redispatched = await context.autoRedispatchJob(job, reason ?? 'manual retry');
		if (!redispatched) {
			return jsonResponse(fail('retry_unavailable', 'run could not be re-dispatched'), 409);
		}
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await context.writeAudit('job_control_retried', {
			job_id: job.job_id,
			repo: job.repo,
			reason,
			control_state: 'active',
			resume_strategy: 'redispatch',
			source_layer: 'gpt',
			attention_status: computeRunAttentionStatus(job),
		});
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, resume_strategy: 'redispatch' })));
	}
	return jsonResponse(fail('invalid_action', `unknown job control action: ${String(action)}`), 400);
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
		counts: countAttentionStates(items),
	};
}

async function handleJobEventFeed(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
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
	const items = itemAccumulator.slice(0, limit);
	const logs = logAccumulator.slice(0, limit);
	return jsonResponse(
		ok({
			items,
			logs,
			counts: countAttentionStates(items),
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
