import { describe, expect, it } from 'vitest';
import {
	buildBlockingState,
	buildJobAudit,
	buildJobEventFeed,
	buildJobProgressSnapshot,
	buildRunSummary,
	computeRunAttentionStatus,
} from '../src/queue-projections';
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
			run_summary: {
				run_id: 'job-1',
				status: 'idle',
			},
			blocking_state: {
				kind: 'review',
				blocked_action: 'submit_review',
			},
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

	it('maps approval-pending state into run summary and blocking state', () => {
		const job = makeJob({
			status: 'queued',
			next_actor: 'worker',
			worker_manifest: {
				attention: {
					approval: {
						pending: true,
						reason: 'Need approval for workflow dispatch',
						blocked_action: 'workflow_dispatch',
					},
				},
			},
		});

		expect(computeRunAttentionStatus(job)).toBe('pending_approval');
		expect(buildBlockingState(job)).toMatchObject({
			kind: 'approval',
			reason: 'Need approval for workflow dispatch',
			blocked_action: 'workflow_dispatch',
		});
		expect(buildRunSummary(job, [])).toMatchObject({
			run_id: 'job-1',
			status: 'pending_approval',
			approval_reason: 'Need approval for workflow dispatch',
		});
	});

	it('derives notification feed items with dedupe and source layers', () => {
		const job = makeJob({
			status: 'working',
			next_actor: 'system',
			workflow_run_id: 123,
			worker_manifest: {
				preview: {
					status: 'ready',
					preview_id: 'preview-1',
				},
			},
		});
		const audits: AuditRecord[] = [
			{
				event_type: 'job_manifest_notification',
				payload: {
					section: 'preview',
					section_status: 'ready',
					source_layer: 'cloudflare',
					attention_status: 'running',
					message: 'preview is ready.',
					dedupe_key: 'preview-ready',
				},
				created_at: '2026-03-21T00:00:05.000Z',
			},
			{
				event_type: 'job_manifest_notification',
				payload: {
					section: 'preview',
					section_status: 'ready',
					source_layer: 'cloudflare',
					attention_status: 'running',
					message: 'preview is ready.',
					dedupe_key: 'preview-ready',
				},
				created_at: '2026-03-21T00:00:06.000Z',
			},
			{
				event_type: 'job_attention_approval_requested',
				payload: {
					source_layer: 'gpt',
					attention_status: 'pending_approval',
					reason: 'Need approval',
					blocked_action: 'repo_create_branch',
				},
				created_at: '2026-03-21T00:00:04.000Z',
			},
		];

		const feed = buildJobEventFeed(job, audits);

		expect(feed.items).toHaveLength(3);
		expect(feed.items[0]).toMatchObject({
			source_layer: 'cloudflare',
			status: 'running',
		});
		expect(feed.items.some((item) => item.source_layer === 'cloudflare' && item.dedupe_key === 'preview-ready')).toBe(true);
		expect(feed.items.some((item) => item.source_layer === 'gpt' && item.status === 'pending_approval')).toBe(true);
		expect(feed.logs.some((log) => log.source_layer === 'cloudflare')).toBe(true);
		expect(feed.counts).toMatchObject({
			running: 2,
			pending_approval: 1,
		});
	});
});
