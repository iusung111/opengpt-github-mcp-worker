import { DispatchRequestRecord, JobControlManifest, JobInterruptRecord, JobRecord, JobStatus, NextActor } from './types';
import { getManifestDispatchRequest, normalizeWorkerManifest, setManifestWorkflowRun } from './job-manifest';

export interface WorkflowRunSnapshot {
	name?: string;
	status?: string;
	conclusion?: string;
	html_url?: string;
}

export function transitionJob(job: JobRecord, status: JobStatus, nextActor: NextActor): void {
	if (job.status !== status || job.next_actor !== nextActor) {
		job.status = status;
		job.next_actor = nextActor;
		job.last_transition_at = new Date().toISOString();
		return;
	}
	job.status = status;
	job.next_actor = nextActor;
}

export function pushJobNote(job: JobRecord, note: string): void {
	if (!job.notes.includes(note)) {
		job.notes.push(note);
	}
}

export function getDispatchRequest(job: JobRecord): DispatchRequestRecord | null {
	return getManifestDispatchRequest(job.worker_manifest);
}

export function getControlState(job: JobRecord): JobControlManifest | null {
	const control = normalizeWorkerManifest(job.worker_manifest).control;
	return control && typeof control === 'object' ? control : null;
}

export function getLastInterrupt(job: JobRecord): JobInterruptRecord | null {
	const control = getControlState(job);
	return control?.last_interrupt ?? null;
}

export function isJobPaused(job: JobRecord): boolean {
	return getControlState(job)?.state === 'paused';
}

export function isJobCancelled(job: JobRecord): boolean {
	return getControlState(job)?.state === 'cancelled';
}

export function canAdvanceJob(job: JobRecord): boolean {
	return !isJobPaused(job) && !isJobCancelled(job);
}

export function hasExecutionRelatedInterrupt(job: JobRecord): boolean {
	const kind = getLastInterrupt(job)?.kind;
	return kind === 'workflow_cancelled' || kind === 'workflow_timed_out' || kind === 'stale_reconcile';
}

export function isDryRunJob(job: JobRecord): boolean {
	const dispatchRequest = getDispatchRequest(job);
	const rawDryRun = dispatchRequest?.inputs?.dry_run;
	return rawDryRun === true || rawDryRun === 'true';
}

export function isSmokeTraceJob(job: JobRecord): boolean {
	if (!/^smoke-[A-Za-z0-9._-]+$/i.test(job.job_id)) {
		return false;
	}
	if (job.target_paths.length === 0) {
		return false;
	}
	return job.target_paths.every((path) => /^notes\/smoke-[A-Za-z0-9._-]+\.txt$/i.test(String(path)));
}

export function recordWorkflowSnapshot(job: JobRecord, run: WorkflowRunSnapshot): void {
	job.worker_manifest = setManifestWorkflowRun(job.worker_manifest, {
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
		html_url: run.html_url,
		run_id: job.workflow_run_id ?? null,
		updated_at: new Date().toISOString(),
	});
}
