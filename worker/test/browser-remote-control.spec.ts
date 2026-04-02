import { describe, expect, it } from 'vitest';
import {
	browserRemoteSessionConnected,
	claimBrowserRemoteCommand,
	completeBrowserRemoteCommand,
	disconnectBrowserRemoteSession,
	enqueueBrowserRemoteCommand,
	normalizeBrowserRemoteCommandKind,
	normalizeBrowserRemoteControl,
	syncSessionContextWithRemoteAttach,
	upsertBrowserRemoteSession,
} from '../src/browser-remote-control';

describe('browser remote control helpers', () => {
	it('upserts a connected session and marks it stale later', () => {
		const connectedAt = '2026-03-29T00:00:00.000Z';
		const state = upsertBrowserRemoteSession(
			null,
			{
				session_id: 'session-1',
				agent_name: 'local-agent',
				page_url: 'https://chatgpt.com/c/example',
			},
			connectedAt,
		);
		expect(browserRemoteSessionConnected(state, { nowMs: Date.parse(connectedAt) + 10_000 })).toBe(true);
		const normalized = normalizeBrowserRemoteControl(state, { nowMs: Date.parse(connectedAt) + 60_000 });
		expect(normalized?.session?.status).toBe('stale');
	});

	it('queues, claims, and completes a browser command', () => {
		const queued = enqueueBrowserRemoteCommand(null, {
			kind: 'click_continue',
			job_id: 'job-123',
			job_title: 'Mirror deploy verification',
			repo: 'iusung111/OpenGPT',
			run_status: 'pending_approval',
			label: 'Click Continue',
			created_by: 'operator@example.com',
		}, '2026-03-29T00:00:00.000Z');
		expect(queued.pending_command?.status).toBe('pending');
		expect(queued.active_job?.job_id).toBe('job-123');

		const claimed = claimBrowserRemoteCommand(queued, { session_id: 'session-1' }, '2026-03-29T00:00:05.000Z');
		expect(claimed.command?.status).toBe('claimed');
		expect(claimed.command?.claimed_by).toBe('session-1');
		expect(claimed.command?.job_id).toBe('job-123');

		const completed = completeBrowserRemoteCommand(
			claimed.control,
			{
				command_id: claimed.command?.command_id ?? '',
				ok: true,
				summary: 'Clicked Continue in ChatGPT.',
				matched_actions: ['Continue'],
				page_url: 'https://chatgpt.com/c/example',
			},
			'2026-03-29T00:00:10.000Z',
		);
		expect(completed.pending_command).toBeNull();
		expect(completed.last_result?.ok).toBe(true);
		expect(completed.last_result?.job_id).toBe('job-123');
		expect(completed.last_result?.matched_actions).toEqual(['Continue']);
	});

	it('prevents a second pending command and can disconnect a session', () => {
		const queued = enqueueBrowserRemoteCommand(null, {
			kind: 'send_prompt',
			prompt: 'Continue the run.',
		});
		expect(() =>
			enqueueBrowserRemoteCommand(queued, {
				kind: 'click_continue',
			}),
		).toThrow(/already pending for the console/i);

		const connected = upsertBrowserRemoteSession(queued, {
			session_id: 'session-1',
		}, '2026-03-29T00:00:00.000Z');
		const disconnected = disconnectBrowserRemoteSession(connected, '2026-03-29T00:01:00.000Z');
		expect(disconnected.session?.status).toBe('disconnected');
	});

	it('accepts new permission and follow-up command kinds and syncs attach metadata into session context', () => {
		expect(normalizeBrowserRemoteCommandKind('resolve_permission_prompt')).toBe('resolve_permission_prompt');
		expect(normalizeBrowserRemoteCommandKind('send_followup')).toBe('send_followup');

		const control = upsertBrowserRemoteSession(
			null,
			{
				session_id: 'session-1',
				page_url: 'https://chatgpt.com/c/example',
				page_title: 'ChatGPT Conversation',
			},
			'2026-03-29T00:00:00.000Z',
		);
		const linked = syncSessionContextWithRemoteAttach(
			{
				provider: 'chatgpt_web',
				session_url: 'https://chatgpt.com/c/example',
				auth_state: 'authenticated',
				approval_state: 'none',
				followup_state: 'unknown',
			},
			control,
			'2026-03-29T00:00:01.000Z',
		);

		expect(linked).toMatchObject({
			page_url_at_attach: 'https://chatgpt.com/c/example',
			page_title_at_attach: 'ChatGPT Conversation',
			updated_at: '2026-03-29T00:00:01.000Z',
		});
	});
});
