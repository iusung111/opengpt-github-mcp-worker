import {
	AuditRecord,
	BlockingState,
	JobApprovalManifest,
	JobProgressSnapshot,
	JobRecord,
	JobWorkerManifest,
	LayerLogEntry,
	NotificationCounts,
	NotificationItem,
	NotificationSeverity,
	NotificationSourceLayer,
	RunAttentionStatus,
	RunSummary,
} from './types';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compareIsoDesc(left: { created_at: string }, right: { created_at: string }): number {
	return right.created_at.localeCompare(left.created_at);
}

function buildNotificationCounts(items: NotificationItem[]): NotificationCounts {
	const counts: NotificationCounts = {
		idle: 0,
		pending_approval: 0,
		running: 0,
		completed: 0,
		failed: 0,
	};
	for (const item of items) {
		counts[item.status] += 1;
	}
	return counts;
}

function getApprovalManifest(manifest: JobWorkerManifest | undefined): JobApprovalManifest | null {
	return normalizeApprovalManifest(manifest?.attention?.approval) ?? null;
}

function hasActiveManifestSection(manifest: JobWorkerManifest | undefined): boolean {
	const verificationStatus = manifest?.verification?.status;
	const previewStatus = manifest?.preview?.status;
	const browserStatus = manifest?.browser?.status;
	const desktopStatus = manifest?.desktop?.status;
	const runtimeStatus = manifest?.runtime?.status;
	return (
		verificationStatus === 'queued' ||
		verificationStatus === 'running' ||
		previewStatus === 'creating' ||
		previewStatus === 'destroying' ||
		browserStatus === 'running' ||
		desktopStatus === 'building' ||
		desktopStatus === 'smoke_running' ||
		runtimeStatus === 'collecting'
	);
}

function inferEventLayer(eventType: string, payload: Record<string, unknown>): NotificationSourceLayer {
	const explicitLayer = payload.source_layer;
	if (
		explicitLayer === 'gpt' ||
		explicitLayer === 'mcp' ||
		explicitLayer === 'cloudflare' ||
		explicitLayer === 'repo' ||
		explicitLayer === 'system'
	) {
		return explicitLayer;
	}
	if (eventType.startsWith('job_attention_approval')) return 'gpt';
	if (eventType === 'job_submit_review' || eventType === 'github_event_processed') return 'repo';
	if (payload.section === 'preview') return 'cloudflare';
	if (payload.section === 'verification' || payload.section === 'browser' || payload.section === 'desktop' || payload.section === 'runtime') {
		return 'mcp';
	}
	return 'system';
}

function inferStatusFromEvent(job: JobRecord, eventType: string, payload: Record<string, unknown>): RunAttentionStatus {
	const explicitStatus = payload.attention_status;
	if (
		explicitStatus === 'idle' ||
		explicitStatus === 'pending_approval' ||
		explicitStatus === 'running' ||
		explicitStatus === 'completed' ||
		explicitStatus === 'failed'
	) {
		return explicitStatus;
	}
	if (eventType === 'job_attention_approval_requested') return 'pending_approval';
	if (eventType === 'job_attention_approval_cleared') return 'running';
	if (eventType === 'job_submit_review' && payload.verdict === 'blocked') return 'failed';
	if (eventType === 'job_submit_review' && payload.verdict === 'approved') return 'completed';
	return computeRunAttentionStatus(job);
}

function inferSeverity(status: RunAttentionStatus, eventType: string, payload: Record<string, unknown>): NotificationSeverity {
	const explicitSeverity = payload.severity;
	if (explicitSeverity === 'info' || explicitSeverity === 'warning' || explicitSeverity === 'error') {
		return explicitSeverity;
	}
	if (status === 'failed' || eventType.includes('failed') || eventType === 'job_submit_review' && payload.verdict === 'blocked') {
		return 'error';
	}
	if (status === 'pending_approval' || payload.verdict === 'changes_requested') {
		return 'warning';
	}
	return 'info';
}

