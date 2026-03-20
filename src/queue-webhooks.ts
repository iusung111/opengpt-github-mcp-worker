import { JobRecord } from './types';
import { branchMatchScore, parseJobIdFromPrBody } from './queue-helpers';
import { JobIndexPointer, jobBranchIndexKey, jobRunIndexKey } from './queue-index';
import { applyPullRequestEventToJob } from './queue-events';
import { applyCompletedWorkflowRunDecision, decideCompletedWorkflowRun } from './queue-workflow';
import { recordWorkflowSnapshot, transitionJob } from './queue-state';
import { nowIso } from './utils';

export interface QueueWebhookContext {
	ensureJobIndexes(): Promise<void>;
	getJob(jobId: string): Promise<JobRecord | null>;
	findJob(
		matcher: (job: JobRecord) => boolean,
		options?: { reconcile?: boolean },
	): Promise<JobRecord | null>;
	storageGetIndex<T>(key: string): Promise<T | null>;
	storageListJobs(): Promise<JobRecord[]>;
	persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void>;
	autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean>;
}

type GitHubEventOutcome = {
	matched: boolean;
	job_id?: string;
	status?: string;
	next_actor?: string;
	pr_number?: number;
	work_branch?: string;
	delivery_id?: string;
	duplicate?: boolean;
};

export async function findByRepoAndBranch(
	context: QueueWebhookContext,
	repo: string,
	workBranch?: string,
): Promise<JobRecord | null> {
	if (!workBranch) {
		return null;
	}
	await context.ensureJobIndexes();
	const indexedPointer = await context.storageGetIndex<JobIndexPointer>(jobBranchIndexKey(repo, workBranch));
	if (indexedPointer?.job_id) {
		const indexedJob = await context.getJob(indexedPointer.job_id);
		if (indexedJob?.repo === repo) {
			return indexedJob;
		}
	}
	const jobs = await context.storageListJobs();
	let bestMatch: { job: JobRecord; score: number; matchedLength: number } | null = null;
	for (const job of jobs) {
		if (job.repo !== repo) {
			continue;
		}
		const score = branchMatchScore(workBranch, job);
		if (score === 0) {
			continue;
		}
		const matchedLength = Math.max(job.work_branch?.length ?? 0, job.job_id.length);
		if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && matchedLength > bestMatch.matchedLength)) {
			bestMatch = { job, score, matchedLength };
		}
	}
	return bestMatch?.job ?? null;
}

export async function findByRepoAndRun(
	context: QueueWebhookContext,
	repo: string,
	runId?: number,
): Promise<JobRecord | null> {
	if (!runId) {
		return null;
	}
	await context.ensureJobIndexes();
	const indexedPointer = await context.storageGetIndex<JobIndexPointer>(jobRunIndexKey(repo, runId));
	if (indexedPointer?.job_id) {
		const indexedJob = await context.getJob(indexedPointer.job_id);
		if (indexedJob?.repo === repo && indexedJob.workflow_run_id === runId) {
			return indexedJob;
		}
	}
	return context.findJob((job) => job.repo === repo && job.workflow_run_id === runId, { reconcile: false });
}

export async function findByRepoAndJobId(
	context: QueueWebhookContext,
	repo: string,
	jobId?: string | null,
): Promise<JobRecord | null> {
	if (!jobId) {
		return null;
	}
	const job = await context.getJob(jobId);
	return job?.repo === repo ? job : null;
}

export async function applyGithubEvent(
	context: QueueWebhookContext,
	payload: Record<string, unknown>,
): Promise<GitHubEventOutcome> {
	if (!payload.repository || typeof payload.repository !== 'object') {
		return { matched: false };
	}
	const repoFullName = (payload.repository as { full_name?: string }).full_name;
	if (!repoFullName) {
		return { matched: false };
	}

	if (payload.action === 'completed' && payload.workflow_run) {
		const run = payload.workflow_run as
			| {
					id?: number;
					head_branch?: string;
					status?: string;
					conclusion?: string;
					html_url?: string;
			  }
			| null;
		if (!run?.id) {
			return { matched: false };
		}
		const job =
			(await findByRepoAndRun(context, repoFullName, run.id)) ??
			(await findByRepoAndBranch(context, repoFullName, run.head_branch));
		if (job) {
			const previous = structuredClone(job);
			job.last_webhook_event_at = nowIso();
			job.workflow_run_id = run.id;
			if (run.status === 'completed') {
				const decision = decideCompletedWorkflowRun(job, run, 'webhook');
				applyCompletedWorkflowRunDecision(job, run, decision);
				if (decision.shouldAutoRedispatch) {
					job.auto_improve_cycle += 1;
					const redispatched = await context.autoRedispatchJob(
						job,
						decision.redispatchReason ?? 'webhook reported failure',
					);
					if (!redispatched) {
						transitionJob(job, 'rework_pending', 'worker');
					}
				}
				job.stale_reason = undefined;
			} else {
				recordWorkflowSnapshot(job, run);
			}
			job.updated_at = nowIso();
			await context.persistJob(job, previous);
			return {
				matched: true,
				job_id: job.job_id,
				status: job.status,
				next_actor: job.next_actor,
			};
		}
	}

	if (payload.pull_request) {
		const pr = payload.pull_request as
			| {
					number?: number;
					head?: { ref?: string };
					body?: string;
					state?: string;
			  }
			| null;
		if (pr?.head?.ref) {
			const hintedJobId = parseJobIdFromPrBody(pr.body);
			const job =
				(await findByRepoAndJobId(context, repoFullName, hintedJobId)) ??
				(await findByRepoAndBranch(context, repoFullName, pr.head.ref));
			if (job) {
				const previous = structuredClone(job);
				applyPullRequestEventToJob(job, pr, nowIso());
				await context.persistJob(job, previous);
				return {
					matched: true,
					job_id: job.job_id,
					status: job.status,
					next_actor: job.next_actor,
					pr_number: job.pr_number,
					work_branch: job.work_branch,
				};
			}
		}
	}

	return { matched: false };
}
