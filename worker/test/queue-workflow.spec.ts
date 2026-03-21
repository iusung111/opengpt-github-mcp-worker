import { describe, expect, it } from 'vitest';
import { applyCompletedWorkflowRunDecision, decideCompletedWorkflowRun } from '../src/queue-workflow';
import { JobRecord } from '../src/types';

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

describe('queue workflow helpers', () => {
	it('promotes successful jobs with PR linkage to review_pending', () => {
		const job = makeJob({ pr_number: 12 });
		const decision = decideCompletedWorkflowRun(
			job,
			{ name: 'agent-run', status: 'completed', conclusion: 'success' },
			'webhook',
		);
		applyCompletedWorkflowRunDecision(job, { name: 'agent-run', status: 'completed', conclusion: 'success' }, decision);
		expect(decision.shouldAutoRedispatch).toBe(false);
		expect(job.status).toBe('review_pending');
		expect(job.next_actor).toBe('reviewer');
	});

	it('requests auto redispatch for failed auto-improve jobs', () => {
		const job = makeJob({
			auto_improve_enabled: true,
			auto_improve_cycle: 0,
			auto_improve_max_cycles: 2,
		});
		const decision = decideCompletedWorkflowRun(
			job,
			{ name: 'agent-run', status: 'completed', conclusion: 'failure' },
			'reconcile',
		);
		expect(decision).toMatchObject({
			shouldAutoRedispatch: true,
			redispatchReason: 'github run reconciliation failure',
		});
	});

	it('marks exhausted jobs failed with source-specific error text', () => {
		const job = makeJob();
		const decision = decideCompletedWorkflowRun(
			job,
			{ name: 'agent-run', status: 'completed', conclusion: 'cancelled' },
			'reconcile',
		);
		applyCompletedWorkflowRunDecision(job, { name: 'agent-run', status: 'completed', conclusion: 'cancelled' }, decision);
		expect(job.status).toBe('failed');
		expect(job.next_actor).toBe('system');
		expect(job.last_error).toBe('agent-run concluded with cancelled');
	});

	it('adds a waiting note for successful jobs that still need PR linkage', () => {
		const job = makeJob();
		const decision = decideCompletedWorkflowRun(
			job,
			{ name: 'agent-run', status: 'completed', conclusion: 'success' },
			'webhook',
		);
		applyCompletedWorkflowRunDecision(job, { name: 'agent-run', status: 'completed', conclusion: 'success' }, decision);
		expect(job.notes).toContain('workflow completed successfully; awaiting PR linkage');
	});
});
