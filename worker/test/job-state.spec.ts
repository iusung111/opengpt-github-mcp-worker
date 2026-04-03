import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord, ToolResultEnvelope } from '../src/contracts';
import { createEmptyWorkerManifest } from '../src/job-manifest';

const { nowIsoMock, queueJsonMock } = vi.hoisted(() => ({
	nowIsoMock: vi.fn(() => '2026-04-03T13:20:00.000Z'),
	queueJsonMock: vi.fn<
		(env: unknown, payload: Record<string, unknown>) => Promise<ToolResultEnvelope>
	>(),
}));

vi.mock('../src/utils', async () => {
	const actual = await vi.importActual<typeof import('../src/utils')>('../src/utils');
	return {
		...actual,
		nowIso: nowIsoMock,
		queueJson: queueJsonMock,
	};
});

import { updateJobState } from '../src/fullstack/job-state';

function makeJob(): JobRecord {
	return {
		job_id: 'job-approval-1',
		repo: 'iusung111/Project_OpenGPT',
		base_branch: 'main',
		work_branch: 'agent/job-approval-1',
		target_paths: [],
		status: 'review_pending',
		next_actor: 'reviewer',
		auto_improve_enabled: false,
		auto_improve_max_cycles: 0,
		auto_improve_cycle: 0,
		worker_manifest: {
			...createEmptyWorkerManifest(),
			attention: {
				approval: {
					pending: true,
					request_id: 'req-approval-1',
					status: 'requested',
					reason: 'Need approval before continuing.',
					blocked_action: 'workflow_dispatch',
					requested_at: '2026-04-03T13:00:00.000Z',
					resolved_at: null,
					cleared_at: null,
				},
			},
		},
		review_findings: [],
		notes: [],
		created_at: '2026-04-03T13:00:00.000Z',
		last_transition_at: '2026-04-03T13:00:00.000Z',
		updated_at: '2026-04-03T13:00:00.000Z',
	};
}

describe('updateJobState', () => {
	beforeEach(() => {
		queueJsonMock.mockReset();
	});

	it('does not clear a pending approval when unrelated tool updates move the job back to working', async () => {
		const currentJob = makeJob();
		const recordedPayloads: Array<Record<string, unknown>> = [];
		queueJsonMock.mockImplementation(async (_env, payload) => {
			recordedPayloads.push(payload);
			if (payload.action === 'job_get') {
				return {
					ok: true,
					data: {
						job: currentJob,
					},
				};
			}
			return {
				ok: true,
				data: {},
			};
		});

		await updateJobState({} as never, {
			jobId: currentJob.job_id,
			repoKey: currentJob.repo,
			status: 'working',
			nextActor: 'system',
			workerManifest: {
				preview: {
					status: 'creating',
					updated_at: '2026-04-03T13:20:00.000Z',
				},
			},
		});

		const upsertPayload = recordedPayloads.find((payload) => payload.action === 'job_upsert');
		expect(upsertPayload).toBeTruthy();
		expect(
			(upsertPayload?.job as { worker_manifest?: { attention?: { approval?: { pending?: boolean } } } }).worker_manifest
				?.attention?.approval?.pending,
		).toBe(true);
		expect(
			recordedPayloads.some(
				(payload) =>
					payload.action === 'audit_write' &&
					payload.event_type === 'job_attention_approval_cleared',
			),
		).toBe(false);
	});
});
