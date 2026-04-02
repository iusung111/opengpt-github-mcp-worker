import { JobRecord, JobStatus, NextActor } from './contracts';

export interface JobIndexPointer {
	job_id: string;
}

export function jobIndexReadyKey(): string {
	return 'meta:indexes:jobs:v1';
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

export function jobRunIndexKey(repo: string, runId: number): string {
	return `idx:run:${encodeSegment(repo)}:${runId}`;
}

export function jobAllIndexKey(jobId: string): string {
	return `idx:job:${encodeSegment(jobId)}`;
}

export function jobAllIndexPrefix(): string {
	return 'idx:job:';
}

export function jobRepoIndexKey(repo: string, jobId: string): string {
	return `idx:repo:${encodeSegment(repo)}:${encodeSegment(jobId)}`;
}

export function jobRepoIndexPrefix(repo?: string): string {
	return repo ? `idx:repo:${encodeSegment(repo)}:` : 'idx:repo:';
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

export function jobPrIndexKey(repo: string, prNumber: number): string {
	return `idx:pr:${encodeSegment(repo)}:${prNumber}`;
}

export function jobActiveIndexKey(jobId: string): string {
	return `idx:active:${encodeSegment(jobId)}`;
}

export function jobActiveIndexPrefix(): string {
	return 'idx:active:';
}

export function jobStaleIndexKey(jobId: string): string {
	return `idx:stale:${encodeSegment(jobId)}`;
}

export function jobStaleIndexPrefix(): string {
	return 'idx:stale:';
}

export function buildJobIndexEntries(job: JobRecord): Array<[string, JobIndexPointer]> {
	const pointer = { job_id: job.job_id };
	const entries: Array<[string, JobIndexPointer]> = [
		[jobAllIndexKey(job.job_id), pointer],
		[jobRepoIndexKey(job.repo, job.job_id), pointer],
		[jobStatusIndexKey(job.status, job.next_actor, job.job_id), pointer],
		[jobActorIndexKey(job.next_actor, job.job_id), pointer],
	];
	if (job.workflow_run_id) {
		entries.push([jobRunIndexKey(job.repo, job.workflow_run_id), pointer]);
	}
	if (job.work_branch) {
		entries.push([jobBranchIndexKey(job.repo, job.work_branch), pointer]);
	}
	if (job.pr_number) {
		entries.push([jobPrIndexKey(job.repo, job.pr_number), pointer]);
	}
	if (job.status !== 'done' && job.status !== 'failed') {
		entries.push([jobActiveIndexKey(job.job_id), pointer]);
	}
	if (job.stale_reason) {
		entries.push([jobStaleIndexKey(job.job_id), pointer]);
	}
	return entries;
}

