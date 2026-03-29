import { describe, expect, it, vi } from 'vitest';

import {
	applyHostContextToDocument,
	buildModelContextText,
	createMcpUiBridge,
	extractToolResultEnvelope,
	readParentOrigin,
} from '../../public/gui/bridge-core.mjs';

function createStyle() {
	const values = new Map();
	return {
		setProperty(name, value) {
			values.set(name, value);
		},
		getPropertyValue(name) {
			return values.get(name) ?? '';
		},
		removeProperty(name) {
			values.delete(name);
		},
	};
}

function createFakeDocument(referrer = 'https://chatgpt.com/c/app') {
	const styleNodes = new Map();
	const headChildren = [];
	const documentElement = {
		dataset: {},
		style: createStyle(),
	};
	const head = {
		appendChild(node) {
			headChildren.push(node);
			if (node.id) styleNodes.set(node.id, node);
		},
	};
	return {
		referrer,
		documentElement,
		head,
		createElement() {
			return {
				id: '',
				textContent: '',
				remove() {
					if (this.id) styleNodes.delete(this.id);
				},
			};
		},
		getElementById(id) {
			return styleNodes.get(id) ?? null;
		},
		headChildren,
	};
}

function createFakeWindow(origin = 'https://widget.example.com') {
	const listeners = new Map();
	const posted = [];
	const parent = {
		postMessage(message, targetOrigin) {
			posted.push({ message, targetOrigin });
		},
	};
	return {
		location: { origin },
		parent,
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
		removeEventListener(type) {
			listeners.delete(type);
		},
		dispatchMessage(event) {
			const handler = listeners.get('message');
			if (handler) handler(event);
		},
		posted,
	};
}

