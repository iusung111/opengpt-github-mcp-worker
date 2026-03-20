import { JobRecord, JobStatus, NextActor } from './types';

export interface JobIndexPointer {
	job_id: string;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

export function jobRunIndexKey(repo: string, runId: number): string {
	return `idx:run:${encodeSegment(repo)}:${runId}`;
}

export function jobBranchIndexKey(repo: string, branch: string): string {
	return `idx:branch:${encodeSegment(repo)}:${encodeSegment(branch)}`;
}

export function jobBranchIndexPrefix(repo: string): string {
	return `idx:branch:${encodeSegment(repo)}:`;
}

export function jobStatusIndexKey(status: JobStatus, nextActor: NextActor, jobId: string): string {
	return `idx:status:${status}:${nextActor}:${encodeSegment(jobId)}`;
}

export function jobStatusIndexPrefix(status?: JobStatus, nextActor?: NextActor): string {
	if (status && nextActor) {
		return `idx:status:${status}:${nextActor}:`;
	}
	if (status) {
		return `idx:status:${status}:`;
	}
	if (nextActor) {
		return `idx:actor:${nextActor}:`;
	}
	return 'idx:status:';
}

export function jobActorIndexKey(nextActor: NextActor, jobId: string): string {
	return `idx:actor:${nextActor}:${encodeSegment(jobId)}`;
}

export function buildJobIndexEntries(job: JobRecord): Array<[string, JobIndexPointer]> {
	const pointer = { job_id: job.job_id };
	const entries: Array<[string, JobIndexPointer]> = [
		[jobStatusIndexKey(job.status, job.next_actor, job.job_id), pointer],
		[jobActorIndexKey(job.next_actor, job.job_id), pointer],
	];
	if (job.workflow_run_id) {
		entries.push([jobRunIndexKey(job.repo, job.workflow_run_id), pointer]);
	}
	if (job.work_branch) {
		entries.push([jobBranchIndexKey(job.repo, job.work_branch), pointer]);
	}
	return entries;
}
