import type { JobRecord, PermissionResolution, QueueEnvelope } from '../../contracts';
import { mergeWorkerManifest } from '../../job-manifest';
import { computeRunAttentionStatus } from '../projections';
import { fail, jsonResponse, nowIso, ok } from '../../utils';
import { getControlState, getDispatchRequest, hasExecutionRelatedInterrupt, transitionJob } from '../../queue-state';
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

function interruptKindForResolution(resolution: PermissionResolution) {
	if (resolution === 'rejected') return 'approval_rejected';
	if (resolution === 'superseded') return 'approval_superseded';
	return 'approval_expired';
}

async function buildProgressPayload(context: QueueRequestContext, job: JobRecord, extra: Record<string, unknown> = {}) {
	const audits = await context.listAuditRecords(undefined, job.job_id, 10);
	return { ...extra, progress: context.buildJobProgressSnapshot(job, audits) };
}

export async function handlePermissionRequestResolve(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
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
	const dispatchRequest = getDispatchRequest(job);
	const shouldRedispatch = resolution === 'approved' && Boolean(dispatchRequest) && hasExecutionRelatedInterrupt(job);
	const shouldActivateQueuedRun = resolution === 'approved' && !dispatchRequest && job.status === 'queued' && job.next_actor === 'worker';
	job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
		attention: {
			approval: {
				...approval,
				pending: false,
				status: resolution,
				note,
				resolved_at: resolvedAt,
				cleared_at: resolution === 'approved' ? resolvedAt : approval.cleared_at ?? null,
			},
		},
		control:
			resolution === 'approved'
				? { state: 'active', reason: null, resolved_at: resolvedAt, last_interrupt: null }
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
				  },
	});
	if (shouldRedispatch) {
		if (!(await context.autoRedispatchJob(job, note ?? 'approval approved'))) {
			return jsonResponse(fail('resume_unavailable', 'approved run could not be re-dispatched'), 409);
		}
	}
	if (shouldActivateQueuedRun) {
		transitionJob(job, 'working', 'system');
	}
	const approvalMessage =
		resolution === 'approved'
			? shouldRedispatch
				? 'Approval was recorded and the run was re-dispatched.'
				: shouldActivateQueuedRun
					? 'Approval was recorded and the run was marked active for follow-up work.'
					: 'Approval was recorded and the run can continue.'
			: note ?? approval.reason ?? 'Approval resolution blocked the run.';
	job.updated_at = resolvedAt;
	await context.persistJob(job, previous);
	await reconcileLinkedMission(context, job);
	await context.writeAudit('permission_request_resolved', {
		job_id: job.job_id,
		repo: job.repo,
		request_id: approval.request_id,
		resolution,
		note,
		blocked_action: approval.blocked_action ?? null,
		source_layer: 'gpt',
		resume_strategy: shouldRedispatch ? 'redispatch' : shouldActivateQueuedRun ? 'activate_queued_run' : null,
		follow_up_required: shouldRedispatch || shouldActivateQueuedRun,
		attention_status: resolution === 'approved' ? computeRunAttentionStatus(job) : 'interrupted',
		message: approvalMessage,
	});
	return jsonResponse(ok({
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
			resume_strategy: shouldRedispatch ? 'redispatch' : shouldActivateQueuedRun ? 'activate_queued_run' : null,
			created_at: resolvedAt,
		},
		message: approvalMessage,
		current_progress: context.buildJobProgressSnapshot(job, await context.listAuditRecords(undefined, job.job_id, 10)),
	}));
}

