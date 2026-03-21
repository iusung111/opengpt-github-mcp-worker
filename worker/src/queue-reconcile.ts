import { githubAuthConfigured } from './github';
import { JobRecord } from './types';
import { findLatestWorkflowRunId, getWorkflowRunSnapshot } from './queue-github';
import { getDispatchRequest, recordWorkflowSnapshot, transitionJob } from './queue-state';
import { applyCompletedWorkflowRunDecision, decideCompletedWorkflowRun } from './queue-workflow';
import { isOlderThan, repoAllowed } from './utils';

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

export interface QueueReconcileContext {
	env: Parameters<typeof githubAuthConfigured>[0];
	persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void>;
	markJobStale(job: JobRecord, reason: string, note: string): Promise<boolean>;
	autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean>;
}

export async function handleWorkingTimeoutReconcile(
	context: QueueReconcileContext,
	job: JobRecord,
	workingStaleAfterMs: number,
): Promise<boolean> {
	if (!shouldHandleWorkingTimeout(job, workingStaleAfterMs)) {
		return false;
	}
	const previous = structuredClone(job);
	const staleChanged = job.stale_reason !== 'working_timeout';
	job.stale_reason = 'working_timeout';
	if (githubAuthConfigured(context.env) && repoAllowed(context.env, job.repo)) {
		if (getDispatchRequest(job) && shouldAttemptWorkingTimeoutRedispatch(job)) {
			job.auto_improve_cycle += 1;
			const redispatched = await context.autoRedispatchJob(job, 'working job stale without workflow run');
			if (!redispatched) {
				transitionJob(job, 'rework_pending', 'worker');
			}
		} else {
			transitionJob(job, 'rework_pending', 'worker');
		}
	} else {
		transitionJob(job, 'rework_pending', 'worker');
	}
	job.updated_at = new Date().toISOString();
	await context.persistJob(job, previous);
	if (staleChanged) {
		await context.markJobStale(
			job,
			'working_timeout',
			'working job exceeded stale threshold without a linked workflow run',
		);
	}
	return true;
}

export async function reconcileGitHubRunState(
	context: QueueReconcileContext,
	job: JobRecord,
): Promise<boolean> {
	if (!githubAuthConfigured(context.env) || !repoAllowed(context.env, job.repo) || !isGitHubReconcileCandidate(job)) {
		return false;
	}
	const runCandidate = getWorkflowRunDiscoveryCandidate(job);
	if (!job.workflow_run_id && runCandidate) {
		try {
			const discoveredRun = await findLatestWorkflowRunId(
				context.env,
				runCandidate.owner,
				runCandidate.repo,
				runCandidate.workflow_id,
				runCandidate.ref,
				runCandidate.dispatched_at,
				1,
				0,
			);
			if (discoveredRun?.id) {
				job.workflow_run_id = discoveredRun.id;
			}
		} catch {
			return true;
		}
	}
	if (!job.workflow_run_id) {
		return false;
	}
	let run;
	try {
		run = await getWorkflowRunSnapshot(context.env, job.repo, job.workflow_run_id);
	} catch {
		return true;
	}
	if (!run) {
		return true;
	}
	if (run.status === 'completed') {
		const previous = structuredClone(job);
		const decision = decideCompletedWorkflowRun(job, run, 'reconcile');
		applyCompletedWorkflowRunDecision(job, run, decision);
		if (decision.shouldAutoRedispatch) {
			job.auto_improve_cycle += 1;
			const redispatched = await context.autoRedispatchJob(
				job,
				decision.redispatchReason ?? 'github run reconciliation failure',
			);
			if (!redispatched) {
				transitionJob(job, 'rework_pending', 'worker');
			}
		}
		job.stale_reason = undefined;
		job.updated_at = new Date().toISOString();
		await context.persistJob(job, previous);
	} else {
		recordWorkflowSnapshot(job, run);
	}
	return true;
}
