import { describe, expect, it } from 'vitest';
import {
	getWorkflowRunDiscoveryCandidate,
	isGitHubReconcileCandidate,
	shouldAttemptWorkingTimeoutRedispatch,
	shouldHandleReviewTimeout,
	shouldHandleWorkingTimeout,
} from '../src/queue-reconcile';
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

describe('queue reconcile helpers', () => {
	it('detects working timeout and review timeout candidates', () => {
		expect(shouldHandleWorkingTimeout(makeJob({ status: 'working', updated_at: '2020-01-01T00:00:00.000Z' }), 1)).toBe(true);
		expect(
			shouldHandleReviewTimeout(
				makeJob({ status: 'review_pending', next_actor: 'reviewer', updated_at: '2020-01-01T00:00:00.000Z' }),
				1,
			),
		).toBe(true);
	});

	it('detects jobs that should reconcile against GitHub', () => {
		expect(isGitHubReconcileCandidate(makeJob({ status: 'working' }))).toBe(true);
		expect(isGitHubReconcileCandidate(makeJob({ status: 'review_pending' }))).toBe(true);
		expect(isGitHubReconcileCandidate(makeJob({ status: 'failed' }))).toBe(false);
		expect(
			isGitHubReconcileCandidate(
				makeJob({
					status: 'working',
					worker_manifest: {
						control: {
							state: 'paused',
						},
					},
				}),
			),
		).toBe(false);
	});

	it('extracts workflow run discovery candidate from dispatch request', () => {
		const candidate = getWorkflowRunDiscoveryCandidate(
			makeJob({
				worker_manifest: {
					dispatch_request: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						workflow_id: 'agent-run.yml',
						ref: 'main',
						inputs: {},
						dispatched_at: '2026-03-21T00:00:00.000Z',
					},
				},
			}),
		);
		expect(candidate).toMatchObject({
			owner: 'iusung111',
			repo: 'OpenGPT',
			workflow_id: 'agent-run.yml',
			ref: 'main',
		});
	});

	it('detects when working timeout can auto redispatch', () => {
		expect(
			shouldAttemptWorkingTimeoutRedispatch(
				makeJob({ auto_improve_enabled: true, auto_improve_cycle: 0, auto_improve_max_cycles: 1 }),
			),
		).toBe(true);
		expect(
			shouldAttemptWorkingTimeoutRedispatch(
				makeJob({ auto_improve_enabled: true, auto_improve_cycle: 1, auto_improve_max_cycles: 1 }),
			),
		).toBe(false);
	});

	it('does not treat paused or cancelled jobs as timeout candidates', () => {
		expect(
			shouldHandleWorkingTimeout(
				makeJob({
					status: 'working',
					updated_at: '2020-01-01T00:00:00.000Z',
					worker_manifest: { control: { state: 'paused' } },
				}),
				1,
			),
		).toBe(false);
		expect(
			shouldHandleReviewTimeout(
				makeJob({
					status: 'review_pending',
					next_actor: 'reviewer',
					updated_at: '2020-01-01T00:00:00.000Z',
					worker_manifest: { control: { state: 'cancelled' } },
				}),
				1,
			),
		).toBe(false);
		expect(
			getWorkflowRunDiscoveryCandidate(
				makeJob({
					worker_manifest: {
						control: { state: 'paused' },
						dispatch_request: {
							owner: 'iusung111',
							repo: 'OpenGPT',
							workflow_id: 'agent-run.yml',
							ref: 'main',
							inputs: {},
							dispatched_at: '2026-03-21T00:00:00.000Z',
						},
					},
				}),
			),
		).toBeNull();
	});
});