function buildAuditTitle(eventType: string, payload: Record<string, unknown>, status: RunAttentionStatus): string {
	const explicitTitle = asString(payload.title);
	if (explicitTitle) {
		return explicitTitle;
	}
	if (eventType === 'job_attention_approval_requested') return 'Approval requested';
	if (eventType === 'job_attention_approval_cleared') return 'Approval cleared';
	if (eventType === 'job_submit_review' && payload.verdict === 'approved') return 'Review approved';
	if (eventType === 'job_submit_review' && payload.verdict === 'changes_requested') return 'Review changes requested';
	if (eventType === 'job_submit_review' && payload.verdict === 'blocked') return 'Review blocked';
	if (eventType === 'job_update_status') return 'Job status updated';
	if (eventType === 'job_manifest_notification') {
		const section = asString(payload.section) ?? 'worker';
		return `${section} update`;
	}
	if (status === 'completed') return 'Run completed';
	if (status === 'failed') return 'Run failed';
	if (status === 'running') return 'Run update';
	return 'Job update';
}

function buildAuditBody(job: JobRecord, eventType: string, payload: Record<string, unknown>, status: RunAttentionStatus): string {
	const explicitMessage = asString(payload.message);
	if (explicitMessage) {
		return explicitMessage;
	}
	if (eventType === 'job_append_note') {
		return asString(payload.note) ?? 'A note was added to the job.';
	}
	if (eventType === 'job_update_status') {
		const nextStatus = asString(payload.status) ?? job.status;
		const nextActor = asString(payload.next_actor) ?? job.next_actor;
		return `Job moved to ${nextStatus} with next actor ${nextActor}.`;
	}
	if (eventType === 'job_attention_approval_requested') {
		return asString(payload.reason) ?? 'User approval is required before continuing.';
	}
	if (eventType === 'job_attention_approval_cleared') {
		return 'Approval requirement cleared and work can continue.';
	}
	if (eventType === 'job_submit_review') {
		const verdict = asString(payload.verdict) ?? 'reviewed';
		return `Review verdict: ${verdict}.`;
	}
	if (eventType === 'job_manifest_notification') {
		const section = asString(payload.section) ?? 'worker';
		const sectionStatus = asString(payload.section_status) ?? asString(payload.status) ?? 'updated';
		return `${section} is ${sectionStatus}.`;
	}
	if (status === 'failed') {
		return job.last_error ?? 'Run failed.';
	}
	if (status === 'pending_approval') {
		return getApprovalManifest(job.worker_manifest)?.reason ?? 'Awaiting approval.';
	}
	return `Run status is ${status}.`;
}

function buildLinkedRefs(job: JobRecord, payload: Record<string, unknown>): Record<string, unknown> {
	const refs: Record<string, unknown> = {};
	const workflowRunId = asNumber(payload.workflow_run_id) ?? job.workflow_run_id ?? null;
	const prNumber = asNumber(payload.pr_number) ?? job.pr_number ?? null;
	const previewId = asString(payload.preview_id) ?? job.worker_manifest?.preview?.preview_id ?? null;
	const blockedAction = asString(payload.blocked_action);
	if (workflowRunId !== null) refs.workflow_run_id = workflowRunId;
	if (prNumber !== null) refs.pr_number = prNumber;
	if (previewId !== null) refs.preview_id = previewId;
	if (blockedAction !== null) refs.blocked_action = blockedAction;
	return refs;
}

function buildSyntheticStatusNotification(job: JobRecord): NotificationItem {
	const status = computeRunAttentionStatus(job);
	const approval = getApprovalManifest(job.worker_manifest);
	return {
		id: `${job.job_id}:status:${job.updated_at}`,
		job_id: job.job_id,
		run_id: job.job_id,
		status,
		title: buildAuditTitle('job_status_projection', {}, status),
		body:
			status === 'pending_approval'
				? approval?.reason ?? 'Awaiting approval.'
				: status === 'failed'
					? job.last_error ?? 'Run failed.'
					: `Run status is ${status}.`,
		source_layer: 'system',
		severity: inferSeverity(status, 'job_status_projection', {}),
		created_at: job.updated_at,
		linked_refs: buildLinkedRefs(job, {}),
		dedupe_key: `job:${job.job_id}:status:${status}:${job.workflow_run_id ?? 'none'}`,
	};
}

