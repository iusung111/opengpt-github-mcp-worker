import { describe, expect, it } from 'vitest';
import {
	buildJobIndexEntries,
	jobActiveIndexKey,
	jobActorIndexKey,
	jobAllIndexKey,
	jobBranchIndexKey,
	jobPrIndexKey,
	jobRepoIndexKey,
	jobRunIndexKey,
	jobStaleIndexKey,
	jobStatusIndexKey,
	jobStatusIndexPrefix,
} from '../src/queue-index';
import { JobRecord } from '../src/types';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-1',
		repo: 'iusung111/OpenGPT',
		base_branch: 'main',
		work_branch: 'agent/project-task-timer-job-1-101',
		workflow_run_id: 101,
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

describe('queue index helpers', () => {
	it('builds exact keys for run, branch, status, and actor lookups', () => {
		const job = makeJob();
		expect(buildJobIndexEntries(job)).toEqual(
			expect.arrayContaining([
				[jobStatusIndexKey('working', 'system', 'job-1'), { job_id: 'job-1' }],
				[jobActorIndexKey('system', 'job-1'), { job_id: 'job-1' }],
				[jobAllIndexKey('job-1'), { job_id: 'job-1' }],
				[jobRepoIndexKey('iusung111/OpenGPT', 'job-1'), { job_id: 'job-1' }],
				[jobRunIndexKey('iusung111/OpenGPT', 101), { job_id: 'job-1' }],
				[jobBranchIndexKey('iusung111/OpenGPT', 'agent/project-task-timer-job-1-101'), { job_id: 'job-1' }],
				[jobActiveIndexKey('job-1'), { job_id: 'job-1' }],
			]),
		);
	});

	it('indexes pr and stale jobs when present', () => {
		const job = makeJob({
			pr_number: 29,
			stale_reason: 'review_timeout',
		});
		expect(buildJobIndexEntries(job)).toEqual(
			expect.arrayContaining([
				[jobPrIndexKey('iusung111/OpenGPT', 29), { job_id: 'job-1' }],
				[jobStaleIndexKey('job-1'), { job_id: 'job-1' }],
			]),
		);
	});

	it('builds status prefixes for filtered job listing', () => {
		expect(jobStatusIndexPrefix('working', 'system')).toBe('idx:status:working:system:');
		expect(jobStatusIndexPrefix('queued')).toBe('idx:status:queued:');
		expect(jobStatusIndexPrefix(undefined, 'worker')).toBe('idx:actor:worker:');
	});
});
