import { normalizeBrowserRemoteControl } from '../../browser-remote-control';
import type { AuditRecord, JobProgressSnapshot, JobRecord, RunSummary } from '../../contracts';
import { buildBlockingState } from './blocking';
import { buildJobEventFeed } from './event-feed';
import { computeRunAttentionStatus, computeRunnableDiagnostics, getApprovalManifest, getControlManifest, getLastInterrupt, interruptMessage } from './status';

function buildProgressPercent(job: JobRecord) {
	const status = computeRunAttentionStatus(job);
	if (status === 'completed' || status === 'failed' || status === 'cancelled') return 100;
	if (status === 'paused') return 60;
	if (status === 'interrupted') return 55;
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
	return job.operation_type && job.operation_type.trim() ? `${job.operation_type} for ${job.repo}` : `Run for ${job.repo}`;
}

export function buildRunSummary(job: JobRecord, recentAudits: AuditRecord[]): RunSummary {
	const feed = buildJobEventFeed(job, recentAudits);
	const status = computeRunAttentionStatus(job);
	const runnableDiagnostics = computeRunnableDiagnostics(job);
	const approval = getApprovalManifest(job.worker_manifest);
	const control = getControlManifest(job.worker_manifest);
	const interrupt = getLastInterrupt(job.worker_manifest);
	return {
		run_id: job.job_id,
		job_id: job.job_id,
		title: buildRunTitle(job),
		status,
		runnable: runnableDiagnostics.runnable,
		idle_reason: runnableDiagnostics.idle_reason,
		missing_requirements: runnableDiagnostics.missing_requirements,
		missing_capabilities: runnableDiagnostics.missing_capabilities,
		progress_percent: buildProgressPercent(job),
		last_event: feed.items[0]?.body ?? null,
		approval_reason: approval?.pending ? approval.reason ?? null : null,
		updated_at: job.updated_at,
		workflow_run_id: job.workflow_run_id ?? null,
		pr_number: job.pr_number ?? null,
		preview_id: job.worker_manifest?.preview?.preview_id ?? null,
		control_state: control?.state ?? null,
		interrupt_kind: interrupt?.kind ?? null,
		interrupt_message: interruptMessage(interrupt),
	};
}

export function buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
	const eventFeed = buildJobEventFeed(job, recentAudits);
	const runnableDiagnostics = computeRunnableDiagnostics(job);
	return {
		job_id: job.job_id,
		repo: job.repo,
		status: job.status,
		next_actor: job.next_actor,
		runnable: runnableDiagnostics.runnable,
		idle_reason: runnableDiagnostics.idle_reason,
		missing_requirements: runnableDiagnostics.missing_requirements,
		missing_capabilities: runnableDiagnostics.missing_capabilities,
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
		control_state: getControlManifest(job.worker_manifest),
		approval_request: getApprovalManifest(job.worker_manifest),
		browser_control: normalizeBrowserRemoteControl(job.worker_manifest?.browser?.remote_control),
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
