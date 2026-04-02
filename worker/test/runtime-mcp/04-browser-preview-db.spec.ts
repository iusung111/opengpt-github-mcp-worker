import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDispatchFingerprint } from '../../src/utils';
import { getToolCatalog } from '../../src/tool-catalog';
import {
	createChatgptMcpClient,
	createDirectMcpBearerClient,
	createMcpClient,
	mcpAccessHeaders,
	queueJsonHeaders,
} from '../runtime-helpers';
import { buildStoredZip } from './test-zip-helpers';
describe('runtime mcp surface', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects unsigned preview tokens and preserves inline html browser sessions', async () => {
		const client = await createMcpClient();

		const forgedPreviewResult = await client.callTool({
			name: 'preview_env_get',
			arguments: {
				preview_token: 'preview.invalid.invalid',
				probe_health: false,
			},
		});
		const forgedPreviewText =
			'text' in forgedPreviewResult.content[0] ? forgedPreviewResult.content[0].text : '';
		expect(JSON.parse(forgedPreviewText)).toMatchObject({
			ok: false,
			code: 'preview_env_get_failed',
			error: expect.stringContaining('invalid token'),
		});

		const forgedDestroyResult = await client.callTool({
			name: 'preview_env_destroy',
			arguments: {
				preview_token: 'preview.invalid.invalid',
			},
		});
		const forgedDestroyText =
			'text' in forgedDestroyResult.content[0] ? forgedDestroyResult.content[0].text : '';
		expect(JSON.parse(forgedDestroyText)).toMatchObject({
			ok: false,
			code: 'preview_env_destroy_failed',
			error: expect.stringContaining('invalid token'),
		});

		const browserSessionResult = await client.callTool({
			name: 'browser_session_start',
			arguments: {
				file_name: 'inline.html',
				file_text: '<!doctype html><html><body><h1>inline</h1></body></html>',
				viewport: 'desktop',
			},
		});
		const browserSessionText =
			'text' in browserSessionResult.content[0] ? browserSessionResult.content[0].text : '';
		expect(JSON.parse(browserSessionText)).toMatchObject({
			ok: true,
			data: {
				session: {
					target: {
						type: 'static_file',
					},
					file_name: 'inline.html',
					file_text: '<!doctype html><html><body><h1>inline</h1></body></html>',
				},
				session_token: expect.any(String),
			},
		});

		await client.close();
	});

	it('reuses inline html browser sessions and matches gui capture workflow runs by request id', async () => {
		let dispatchedRequestId = '';
		let dispatchedFileText = '';
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			const parsed = new URL(url);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (
				parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/workflows/gui-capture.yml/dispatches' &&
				(init?.method ?? 'GET').toUpperCase() === 'POST'
			) {
				const payload = JSON.parse(String(init?.body ?? '{}')) as {
					inputs?: { instructions_b64?: string };
				};
				const instructions = JSON.parse(
					Buffer.from(String(payload.inputs?.instructions_b64 ?? ''), 'base64').toString('utf8'),
				) as {
					request_id?: string;
					file_text?: string;
				};
				dispatchedRequestId =
					typeof instructions.request_id === 'string' ? instructions.request_id : '';
				dispatchedFileText = typeof instructions.file_text === 'string' ? instructions.file_text : '';
				return new Response(null, { status: 204 });
			}
			if (
				parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/runs' &&
				parsed.searchParams.get('branch') === 'main' &&
				parsed.searchParams.get('event') === 'workflow_dispatch' &&
				parsed.searchParams.get('per_page') === '10'
			) {
				return new Response(
					JSON.stringify({
						workflow_runs: [
							{
								id: 700,
								path: '.github/workflows/gui-capture.yml',
								created_at: '2099-01-01T00:00:01.000Z',
							},
							{
								id: 701,
								path: '.github/workflows/gui-capture.yml',
								created_at: '2099-01-01T00:00:02.000Z',
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/runs/700') {
				return new Response(
					JSON.stringify({
						id: 700,
						status: 'completed',
						conclusion: 'success',
						html_url: 'https://github.example/runs/700',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/runs/700/artifacts') {
				return new Response(
					JSON.stringify({
						artifacts: [{ id: 800, name: 'gui-capture-700' }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/artifacts/800/zip') {
				return new Response(
					buildStoredZip([
						{
							name: 'summary.json',
							text: JSON.stringify({
								request_id: 'req-other',
								request: { request_id: 'req-other' },
								result: { overall_status: 'pass' },
								logs: {
									console_count: 0,
									page_error_count: 0,
									network_error_count: 0,
								},
							}),
						},
					]),
					{ status: 200, headers: { 'content-type': 'application/zip' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/runs/701') {
				return new Response(
					JSON.stringify({
						id: 701,
						status: 'completed',
						conclusion: 'success',
						html_url: 'https://github.example/runs/701',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/runs/701/artifacts') {
				return new Response(
					JSON.stringify({
						artifacts: [{ id: 801, name: 'gui-capture-701' }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (parsed.pathname === '/repos/iusung111/opengpt-github-mcp-worker/actions/artifacts/801/zip') {
				return new Response(
					buildStoredZip([
						{
							name: 'summary.json',
							text: JSON.stringify({
								request_id: dispatchedRequestId,
								request: { request_id: dispatchedRequestId },
								result: { overall_status: 'pass' },
								logs: {
									console_count: 0,
									page_error_count: 0,
									network_error_count: 0,
								},
							}),
						},
						{ name: 'report.md', text: '# ok' },
					]),
					{ status: 200, headers: { 'content-type': 'application/zip' } },
				);
			}
			return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		});

		const client = await createMcpClient();
		const inlineHtml = '<!doctype html><html><body><button id="go">go</button></body></html>';
		const browserSessionResult = await client.callTool({
			name: 'browser_session_start',
			arguments: {
				file_name: 'inline.html',
				file_text: inlineHtml,
				viewport: 'desktop',
			},
		});
		const browserSessionText =
			'text' in browserSessionResult.content[0] ? browserSessionResult.content[0].text : '';
		const browserSessionJson = JSON.parse(browserSessionText);

		const actionResult = await client.callTool({
			name: 'browser_action_batch',
			arguments: {
				session_token: browserSessionJson.data.session_token,
				actions: [{ action: 'assert_visible', selector: '#go' }],
				include_image_base64: false,
			},
		});
		const actionText = 'text' in actionResult.content[0] ? actionResult.content[0].text : '';
		expect(JSON.parse(actionText)).toMatchObject({
			ok: true,
			data: {
				run_id: 701,
				summary: {
					request_id: expect.any(String),
				},
				session: {
					file_name: 'inline.html',
					file_text: inlineHtml,
				},
				browser_result_token: expect.stringMatching(/^v1\./),
			},
		});
		expect(dispatchedRequestId).toBeTruthy();
		expect(dispatchedFileText).toBe(inlineHtml);
		await client.close();
	}, 15_000);

	it('issues signed db reset confirm tokens, rejects legacy literals, and guards non-agent refs', async () => {
		const resetRef = 'agent/db-reset-prepare';
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			const parsed = new URL(url);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (
				parsed.pathname === '/repos/iusung111/OpenGPT/contents/.opengpt/project-capabilities.json' &&
				parsed.searchParams.get('ref') === resetRef
			) {
				return new Response(
					JSON.stringify({
						path: '.opengpt/project-capabilities.json',
						type: 'file',
						content: btoa(
							JSON.stringify({
								workflow_ids: {
									db: 'opengpt-exec.yml',
								},
								db_mode: 'preview',
								db: {
									reset_commands: ['npm run db:reset'],
								},
							}),
						),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (
				parsed.pathname === '/repos/iusung111/OpenGPT/contents/package.json' &&
				parsed.searchParams.get('ref') === resetRef
			) {
				return new Response(JSON.stringify({ message: 'not found' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		});

		const client = await createMcpClient();
		const blockedPrepareResult = await client.callTool({
			name: 'db_reset_prepare',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: 'feature/not-allowed',
			},
		});
		const blockedPrepareText =
			'text' in blockedPrepareResult.content[0] ? blockedPrepareResult.content[0].text : '';
		expect(JSON.parse(blockedPrepareText)).toMatchObject({
			ok: false,
			code: 'db_reset_prepare_failed',
			error: expect.stringContaining('branch must start with agent/'),
		});

		const prepareResult = await client.callTool({
			name: 'db_reset_prepare',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: resetRef,
				ttl_minutes: 5,
			},
		});
		const prepareText = 'text' in prepareResult.content[0] ? prepareResult.content[0].text : '';
		const prepareJson = JSON.parse(prepareText);
		expect(prepareJson).toMatchObject({
			ok: true,
			data: {
				repo: 'iusung111/OpenGPT',
				ref: resetRef,
				confirm_token: expect.stringMatching(/^v1\./),
				confirm: {
					action: 'db_reset',
					repo: 'iusung111/OpenGPT',
					ref: resetRef,
				},
			},
		});
		expect(prepareJson.data.confirm_token).not.toBe(`db-reset:iusung111/OpenGPT:${resetRef}`);

		const resetResult = await client.callTool({
			name: 'db_reset',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: resetRef,
				confirm_token: `db-reset:iusung111/OpenGPT:${resetRef}`,
			},
		});
		const resetText = 'text' in resetResult.content[0] ? resetResult.content[0].text : '';
		expect(JSON.parse(resetText)).toMatchObject({
			ok: false,
			code: 'db_reset_failed',
			error: expect.stringContaining('invalid token'),
		});
		await client.close();
	});

});
