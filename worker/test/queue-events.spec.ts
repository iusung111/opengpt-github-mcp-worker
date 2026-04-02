import { describe, expect, it } from 'vitest';
import { applyPullRequestEventToJob } from '../src/queue-events';
import { JobRecord } from '../src/contracts';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-1',
		repo: 'iusung111/OpenGPT',
		base_branch: 'main',
		target_paths: [],
		status: 'working',
		next_actor: 'system',
		auto_improve_enabled: false,
		auto_improve_max_cycles: 3,
		auto_improve_cycle: 0,
		worker_manifest: {},
		review_findings: [],
		notes: [],
		created_at: '2026-03-21T00:00:00.000Z',
		last_transition_at: '2026-03-21T00:00:00.000Z',
		updated_at: '2026-03-21T00:00:00.000Z',
		...overrides,
	};
}

describe('queue event helpers', () => {
	it('links PR metadata and promotes active jobs to review_pending', () => {
		const job = makeJob();
		applyPullRequestEventToJob(
			job,
			{
				number: 42,
				state: 'open',
				head: { ref: 'agent/project-task-timer-job-1-101' },
			},
			'2026-03-21T01:00:00.000Z',
		);
		expect(job.pr_number).toBe(42);
		expect(job.work_branch).toBe('agent/project-task-timer-job-1-101');
		expect(job.status).toBe('review_pending');
		expect(job.next_actor).toBe('reviewer');
		expect(job.notes).toContain('linked PR #42');
		expect(job.last_webhook_event_at).toBe('2026-03-21T01:00:00.000Z');
	});

	it('does not append duplicate PR note when PR number is already linked', () => {
		const job = makeJob({ pr_number: 7, notes: ['linked PR #7'] });
		applyPullRequestEventToJob(
			job,
			{
				number: 7,
				state: 'open',
				head: { ref: 'agent/project-task-timer-job-1-101' },
			},
			'2026-03-21T01:00:00.000Z',
		);
		expect(job.notes).toEqual(['linked PR #7']);
	});
});

