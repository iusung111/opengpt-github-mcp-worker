import { DispatchRequestRecord, JobRecord, JobStatus, NextActor } from './types';
import { getManifestDispatchRequest, setManifestWorkflowRun } from './job-manifest';

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

export function isDryRunJob(job: JobRecord): boolean {
	const dispatchRequest = getDispatchRequest(job);
	const rawDryRun = dispatchRequest?.inputs?.dry_run;
	return rawDryRun === true || rawDryRun === 'true';
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
