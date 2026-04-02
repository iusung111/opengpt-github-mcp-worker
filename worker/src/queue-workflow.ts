import { JobRecord, JobStatus, NextActor } from './contracts';
import { isDryRunJob, pushJobNote, recordWorkflowSnapshot, transitionJob, WorkflowRunSnapshot } from './queue-state';

export interface CompletedWorkflowRunDecision {
	shouldAutoRedispatch: boolean;
	redispatchReason?: string;
	lastError?: string;
	transition?: {
		status: JobStatus;
		nextActor: NextActor;
	};
}

export function decideCompletedWorkflowRun(
	job: JobRecord,
	run: WorkflowRunSnapshot,
	source: 'webhook' | 'reconcile',
): CompletedWorkflowRunDecision {
	if (run.conclusion === 'success' && (isDryRunJob(job) || job.pr_number)) {
		return {
			shouldAutoRedispatch: false,
			transition: {
				status: 'review_pending',
				nextActor: 'reviewer',
			},
		};
	}
	if (run.conclusion === 'success') {
		return {
			shouldAutoRedispatch: false,
		};
	}
	if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
		return {
			shouldAutoRedispatch: true,
			redispatchReason: source === 'webhook' ? 'webhook reported failure' : 'github run reconciliation failure',
		};
	}
	return {
		shouldAutoRedispatch: false,
		transition: {
			status: 'failed',
			nextActor: 'system',
		},
		lastError:
			source === 'webhook'
				? `${run.name ?? 'workflow'} failed (webhook)`
				: `${run.name ?? 'workflow'} concluded with ${run.conclusion ?? 'unknown'}`,
	};
}

export function applyCompletedWorkflowRunDecision(
	job: JobRecord,
	run: WorkflowRunSnapshot,
	decision: CompletedWorkflowRunDecision,
): void {
	recordWorkflowSnapshot(job, run);
	if (decision.transition) {
		transitionJob(job, decision.transition.status, decision.transition.nextActor);
	} else if (run.conclusion === 'success') {
		pushJobNote(job, 'workflow completed successfully; awaiting PR linkage');
	}
	if (decision.lastError !== undefined) {
		job.last_error = decision.lastError;
	}
}

