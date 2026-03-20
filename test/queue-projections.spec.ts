import { describe, expect, it } from 'vitest';
import { buildJobAudit, buildJobProgressSnapshot } from '../src/queue-projections';
import { AuditRecord, JobRecord } from '../src/types';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		job_id: 'job-1',
		repo: 'iusung111/OpenGPT',
		base_branch: 'main',
		target_paths: [],
		status: 'review_pending',
		next_actor: 'reviewer',
		auto_improve_enabled: true,
		auto_improve_max_cycles: 3,
		auto_improve_cycle: 1,
		worker_manifest: {},
		review_findings: [],
		notes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
		created_at: '2026-03-21T00:00:00.000Z',
		last_transition_at: '2026-03-21T00:00:01.000Z',
		last_reconciled_at: '2026-03-21T00:00:02.000Z',
		last_webhook_event_at: '2026-03-21T00:00:03.000Z',
		updated_at: '2026-03-21T00:00:04.000Z',
		stale_reason: 'review_timeout',
		...overrides,
	};
}

describe('queue projection helpers', () => {
	it('builds a compact job progress snapshot', () => {
		const job = makeJob();
		const audits: AuditRecord[] = [
			{ event_type: 'job_create', payload: { job_id: 'job-1' }, created_at: '2026-03-21T00:00:00.000Z' },
		];

		const snapshot = buildJobProgressSnapshot(job, audits);

		expect(snapshot).toMatchObject({
			job_id: 'job-1',
			status: 'review_pending',
			next_actor: 'reviewer',
			latest_note: 'n6',
			recent_notes: ['n2', 'n3', 'n4', 'n5', 'n6'],
			recent_audits: audits,
			stale_reason: 'review_timeout',
		});
	});

	it('builds an audit payload with extra fields merged in', () => {
		const payload = buildJobAudit(makeJob(), { reason: 'manual' });

		expect(payload).toMatchObject({
			job_id: 'job-1',
			repo: 'iusung111/OpenGPT',
			status: 'review_pending',
			next_actor: 'reviewer',
			auto_improve_cycle: 1,
			stale_reason: 'review_timeout',
			reason: 'manual',
		});
	});
});
