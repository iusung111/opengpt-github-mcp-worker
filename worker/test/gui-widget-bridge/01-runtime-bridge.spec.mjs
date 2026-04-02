import { describe, expect, it, vi } from 'vitest';
import { applyHostContextToDocument, buildModelContextText, createMcpUiBridge, extractToolResultEnvelope, readParentOrigin } from '../../../public/gui/bridge-core.mjs';
import { createFakeDocument, createFakeWindow, createStyle } from './helpers.mjs';
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
});