export async function handleJobControl(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
	const job = await context.getJob(payload.job_id as string);
	if (!job) {
		return jobNotFound(payload.job_id as string);
	}
	const currentAttention = computeRunAttentionStatus(job);
	const currentControl = getControlState(job)?.state ?? 'active';
	if (payload.expected_state && payload.expected_state !== currentAttention && payload.expected_state !== currentControl) {
		return jsonResponse(fail('state_conflict', `job state changed from expected ${payload.expected_state} to ${currentAttention}/${currentControl}`), 409);
	}
	const previous = structuredClone(job);
	const timestamp = nowIso();
	const action = payload.control_action;
	const reason = typeof payload.reason === 'string' ? payload.reason : null;
	const dispatchRequest = getDispatchRequest(job);
	let workflowCancel = { attempted: false, cancelled: false, error: null as string | null };
	if (action === 'pause') {
		if (currentControl === 'cancelled') return jsonResponse(fail('invalid_state', 'cancelled jobs cannot be paused'), 409);
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, { control: { state: 'paused', reason: reason ?? 'Paused from the run console.', requested_by: 'gpt', requested_at: timestamp, resolved_at: null } });
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await reconcileLinkedMission(context, job);
		await context.writeAudit('job_control_paused', { job_id: job.job_id, repo: job.repo, reason: reason ?? 'Paused from the run console.', control_state: 'paused', source_layer: 'gpt', attention_status: computeRunAttentionStatus(job) });
		return jsonResponse(ok(await buildProgressPayload(context, job, { action })));
	}
	if (action === 'cancel') {
		const approval = job.worker_manifest?.attention?.approval;
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			attention: approval && approval.pending ? { approval: { ...approval, pending: false, status: 'superseded', note: reason ?? approval.reason ?? null, resolved_at: timestamp } } : undefined,
			control: { state: 'cancelled', reason: reason ?? 'Cancelled from the run console.', requested_by: 'gpt', requested_at: timestamp, resolved_at: timestamp, resume_strategy: null, last_interrupt: null },
		});
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await reconcileLinkedMission(context, job);
		workflowCancel = await context.cancelWorkflowRun(job);
		await context.writeAudit('job_control_cancelled', { job_id: job.job_id, repo: job.repo, reason: reason ?? 'Cancelled from the run console.', control_state: 'cancelled', source_layer: 'gpt', attention_status: 'cancelled', workflow_cancel_attempted: workflowCancel.attempted, workflow_cancelled: workflowCancel.cancelled, workflow_cancel_error: workflowCancel.error });
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, workflow_cancel: workflowCancel })));
	}
	if (action === 'resume') {
		if (currentControl === 'cancelled') return jsonResponse(fail('invalid_state', 'cancelled jobs must be retried explicitly'), 409);
		const resumeStrategy = payload.resume_strategy ?? (dispatchRequest && hasExecutionRelatedInterrupt(job) ? 'redispatch' : 'refresh');
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, { control: { state: 'active', reason: null, requested_by: 'gpt', resolved_at: timestamp, resume_strategy: resumeStrategy, last_interrupt: null } });
		if (resumeStrategy === 'redispatch') {
			if (!dispatchRequest) return jsonResponse(fail('resume_unavailable', 'resume redispatch requires a stored dispatch request'), 409);
			if (!(await context.autoRedispatchJob(job, reason ?? 'manual resume'))) return jsonResponse(fail('resume_unavailable', 'run could not be re-dispatched'), 409);
		}
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await reconcileLinkedMission(context, job);
		await context.writeAudit('job_control_resumed', { job_id: job.job_id, repo: job.repo, reason, control_state: 'active', resume_strategy: resumeStrategy, source_layer: 'gpt', attention_status: computeRunAttentionStatus(job) });
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, resume_strategy: resumeStrategy })));
	}
	if (action === 'retry') {
		if (currentAttention !== 'failed' && currentAttention !== 'interrupted') return jsonResponse(fail('retry_unavailable', 'retry is only available from failed or interrupted runs'), 409);
		if (!dispatchRequest) return jsonResponse(fail('retry_unavailable', 'retry requires a stored dispatch request'), 409);
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, { control: { state: 'active', reason: null, requested_by: 'gpt', resolved_at: timestamp, resume_strategy: 'redispatch', last_interrupt: null } });
		if (!(await context.autoRedispatchJob(job, reason ?? 'manual retry'))) return jsonResponse(fail('retry_unavailable', 'run could not be re-dispatched'), 409);
		job.updated_at = timestamp;
		await context.persistJob(job, previous);
		await reconcileLinkedMission(context, job);
		await context.writeAudit('job_control_retried', { job_id: job.job_id, repo: job.repo, reason, control_state: 'active', resume_strategy: 'redispatch', source_layer: 'gpt', attention_status: computeRunAttentionStatus(job) });
		return jsonResponse(ok(await buildProgressPayload(context, job, { action, resume_strategy: 'redispatch' })));
	}
	return jsonResponse(fail('invalid_action', `unknown job control action: ${String(action)}`), 400);
}

export async function handleJobSubmitReview(context: QueueRequestContext, payload: QueueEnvelope): Promise<QueueResponse> {
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
	await reconcileLinkedMission(context, job);
	await context.writeAudit('job_submit_review', { job_id: job.job_id, verdict: payload.review_verdict, findings: payload.findings, next_action: payload.next_action ?? null, source_layer: 'repo', attention_status: computeRunAttentionStatus(job) });
	return jsonResponse(ok({ job }));
}
