import { JobRecord } from './contracts';
import { pushJobNote, transitionJob } from './queue-state';

export interface PullRequestEventPayload {
	number?: number;
	head?: { ref?: string };
	body?: string;
	state?: string;
}

export function applyPullRequestEventToJob(
	job: JobRecord,
	pr: PullRequestEventPayload,
	timestamp: string,
	allowTransition = true,
): void {
	job.last_webhook_event_at = timestamp;
	if (pr.number && job.pr_number !== pr.number) {
		job.pr_number = pr.number;
		pushJobNote(job, `linked PR #${pr.number}`);
	}
	if (pr.head?.ref && pr.head.ref !== job.work_branch) {
		job.work_branch = pr.head.ref;
	}
	if (allowTransition && pr.state === 'open' && (job.status === 'queued' || job.status === 'working')) {
		transitionJob(job, 'review_pending', 'reviewer');
	}
	job.updated_at = timestamp;
}

