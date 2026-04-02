import { describe, expect, it, vi } from 'vitest';
import {
	applyHostContextToDocument,
	buildModelContextText,
	createMcpUiBridge,
	extractToolResultEnvelope,
	readParentOrigin,
} from '../../../public/gui/bridge-core.mjs';
import { createFakeDocument, createFakeWindow, createStyle } from './helpers.mjs';

describe('gui widget bridge helpers', () => {

	it('applies host context CSS variables and fonts', () => {
		const doc = createFakeDocument();
		applyHostContextToDocument(
			{
				theme: 'dark',
				displayMode: 'fullscreen',
				platform: 'desktop',
				safeAreaInsets: { top: 12, right: 8, bottom: 20, left: 6 },
				styles: {
					variables: {
						'--color-background-primary': '#111111',
						'--font-sans': '"Host Sans"',
					},
					css: {
						fonts: '@font-face { font-family: "Host Sans"; src: url(host-sans.woff2); }',
					},
				},
			},
			doc,
		);

		expect(doc.documentElement.dataset.theme).toBe('dark');
		expect(doc.documentElement.dataset.displayMode).toBe('fullscreen');
		expect(doc.documentElement.style.getPropertyValue('--color-background-primary')).toBe('#111111');
		expect(doc.documentElement.style.getPropertyValue('--safe-area-inset-bottom')).toBe('20px');
		expect(doc.getElementById('mcp-app-host-fonts')?.textContent).toContain('Host Sans');
	});

	it('builds compact model context text for follow-up messages', () => {
		const text = buildModelContextText({
			job_id: 'job-ctx-1',
			repo: 'iusung111/OpenGPT',
			tab: 'events',
			payload_kind: 'opengpt.notification_contract.job_event_feed',
			run_summary: {
				status: 'pending_approval',
				title: 'Approval pending',
				last_event: 'Waiting for workflow approval.',
			},
			blocking_state: {
				kind: 'approval',
				reason: 'Workflow approval is required.',
				blocked_action: 'workflow_dispatch',
			},
			latest_notification: {
				title: 'Approval requested',
				body: 'Need workflow access before continuing.',
			},
			permission_bundle: {
				status: 'requested',
				request_id: 'req-42',
				bundle: {
					repos: ['iusung111/OpenGPT'],
					approval_request: 'Approve one MCP permission bundle for workflow dispatch.',
				},
			},
			latest_tool_session: {
				request_id: 'tool-7',
				tool_name: 'job_control',
				phase: 'waiting',
				next_step: 'The host is still processing the request. Keep the widget open.',
			},
			future_instructions: 'Before ending, verify the queue is clear and continue if approval is granted.',
			host: {
				display_mode: 'inline',
				platform: 'web',
				theme: 'dark',
			},
		});

		expect(text).toContain('job-id: job-ctx-1');
		expect(text).toContain('Blocked action: workflow_dispatch');
		expect(text).toContain('Notification detail: Need workflow access before continuing.');
		expect(text).toContain('Permission bundle status: requested');
		expect(text).toContain('Permission request id: req-42');
		expect(text).toContain('Permission scope: iusung111/OpenGPT');
		expect(text).toContain('Approval request: Approve one MCP permission bundle for workflow dispatch.');
		expect(text).toContain('Latest tool request: tool-7');
		expect(text).toContain('Latest tool phase: waiting');
		expect(text).toContain('Future instructions: Before ending, verify the queue is clear and continue if approval is granted.');
	});
});
