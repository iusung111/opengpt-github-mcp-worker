import type { BlockingState, JobRecord } from '../../contracts';
import { computeRunAttentionStatus, getApprovalManifest, getControlManifest, getLastInterrupt, interruptMessage } from './status';

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getManifestSectionHasDispatch(job: JobRecord): boolean {
	const manifest = job.worker_manifest ?? {};
	return Boolean(manifest.dispatch_request || manifest.execution?.dispatch_request);
}

export function buildBlockingState(job: JobRecord): BlockingState {
	const control = getControlManifest(job.worker_manifest);
	const interrupt = getLastInterrupt(job.worker_manifest);
	const approval = getApprovalManifest(job.worker_manifest);
	if (control?.state === 'cancelled') {
		return {
			kind: 'cancelled',
			reason: asString(control.reason) ?? 'Run cancelled.',
			blocked_action: null,
			resume_hint: 'Retry the run explicitly if work should continue.',
		};
	}
	if (control?.state === 'paused') {
		return {
			kind: 'paused',
			reason: asString(control.reason) ?? 'Run paused.',
			blocked_action: 'job_control.resume',
			resume_hint: 'Resume the run to continue.',
		};
	}
	if (approval?.pending) {
		return {
			kind: 'approval',
			reason: approval.reason ?? 'Approval is required before continuing.',
			blocked_action: approval.blocked_action ?? null,
			resume_hint: 'Approve the requested tool bundle, then resume the job.',
		};
	}
	if (interrupt) {
		return {
			kind: 'interrupted',
			reason: interruptMessage(interrupt) ?? job.last_error ?? 'The run was interrupted.',
			blocked_action: getManifestSectionHasDispatch(job) ? 'job_control.retry' : null,
			resume_hint: getManifestSectionHasDispatch(job)
				? 'Retry the run to re-dispatch execution, or inspect logs before retrying.'
				: 'Inspect the latest notification or layer logs before deciding the next step.',
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
	if (computeRunAttentionStatus(job) === 'failed') {
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