function buildSyntheticLog(job: JobRecord): LayerLogEntry[] {
	const errorMessage = asString(job.last_error);
	if (!errorMessage) {
		return [];
	}
	return [
		{
			id: `${job.job_id}:log:last_error:${job.updated_at}`,
			job_id: job.job_id,
			run_id: job.job_id,
			source_layer: 'system',
			level: 'error',
			message: errorMessage,
			created_at: job.updated_at,
			workflow_run_id: job.workflow_run_id ?? null,
		},
	];
}

export function computeRunAttentionStatus(job: JobRecord): RunAttentionStatus {
	const approval = getApprovalManifest(job.worker_manifest);
	if (approval?.pending) {
		return 'pending_approval';
	}
	if (job.status === 'failed' || job.review_verdict === 'blocked') {
		return 'failed';
	}
	if (job.status === 'done') {
		return 'completed';
	}
	if (job.status === 'working' || hasActiveManifestSection(job.worker_manifest)) {
		return 'running';
	}
	return 'idle';
}

function buildProgressPercent(job: JobRecord, status: RunAttentionStatus): number {
	if (status === 'completed' || status === 'failed') return 100;
	if (status === 'pending_approval') return 70;
	if (status === 'idle') return 10;
	if (job.status === 'review_pending') return 90;
	if (job.worker_manifest?.runtime?.status === 'ready') return 85;
	if (job.worker_manifest?.browser?.status === 'passed') return 80;
	if (job.worker_manifest?.preview?.status === 'ready') return 65;
	if (job.worker_manifest?.verification?.status === 'running') return 40;
	return 25;
}

function buildRunTitle(job: JobRecord): string {
	if (job.operation_type && job.operation_type.trim()) {
		return `${job.operation_type} for ${job.repo}`;
	}
	return `Run for ${job.repo}`;
}

export function buildBlockingState(job: JobRecord): BlockingState {
	const approval = getApprovalManifest(job.worker_manifest);
	if (approval?.pending) {
		return {
			kind: 'approval',
			reason: approval.reason ?? 'Approval is required before continuing.',
			blocked_action: approval.blocked_action ?? null,
			resume_hint: 'Approve the requested tool bundle, then resume the job.',
		};
	}
	if (job.status === 'review_pending') {
		return {
			kind: 'review',
			reason: 'Reviewer input is required.',
			blocked_action: 'submit_review',
			resume_hint: 'Submit a review verdict to continue the run.',
		};
	}
	if (job.status === 'failed' || job.review_verdict === 'blocked') {
		return {
			kind: 'failure',
			reason: job.last_error ?? 'The run failed.',
			blocked_action: null,
			resume_hint: 'Inspect the latest notification or layer logs before retrying.',
		};
	}
	return {
		kind: 'none',
		reason: null,
		blocked_action: null,
		resume_hint: null,
	};
}

