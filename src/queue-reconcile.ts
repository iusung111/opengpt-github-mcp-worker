import { JobRecord } from './types';
import { getDispatchRequest } from './queue-state';
import { isOlderThan } from './utils';

export interface WorkflowRunCandidate {
	owner: string;
	repo: string;
	workflow_id: string;
	ref: string;
	dispatched_at: string;
}

export function shouldHandleWorkingTimeout(job: JobRecord, workingStaleAfterMs: number): boolean {
	return job.status === 'working' && !job.workflow_run_id && isOlderThan(job.updated_at, workingStaleAfterMs);
}

export function shouldHandleReviewTimeout(job: JobRecord, reviewStaleAfterMs: number): boolean {
	return job.status === 'review_pending' && isOlderThan(job.updated_at, reviewStaleAfterMs);
}

export function isGitHubReconcileCandidate(job: JobRecord): boolean {
	return job.status === 'working' || job.status === 'review_pending';
}

export function getWorkflowRunDiscoveryCandidate(job: JobRecord): WorkflowRunCandidate | null {
	const dispatchRequest = getDispatchRequest(job);
	if (!dispatchRequest) {
		return null;
	}
	return {
		owner: dispatchRequest.owner,
		repo: dispatchRequest.repo,
		workflow_id: dispatchRequest.workflow_id,
		ref: dispatchRequest.ref,
		dispatched_at: dispatchRequest.dispatched_at,
	};
}

export function shouldAttemptWorkingTimeoutRedispatch(job: JobRecord): boolean {
	return job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles;
}
