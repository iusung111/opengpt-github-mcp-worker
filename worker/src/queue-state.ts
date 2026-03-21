import { DispatchRequestRecord, JobRecord, JobStatus, NextActor } from './types';

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
	const raw = (job.worker_manifest.dispatch_request ?? null) as Partial<DispatchRequestRecord> | null;
	if (!raw?.owner || !raw.repo || !raw.workflow_id || !raw.ref || !raw.dispatched_at) {
		return null;
	}
	return {
		owner: raw.owner,
		repo: raw.repo,
		workflow_id: raw.workflow_id,
		ref: raw.ref,
		inputs: raw.inputs ?? {},
		fingerprint: raw.fingerprint,
		dispatched_at: raw.dispatched_at,
	};
}

export function isDryRunJob(job: JobRecord): boolean {
	const dispatchRequest = getDispatchRequest(job);
	const rawDryRun = dispatchRequest?.inputs?.dry_run;
	return rawDryRun === true || rawDryRun === 'true';
}

export function recordWorkflowSnapshot(job: JobRecord, run: WorkflowRunSnapshot): void {
	job.worker_manifest = {
		...job.worker_manifest,
		last_workflow_run: {
			name: run.name,
			status: run.status,
			conclusion: run.conclusion,
			html_url: run.html_url,
		},
	};
}
