import { AuditRecord, JobProgressSnapshot, JobRecord } from './types';

export function buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
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