describe('gui widget bridge helpers', () => {
	it('parses the parent origin from referrer', () => {
		expect(readParentOrigin('https://chatgpt.com/c/app', '*')).toBe('https://chatgpt.com');
		expect(readParentOrigin('not-a-url', 'https://fallback.example.com')).toBe('https://fallback.example.com');
	});

	it('initializes with the MCP Apps host and proxies tool calls', async () => {
		const doc = createFakeDocument();
		const win = createFakeWindow();
		let latestHostContext = null;
		let latestToolInput = null;
		let latestToolResult = null;

		const bridge = createMcpUiBridge({
			doc,
			win,
			appInfo: { name: 'test-widget', version: '1.0.0' },
			onHostContextChanged(hostContext) {
				latestHostContext = hostContext;
			},
			onToolInput(params) {
				latestToolInput = params;
			},
			onToolResult(params) {
				latestToolResult = params;
			},
		});

		const connectPromise = bridge.connect();
		expect(win.posted[0]).toMatchObject({
			targetOrigin: 'https://chatgpt.com',
			message: {
				jsonrpc: '2.0',
				id: 1,
				method: 'ui/initialize',
				params: {
					appInfo: { name: 'test-widget', version: '1.0.0' },
				},
			},
		});

		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				id: 1,
				result: {
					hostContext: {
						theme: 'dark',
						displayMode: 'inline',
						platform: 'web',
					},
					hostCapabilities: {
						message: {},
						openLink: {},
					},
					hostInfo: {
						name: 'ChatGPT',
					},
					protocolVersion: '2026-01-26',
				},
			},
		});

		const connectedState = await connectPromise;
		expect(connectedState.connected).toBe(true);
		expect(latestHostContext).toMatchObject({ theme: 'dark', displayMode: 'inline' });
		expect(win.posted[1]).toMatchObject({
			message: {
				jsonrpc: '2.0',
				method: 'ui/notifications/initialized',
			},
		});

		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				method: 'ui/notifications/tool-input',
				params: {
					name: 'job_progress',
					arguments: {
						job_id: 'job-1',
					},
				},
			},
		});
		expect(latestToolInput).toMatchObject({
			arguments: {
				job_id: 'job-1',
			},
		});

		const callPromise = bridge.callTool('jobs_list', { status: 'queued' });
		expect(win.posted[2]).toMatchObject({
			message: {
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: {
					name: 'jobs_list',
					arguments: { status: 'queued' },
				},
			},
		});
		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				id: 2,
				result: {
					structuredContent: {
						kind: 'opengpt.notification_contract.jobs_list',
						jobs: [{ job_id: 'job-1' }],
					},
				},
			},
		});
		await expect(callPromise).resolves.toMatchObject({
			structuredContent: {
				kind: 'opengpt.notification_contract.jobs_list',
			},
		});
		const messagePromise = bridge.sendMessage('Continue this run and use the queue tools as needed.');
		expect(win.posted[3]).toMatchObject({
			message: {
				jsonrpc: '2.0',
				id: 3,
				method: 'ui/message',
				params: {
					role: 'user',
					content: [{ type: 'text', text: 'Continue this run and use the queue tools as needed.' }],
				},
			},
		});
		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				id: 3,
				result: {
					ok: true,
				},
			},
		});
		await expect(messagePromise).resolves.toMatchObject({
			ok: true,
		});
		const contextPromise = bridge.updateModelContext({
			structuredContent: {
				kind: 'opengpt.notification_widget.context',
				job_id: 'job-1',
			},
		});
		expect(win.posted[4]).toMatchObject({
			message: {
				jsonrpc: '2.0',
				id: 4,
				method: 'ui/update-model-context',
				params: {
					structuredContent: {
						kind: 'opengpt.notification_widget.context',
						job_id: 'job-1',
					},
				},
			},
		});
		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				id: 4,
				result: {
					updated: true,
				},
			},
		});
		await expect(contextPromise).resolves.toMatchObject({
			updated: true,
		});
		expect(
			extractToolResultEnvelope({
				structuredContent: {
					kind: 'opengpt.notification_contract.jobs_list',
				},
				_meta: {
					'opengpt/widget': {
						kind: 'opengpt.notification_contract.jobs_list',
					},
				},
			}),
		).toMatchObject({
			structuredContent: {
				kind: 'opengpt.notification_contract.jobs_list',
			},
			meta: {
				'opengpt/widget': {
					kind: 'opengpt.notification_contract.jobs_list',
				},
			},
		});
		expect(
			extractToolResultEnvelope({
				result: {
					structuredContent: {
						kind: 'opengpt.notification_contract.job_progress',
					},
					_meta: {
						'opengpt/widget': {
							kind: 'opengpt.notification_contract.job_progress',
						},
					},
				},
			}),
		).toMatchObject({
			structuredContent: {
				kind: 'opengpt.notification_contract.job_progress',
			},
			meta: {
				'opengpt/widget': {
					kind: 'opengpt.notification_contract.job_progress',
				},
			},
		});

		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				method: 'ui/notifications/tool-result',
				params: {
					structuredContent: {
						kind: 'opengpt.notification_contract.job_progress',
						progress: { job_id: 'job-1' },
					},
				},
			},
		});
		expect(latestToolResult).toMatchObject({
			structuredContent: {
				kind: 'opengpt.notification_contract.job_progress',
			},
		});
	});

	it('keeps long-running executions in waiting state and reconciles late tool results by request id', async () => {
		vi.useFakeTimers();
		try {
			const doc = createFakeDocument();
			const win = createFakeWindow();
			let sessionUpdates = [];
			let toolResultSessionId = null;

			const bridge = createMcpUiBridge({
				doc,
				win,
				initializeTimeoutMs: 25,
				executionSoftTimeoutMs: 20,
				executionHardTimeoutMs: 100,
				onRequestStateChanged(session) {
					sessionUpdates.push(session);
				},
				onToolResult(_params, sessionId) {
					toolResultSessionId = sessionId;
				},
			});

			const connectPromise = bridge.connect();
			win.dispatchMessage({
				source: win.parent,
				origin: 'https://chatgpt.com',
				data: {
					jsonrpc: '2.0',
					id: 1,
					result: {
						hostContext: { theme: 'dark', displayMode: 'inline', platform: 'web' },
						hostCapabilities: { message: {}, openLink: {} },
					},
				},
			});
			await connectPromise;

			const toolCallPromise = bridge.callTool('job_progress', { job_id: 'job-soft-wait' });
			expect(win.posted[2]).toMatchObject({
				message: {
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
				},
			});

			await vi.advanceTimersByTimeAsync(25);
			expect(bridge.getState().toolSessions[0]).toMatchObject({
				requestId: '2',
				toolName: 'job_progress',
				phase: 'waiting',
			});

			win.dispatchMessage({
				source: win.parent,
				origin: 'https://chatgpt.com',
				data: {
					jsonrpc: '2.0',
					method: 'ui/notifications/tool-result',
					params: {
						request_id: '2',
						structuredContent: {
							kind: 'opengpt.notification_contract.job_progress',
							progress: { job_id: 'job-soft-wait' },
						},
					},
				},
			});

			await expect(toolCallPromise).resolves.toMatchObject({
				structuredContent: {
					kind: 'opengpt.notification_contract.job_progress',
				},
			});
			expect(toolResultSessionId).toBe('2');
			expect(bridge.getState().toolSessions[0]).toMatchObject({
				requestId: '2',
				phase: 'completed',
				resultKind: 'opengpt.notification_contract.job_progress',
			});
			expect(sessionUpdates.some((session) => session.requestId === '2' && session.phase === 'waiting')).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('marks cancelled sessions and rejects pending work on teardown', async () => {
		const doc = createFakeDocument();
		const win = createFakeWindow();
		const bridge = createMcpUiBridge({ doc, win });

		const connectPromise = bridge.connect();
		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				id: 1,
				result: {
					hostContext: { theme: 'dark', displayMode: 'inline', platform: 'web' },
					hostCapabilities: { message: {}, openLink: {} },
				},
			},
		});
		await connectPromise;

		const toolCallPromise = bridge.callTool('jobs_list', {});
		const sendMessagePromise = bridge.sendMessage('Please hold this run.');

		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				method: 'ui/notifications/tool-cancelled',
				params: {
					request_id: '2',
				},
			},
		});
		await expect(toolCallPromise).rejects.toThrow('Host cancelled the current tool execution.');
		expect(bridge.getState().toolSessions.find((session) => session.requestId === '2')).toMatchObject({
			phase: 'cancelled',
		});

		win.dispatchMessage({
			source: win.parent,
			origin: 'https://chatgpt.com',
			data: {
				jsonrpc: '2.0',
				method: 'ui/notifications/request-teardown',
				params: {
					reason: 'host disconnect',
				},
			},
		});
		await expect(sendMessagePromise).rejects.toThrow('Host requested widget teardown.');
		expect(bridge.getState().toolSessions.find((session) => session.requestId === '3')).toMatchObject({
			phase: 'cancelled',
		});
	});

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
