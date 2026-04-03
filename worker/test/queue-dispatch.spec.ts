import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/github', () => ({
	githubAuthConfigured: vi.fn(() => true),
}));

vi.mock('../src/utils', () => ({
	buildDispatchFingerprint: vi.fn(async () => 'fp-1'),
	githubPost: vi.fn(async () => ({})),
	nowIso: vi.fn(() => '2026-03-21T00:00:10.000Z'),
}));

import { autoRedispatchJob } from '../src/queue-dispatch';
import { githubAuthConfigured } from '../src/github';
import { buildDispatchFingerprint, githubPost } from '../src/utils';
import { JobRecord } from '../src/contracts';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-1',
		repo: 'iusung111/OpenGPT',
		base_branch: 'main',
		target_paths: [],
		status: 'working',
		next_actor: 'system',
		auto_improve_enabled: true,
		auto_improve_max_cycles: 3,
		auto_improve_cycle: 1,
		worker_manifest: {
			dispatch_request: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'agent-run.yml',
				ref: 'main',
				inputs: { job_id: 'job-1' },
				dispatched_at: '2026-03-21T00:00:00.000Z',
			},
		},
		review_findings: [],
		notes: [],
		created_at: '2026-03-21T00:00:00.000Z',
		last_transition_at: '2026-03-21T00:00:00.000Z',
		updated_at: '2026-03-21T00:00:00.000Z',
		...overrides,
	};
}

describe('queue dispatch helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns false when no dispatch request is present', async () => {
		const job = makeJob({ worker_manifest: {} });

		await expect(autoRedispatchJob({ env: {} as never }, job, 'retry')).resolves.toBe(false);
		expect(githubPost).not.toHaveBeenCalled();
	});

	it('does not redispatch paused or cancelled jobs', async () => {
		const pausedJob = makeJob({
			worker_manifest: {
				control: {
					state: 'paused',
				},
				dispatch_request: {
					owner: 'iusung111',
					repo: 'OpenGPT',
					workflow_id: 'agent-run.yml',
					ref: 'main',
					inputs: { job_id: 'job-1' },
					dispatched_at: '2026-03-21T00:00:00.000Z',
				},
			},
		});
		const cancelledJob = makeJob({
			worker_manifest: {
				control: {
					state: 'cancelled',
				},
				dispatch_request: {
					owner: 'iusung111',
					repo: 'OpenGPT',
					workflow_id: 'agent-run.yml',
					ref: 'main',
					inputs: { job_id: 'job-1' },
					dispatched_at: '2026-03-21T00:00:00.000Z',
				},
			},
		});

		await expect(autoRedispatchJob({ env: {} as never }, pausedJob, 'retry')).resolves.toBe(false);
		await expect(autoRedispatchJob({ env: {} as never }, cancelledJob, 'retry')).resolves.toBe(false);
		expect(githubPost).not.toHaveBeenCalled();
	});

	it('re-dispatches the workflow and rewrites job state', async () => {
		const job = makeJob({
			workflow_run_id: 123,
			last_error: 'old',
			stale_reason: 'working_timeout',
			notes: ['existing'],
		});

		await expect(autoRedispatchJob({ env: {} as never }, job, 'retry')).resolves.toBe(true);

		expect(githubAuthConfigured).toHaveBeenCalled();
		expect(buildDispatchFingerprint).toHaveBeenCalled();
		expect(githubPost).toHaveBeenCalledWith(
			expect.anything(),
			'/repos/iusung111/Project_OpenGPT/actions/workflows/agent-run.yml/dispatches',
			{
				ref: 'main',
				inputs: { job_id: 'job-1' },
			},
		);
		expect(job.workflow_run_id).toBeUndefined();
		expect(job.last_error).toBeUndefined();
		expect(job.stale_reason).toBeUndefined();
		expect(job.notes.at(-1)).toBe('auto redispatch triggered: retry');
		expect(job.worker_manifest).toMatchObject({
			control: {
				state: 'active',
				resume_strategy: 'redispatch',
				last_interrupt: null,
			},
			dispatch_request: {
				fingerprint: 'fp-1',
				dispatched_at: '2026-03-21T00:00:10.000Z',
			},
			last_workflow_run: {
				status: 'queued',
				conclusion: null,
			},
		});
	});
});