export function buildJobEventFeed(
	job: JobRecord,
	recentAudits: AuditRecord[],
): {
	items: NotificationItem[];
	logs: LayerLogEntry[];
	counts: NotificationCounts;
} {
	const itemMap = new Map<string, NotificationItem>();
	const logMap = new Map<string, LayerLogEntry>();

	for (let index = 0; index < recentAudits.length; index += 1) {
		const audit = recentAudits[index];
		const payload = asRecord(audit.payload);
		const status = inferStatusFromEvent(job, audit.event_type, payload);
		const layer = inferEventLayer(audit.event_type, payload);
		const body = buildAuditBody(job, audit.event_type, payload, status);
		const dedupeKey =
			asString(payload.dedupe_key) ??
			`${job.job_id}:${audit.event_type}:${asString(payload.section) ?? ''}:${body}`;
		const item: NotificationItem = {
			id: `${job.job_id}:${audit.event_type}:${audit.created_at}:${index}`,
			job_id: job.job_id,
			run_id: job.job_id,
			status,
			title: buildAuditTitle(audit.event_type, payload, status),
			body,
			source_layer: layer,
			severity: inferSeverity(status, audit.event_type, payload),
			created_at: audit.created_at,
			linked_refs: buildLinkedRefs(job, payload),
			dedupe_key: dedupeKey,
		};
		const existing = itemMap.get(dedupeKey);
		if (!existing || existing.created_at.localeCompare(item.created_at) < 0) {
			itemMap.set(dedupeKey, item);
		}

		const shouldEmitLog =
			layer === 'mcp' ||
			layer === 'cloudflare' ||
			audit.event_type === 'job_manifest_notification' ||
			audit.event_type === 'job_attention_approval_requested' ||
			audit.event_type === 'job_attention_approval_cleared';
		if (shouldEmitLog) {
			const message = asString(payload.log_message) ?? body;
			const logLevel = item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'info';
			const logKey =
				asString(payload.log_dedupe_key) ??
				`${job.job_id}:${layer}:${asString(payload.section) ?? audit.event_type}:${message}`;
			const log: LayerLogEntry = {
				id: `${job.job_id}:log:${audit.event_type}:${audit.created_at}:${index}`,
				job_id: job.job_id,
				run_id: job.job_id,
				source_layer: layer,
				level: logLevel,
				message,
				created_at: audit.created_at,
				workflow_run_id: asNumber(payload.workflow_run_id) ?? job.workflow_run_id ?? null,
			};
			const existingLog = logMap.get(logKey);
			if (!existingLog || existingLog.created_at.localeCompare(log.created_at) < 0) {
				logMap.set(logKey, log);
			}
		}
	}

	const syntheticStatus = buildSyntheticStatusNotification(job);
	if (!itemMap.has(syntheticStatus.dedupe_key)) {
		itemMap.set(syntheticStatus.dedupe_key, syntheticStatus);
	}
	for (const log of buildSyntheticLog(job)) {
		const logKey = `${log.source_layer}:${log.message}`;
		const existing = logMap.get(logKey);
		if (!existing || existing.created_at.localeCompare(log.created_at) < 0) {
			logMap.set(logKey, log);
		}
	}

	const items = Array.from(itemMap.values()).sort(compareIsoDesc);
	const logs = Array.from(logMap.values()).sort(compareIsoDesc);
	return {
		items,
		logs,
		counts: buildNotificationCounts(items),
	};
}

export function buildRunSummary(job: JobRecord, recentAudits: AuditRecord[]): RunSummary {
	const feed = buildJobEventFeed(job, recentAudits);
	const status = computeRunAttentionStatus(job);
	const approval = getApprovalManifest(job.worker_manifest);
	return {
		run_id: job.job_id,
		job_id: job.job_id,
		title: buildRunTitle(job),
		status,
		progress_percent: buildProgressPercent(job, status),
		last_event: feed.items[0]?.body ?? null,
		approval_reason: approval?.pending ? approval.reason ?? null : null,
		updated_at: job.updated_at,
		workflow_run_id: job.workflow_run_id ?? null,
		pr_number: job.pr_number ?? null,
		preview_id: job.worker_manifest?.preview?.preview_id ?? null,
	};
}

export function buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
	const eventFeed = buildJobEventFeed(job, recentAudits);
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
		run_summary: buildRunSummary(job, recentAudits),
		blocking_state: buildBlockingState(job),
		latest_notification: eventFeed.items[0] ?? null,
		notification_counts: eventFeed.counts,
		last_transition_at: job.last_transition_at,
		last_reconciled_at: job.last_reconciled_at ?? null,
		last_webhook_event_at: job.last_webhook_event_at ?? null,
		updated_at: job.updated_at,
	};
}

export function buildJobAudit(job: JobRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
uto_improve_cycle: job.auto_improve_cycle,
		stale_reason: job.stale_reason ?? null,
		...extra,
	};
}
