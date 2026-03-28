import { describe, expect, it } from 'vitest';

import { normalizeNotificationToolState } from '../../public/gui/notification-model.mjs';

describe('gui notification model', () => {
	it('normalizes paused, interrupted, and cancelled run states from job snapshots', () => {
		const model = normalizeNotificationToolState({
			kind: 'opengpt.notification_contract.jobs_list',
			jobs: [
				{
					job_id: 'job-paused',
					repo: 'iusung111/OpenGPT',
					run_summary: {
						job_id: 'job-paused',
						run_id: 'job-paused',
						title: 'Paused verification',
						status: 'running',
						updated_at: '2026-03-28T10:00:00.000Z',
					},
					blocking_state: {
						kind: 'paused',
						reason: 'Paused for operator review.',
					},
					control_state: {
						state: 'paused',
						reason: 'Paused for operator review.',
					},
				},
				{
					job_id: 'job-interrupted',
					repo: 'iusung111/OpenGPT',
					run_summary: {
						job_id: 'job-interrupted',
						run_id: 'job-interrupted',
						title: 'Interrupted verification',
						status: 'running',
						interrupt_kind: 'tool_timeout',
						interrupt_message: 'The host stopped responding to the tool call.',
						updated_at: '2026-03-28T10:01:00.000Z',
					},
					blocking_state: {
						kind: 'interrupted',
						reason: 'The host stopped responding to the tool call.',
					},
					control_state: {
						state: 'active',
						last_interrupt: {
							kind: 'tool_timeout',
							source: 'host',
							message: 'The host stopped responding to the tool call.',
							recorded_at: '2026-03-28T10:01:00.000Z',
						},
					},
				},
				{
					job_id: 'job-cancelled',
					repo: 'iusung111/OpenGPT',
					run_summary: {
						job_id: 'job-cancelled',
						run_id: 'job-cancelled',
						title: 'Cancelled verification',
						status: 'completed',
						updated_at: '2026-03-28T10:02:00.000Z',
					},
					blocking_state: {
						kind: 'cancelled',
						reason: 'User cancelled the run.',
					},
					control_state: {
						state: 'cancelled',
						reason: 'User cancelled the run.',
					},
				},
			],
		});

		expect(model.runs.map((run) => run.status)).toEqual(['paused', 'interrupted', 'cancelled']);
		expect(model.notifications.map((item) => item.type)).toEqual(['paused', 'interrupted', 'cancelled']);
		expect(model.counts).toMatchObject({
			paused: 1,
			interrupted: 1,
			cancelled: 1,
		});
	});

	it('keeps expanded permission bundle fields and current job progress together', () => {
		const model = normalizeNotificationToolState({
			kind: 'opengpt.notification_contract.permission_bundle',
			request_id: 'req-42',
			status: 'requested',
			requested_at: '2026-03-28T10:10:00.000Z',
			resolved_at: null,
			notification: {
				id: 'notif-42',
				job_id: 'job-42',
				run_id: 'job-42',
				status: 'pending_approval',
				title: 'Approval requested',
				body: 'Workflow approval is required before redispatch.',
				source_layer: 'gpt',
				severity: 'warning',
				created_at: '2026-03-28T10:10:00.000Z',
			},
			bundle: {
				repos: ['iusung111/OpenGPT'],
				approved_tools: ['workflow_dispatch', 'job_control'],
				approval_request: 'Approve one MCP permission bundle for workflow dispatch.',
			},
			current_progress: {
				job_id: 'job-42',
				repo: 'iusung111/OpenGPT',
				next_actor: 'system',
				run_summary: {
					job_id: 'job-42',
					run_id: 'job-42',
					title: 'Approval gate',
					status: 'pending_approval',
					updated_at: '2026-03-28T10:10:00.000Z',
				},
				blocking_state: {
					kind: 'approval',
					reason: 'Workflow approval is required before redispatch.',
					blocked_action: 'workflow_dispatch',
				},
				control_state: {
					state: 'active',
				},
				approval_request: {
					pending: true,
					request_id: 'req-42',
					status: 'requested',
					reason: 'Workflow approval is required before redispatch.',
					blocked_action: 'workflow_dispatch',
					requested_at: '2026-03-28T10:10:00.000Z',
				},
			},
		});

		expect(model.permissionBundle).toMatchObject({
			requestId: 'req-42',
			status: 'requested',
			requestedAt: '2026-03-28T10:10:00.000Z',
		});
		expect(model.runs[0]).toMatchObject({
			jobId: 'job-42',
			status: 'pending_approval',
			approvalRequest: {
				requestId: 'req-42',
				status: 'requested',
				blockedAction: 'workflow_dispatch',
			},
		});
		expect(model.notifications[0]).toMatchObject({
			jobId: 'job-42',
			type: 'pending_approval',
			title: 'Approval requested',
		});
	});
});
