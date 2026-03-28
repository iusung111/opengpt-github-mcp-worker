import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDispatchFingerprint } from '../src/utils';
import { createChatgptMcpClient, createDirectMcpBearerClient, createMcpClient, queueJsonHeaders } from './runtime-helpers';

function buildStoredZip(entries: Array<{ name: string; text: string }>): Uint8Array {
	const encoder = new TextEncoder();
	const fileRecords: number[] = [];
	const centralRecords: number[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = Array.from(encoder.encode(entry.name));
		const dataBytes = Array.from(encoder.encode(entry.text));
		const localHeaderOffset = offset;
		const localHeader = [
			0x50, 0x4b, 0x03, 0x04,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...dataBytes,
		];
		fileRecords.push(...localHeader);
		offset += localHeader.length;

		const centralHeader = [
			0x50, 0x4b, 0x01, 0x02,
			20, 0,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(localHeaderOffset),
			...nameBytes,
		];
		centralRecords.push(...centralHeader);
	}

	const centralOffset = fileRecords.length;
	const eocd = [
		0x50, 0x4b, 0x05, 0x06,
		0, 0, 0, 0,
		...u16(entries.length),
		...u16(entries.length),
		...u32(centralRecords.length),
		...u32(centralOffset),
		...u16(0),
	];

	return new Uint8Array([...fileRecords, ...centralRecords, ...eocd]);
}

function u16(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

describe('runtime mcp surface', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('treats blocked reviews as terminal and respects review rework limit', async () => {
		const blockedClient = await createMcpClient();
		await blockedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-1',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await blockedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-1',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const blockedResult = await blockedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-1',
				review_verdict: 'blocked',
				findings: [],
				next_action: 'security concern',
			},
		});
		const blockedText = 'text' in blockedResult.content[0] ? blockedResult.content[0].text : '';
		expect(JSON.parse(blockedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'failed',
					next_actor: 'system',
					last_error: 'review blocked: security concern',
				},
			},
		});
		await blockedClient.close();

		const limitedClient = await createMcpClient();
		await limitedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-2',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-2',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await limitedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-2',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const limitedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'needs another pass',
			},
		});
		const limitedText = 'text' in limitedResult.content[0] ? limitedResult.content[0].text : '';
		expect(JSON.parse(limitedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'rework_pending',
					next_actor: 'worker',
					auto_improve_cycle: 1,
				},
			},
		});

		const cappedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'limit reached',
			},
		});
		const cappedText = 'text' in cappedResult.content[0] ? cappedResult.content[0].text : '';
		expect(JSON.parse(cappedText)).toMatchObject({
			ok: false,
			code: 'invalid_state',
			error: 'job is not waiting for reviewer input',
		});
		await limitedClient.close();
	});

	it('serves MCP tools and queue actions over /mcp', async () => {
		const client = await createMcpClient();
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'help')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'audit_list')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_candidates')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_execute')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_progress')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_event_feed')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_work_context')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'review_prepare_context')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'request_permission_bundle')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_navigation_manifest')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_context_snapshot')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_doc_index_lookup')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_tool_index_lookup')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file_summary')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file_chunk')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_diff')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_create_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_upsert_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_upload_start')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_upload_commit')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_batch_write')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_apply_patchset')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'verify_list_suites')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'verify_run')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'preview_env_create')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'browser_session_start')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'browser_action_batch')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'desktop_build_run')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'api_contract_list')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'db_schema_inspect')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'runtime_log_query')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'deploy_promote')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'release_verify')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workflow_allowlist_inspect')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_create')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'pr_merge')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workspace_resolve')).toBe(true);
		expect(
			tools.tools.find((tool) => tool.name === 'job_event_feed')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Loading run events',
			'openai/toolInvocation/invoked': 'Run events ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'request_permission_bundle')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Preparing approval bundle',
			'openai/toolInvocation/invoked': 'Approval bundle ready',
		});
		expect(
			tools.tools.find((tool) => tool.name === 'incident_bundle_create')?._meta,
		).toMatchObject({
			'openai/toolInvocation/invoking': 'Collecting incident bundle',
			'openai/toolInvocation/invoked': 'Incident bundle ready',
		});
		expect(tools.tools.find((tool) => tool.name === 'job_progress')?.outputSchema).toBeTruthy();
		expect(tools.tools.find((tool) => tool.name === 'jobs_list')?.outputSchema).toBeTruthy();
		expect(tools.tools.find((tool) => tool.name === 'job_event_feed')?.outputSchema).toBeTruthy();
		expect(tools.tools.find((tool) => tool.name === 'request_permission_bundle')?.outputSchema).toBeTruthy();
		expect(tools.tools.find((tool) => tool.name === 'incident_bundle_create')?.outputSchema).toBeTruthy();

		const createResult = await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-mcp-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-mcp-1',
				operation_type: 'run_commands',
			},
		});
		const createText = 'text' in createResult.content[0] ? createResult.content[0].text : '';
		expect(JSON.parse(createText)).toMatchObject({
			ok: true,
			data: {
				job: {
					job_id: 'job-mcp-1',
					repo: 'iusung111/OpenGPT',
				},
			},
		});

		const getResult = await client.callTool({
			name: 'job_get',
			arguments: { job_id: 'job-mcp-1' },
		});
		const getText = 'text' in getResult.content[0] ? getResult.content[0].text : '';
		expect(JSON.parse(getText)).toMatchObject({
			ok: true,
			data: {
				job: {
					work_branch: 'agent/job-mcp-1',
				},
			},
		});

		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-mcp-1',
				note: 'reading repo state',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'job-mcp-1' },
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		expect(JSON.parse(progressText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-mcp-1',
					status: 'queued',
					latest_note: 'reading repo state',
					recent_notes: ['reading repo state'],
					run_summary: {
						run_id: 'job-mcp-1',
						status: 'idle',
					},
					blocking_state: {
						kind: 'none',
					},
					notification_counts: {
						idle: expect.any(Number),
					},
				},
			},
		});
		expect((progressResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.job_progress',
			run_summary: {
				run_id: 'job-mcp-1',
			},
		});

		const eventFeedResult = await client.callTool({
			name: 'job_event_feed',
			arguments: {
				job_id: 'job-mcp-1',
				limit: 10,
			},
		});
		expect((eventFeedResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.job_event_feed',
		});
		const eventFeedText = 'text' in eventFeedResult.content[0] ? eventFeedResult.content[0].text : '';
		expect(JSON.parse(eventFeedText)).toMatchObject({
			ok: true,
			data: {
				items: expect.any(Array),
				logs: expect.any(Array),
				counts: {
					idle: expect.any(Number),
				},
			},
		});

		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-mcp-1',
				limit: 5,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(
			auditJson.data.audits.some(
				(item: { event_type: string; payload: { job_id?: string } }) =>
					item.event_type === 'job_create' && item.payload.job_id === 'job-mcp-1',
			),
		).toBe(true);

		const registerWorkspaceResult = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				aliases: ['opengpt'],
			},
		});
		const registerWorkspaceText =
			'text' in registerWorkspaceResult.content[0] ? registerWorkspaceResult.content[0].text : '';
		expect(JSON.parse(registerWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				workspace: {
					repo_key: 'iusung111/OpenGPT',
					workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				},
			},
		});

		const resolveWorkspaceResult = await client.callTool({
			name: 'workspace_resolve',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		const resolveWorkspaceText =
			'text' in resolveWorkspaceResult.content[0] ? resolveWorkspaceResult.content[0].text : '';
		expect(JSON.parse(resolveWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/OpenGPT',
				default_workspace_path: '/home/uieseong/workspace/projects/OpenGPT',
				existing_workspace: {
					repo_key: 'iusung111/OpenGPT',
					workspace_path: '/home/uieseong/workspace/projects/opengpt-sandbox',
				},
				requires_confirmation: true,
			},
		});
		await client.close();
	});

	it('inspects the effective workflow allowlist for a repository', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_allowlist_inspect',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/OpenGPT',
				file_based_entries: ['build-todo-exe.yml', 'opengpt-exec.yml', 'opengpt-package.yml'],
				effective_allowlist: expect.arrayContaining(['build-todo-exe.yml', 'opengpt-exec.yml', 'opengpt-package.yml']),
				precedence: {
					rules: expect.any(Array),
				},
			},
		});
		await client.close();
	});

	it('resolves project capabilities for verify and preview tools', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.opengpt/project-capabilities.json?ref=main') {
				return new Response(
					JSON.stringify({
						path: '.opengpt/project-capabilities.json',
						type: 'file',
						content: btoa(
							JSON.stringify({
								runtime_kind: 'webview_desktop_shell',
								desktop_shell: 'electron',
								verify_profiles: [
									{
										id: 'frontend',
										label: 'Frontend verify',
										kind: 'verify',
										commands: ['npm run typecheck'],
									},
								],
								web_preview: {
									enabled: true,
									url_template: 'https://preview.example.com/{ref}',
									services: ['web'],
									ttl_minutes: 120,
								},
								workflow_ids: {
									verify: 'opengpt-exec.yml',
									package: 'opengpt-package.yml',
									preview: 'opengpt-exec.yml',
									release: 'opengpt-exec.yml',
									db: 'opengpt-exec.yml',
								},
							}),
						),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/package.json?ref=main') {
				return new Response(
					JSON.stringify({
						path: 'package.json',
						type: 'file',
						content: btoa(
							JSON.stringify({
								scripts: {
									typecheck: 'tsc --noEmit',
								},
							}),
						),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const suitesResult = await client.callTool({
			name: 'verify_list_suites',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: 'main',
			},
		});
		const suitesText = 'text' in suitesResult.content[0] ? suitesResult.content[0].text : '';
		expect(JSON.parse(suitesText)).toMatchObject({
			ok: true,
			data: {
				suites: [
					{
						id: 'frontend',
						label: 'Frontend verify',
					},
				],
			},
		});

		const previewCreateResult = await client.callTool({
			name: 'preview_env_create',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: 'main',
			},
		});
		const previewCreateText =
			'text' in previewCreateResult.content[0] ? previewCreateResult.content[0].text : '';
		const previewCreateJson = JSON.parse(previewCreateText);
		expect(previewCreateJson).toMatchObject({
			ok: true,
			data: {
				preview: {
					status: 'ready',
					urls: {
						web: 'https://preview.example.com/main',
					},
				},
				preview_token: expect.any(String),
			},
		});

		const browserSessionResult = await client.callTool({
			name: 'browser_session_start',
			arguments: {
				preview_token: previewCreateJson.data.preview_token,
			},
		});
		const browserSessionText =
			'text' in browserSessionResult.content[0] ? browserSessionResult.content[0].text : '';
		expect(JSON.parse(browserSessionText)).toMatchObject({
			ok: true,
			data: {
				session: {
					target: {
						type: 'preview',
					},
				},
				session_token: expect.any(String),
			},
		});
		await client.close();
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

	it('serves the same read/write MCP surface over /chatgpt/mcp with bearer auth', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/trees/main?recursive=false') {
				return new Response(
					JSON.stringify({
						sha: 'tree-sha',
						truncated: false,
						tree: [
							{ path: 'README.md', type: 'blob', sha: 'blob-readme' },
							{ path: 'project', type: 'tree', sha: 'tree-project' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/README.md') {
				return new Response(
					JSON.stringify({
						path: 'README.md',
						name: 'README.md',
						type: 'file',
						content: btoa('# OpenGPT\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createChatgptMcpClient();
		const jobsListResult = await client.callTool({
			name: 'jobs_list',
			arguments: {},
		});
		const jobsListText = 'text' in jobsListResult.content[0] ? jobsListResult.content[0].text : '';
		expect(JSON.parse(jobsListText)).toMatchObject({
			ok: true,
			data: {
				jobs: expect.any(Array),
			},
		});

		const treeResult = await client.callTool({
			name: 'repo_list_tree',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: '',
				recursive: false,
			},
		});
		const treeText = 'text' in treeResult.content[0] ? treeResult.content[0].text : '';
		const treeJson = JSON.parse(treeText);
		expect(treeJson.ok).toBe(true);
		expect(Array.isArray(treeJson.data.tree)).toBe(true);

		const fileResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: 'README.md',
			},
		});
		const fileText = 'text' in fileResult.content[0] ? fileResult.content[0].text : '';
		expect(JSON.parse(fileText)).toMatchObject({
			ok: true,
			data: {
				path: 'README.md',
				access_mode: 'summary_first',
			},
		});

		const summaryResult = await client.callTool({
			name: 'repo_get_file_summary',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: 'README.md',
			},
		});
		const summaryText = 'text' in summaryResult.content[0] ? summaryResult.content[0].text : '';
		expect(JSON.parse(summaryText)).toMatchObject({
			ok: true,
			data: {
				path: 'README.md',
				summary: {
					classification: 'doc',
				},
			},
		});
		await client.close();
	});

	it('reads and updates workflow files over /chatgpt/mcp', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/test.yml') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
					const payload = JSON.parse(String(init?.body ?? '{}'));
					return new Response(
						JSON.stringify({
							content: {
								path: '.github/workflows/test.yml',
								sha: 'workflow-blob-updated',
							},
							commit: {
								sha: 'commit-workflow-update',
								message: payload.message,
							},
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						path: '.github/workflows/test.yml',
						name: 'test.yml',
						type: 'file',
						content: btoa('name: test\non: workflow_dispatch\n'),
						encoding: 'base64',
						sha: 'workflow-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createChatgptMcpClient();
		const workflowFileResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				path: '.github/workflows/test.yml',
			},
		});
		const workflowFileText =
			'text' in workflowFileResult.content[0] ? workflowFileResult.content[0].text : '';
		expect(JSON.parse(workflowFileText)).toMatchObject({
			ok: true,
			data: {
				path: '.github/workflows/test.yml',
				decoded_text: null,
				access_mode: 'summary_first',
			},
		});

		const workflowUpdateResult = await client.callTool({
			name: 'repo_update_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				branch: 'agent/workflow-edit-test',
				path: '.github/workflows/test.yml',
				message: 'Update workflow from MCP',
				content_b64: btoa('name: test\non: workflow_dispatch\njobs: {}\n'),
				expected_blob_sha: 'workflow-blob-sha',
			},
		});
		const workflowUpdateText =
			'text' in workflowUpdateResult.content[0] ? workflowUpdateResult.content[0].text : '';
		expect(JSON.parse(workflowUpdateText)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: '.github/workflows/test.yml',
				},
				commit: {
					message: 'Update workflow from MCP',
				},
			},
		});
		await client.close();
	});

	it('creates a new file over /mcp without requiring a blob sha', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/docs/new-file.md') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload).toMatchObject({
					message: 'Create new file from MCP',
					branch: 'agent/create-file-test',
				});
				expect(payload.sha).toBeUndefined();
				return new Response(
					JSON.stringify({
						content: {
							path: 'docs/new-file.md',
							sha: 'new-file-blob-sha',
						},
						commit: {
							sha: 'new-file-commit-sha',
							message: payload.message,
						},
					}),
					{ status: 201, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'repo_create_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				branch: 'agent/create-file-test',
				path: 'docs/new-file.md',
				message: 'Create new file from MCP',
				content_b64: btoa('# New File\n'),
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: 'docs/new-file.md',
					sha: 'new-file-blob-sha',
				},
				commit: {
					message: 'Create new file from MCP',
				},
			},
		});
		await client.close();
	});

	it('upserts a file over /mcp by probing the existing blob sha when omitted', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/docs/upsert-file.md?ref=agent%2Fupsert-file-test') {
				return new Response(
					JSON.stringify({
						path: 'docs/upsert-file.md',
						type: 'file',
						sha: 'existing-upsert-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/docs/upsert-file.md') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload).toMatchObject({
					message: 'Upsert file from MCP',
					branch: 'agent/upsert-file-test',
					sha: 'existing-upsert-blob-sha',
				});
				return new Response(
					JSON.stringify({
						content: {
							path: 'docs/upsert-file.md',
							sha: 'updated-upsert-blob-sha',
						},
						commit: {
							sha: 'updated-upsert-commit-sha',
							message: payload.message,
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'repo_upsert_file',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				branch: 'agent/upsert-file-test',
				path: 'docs/upsert-file.md',
				message: 'Upsert file from MCP',
				content_b64: btoa('# Upsert\n'),
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: 'docs/upsert-file.md',
					sha: 'updated-upsert-blob-sha',
				},
				commit: {
					message: 'Upsert file from MCP',
				},
			},
		});
		await client.close();
	});

	it('streams workflow file uploads over /chatgpt/mcp', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/ref/heads/agent/workflow-stream-test') {
				return new Response(
					JSON.stringify({
						object: {
							sha: 'workflow-base-ref-sha',
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/test.yml?ref=agent%2Fworkflow-stream-test') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/test.yml',
						type: 'file',
						sha: 'workflow-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/commits/workflow-base-ref-sha') {
				return new Response(
					JSON.stringify({
						tree: {
							sha: 'workflow-base-tree-sha',
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/blobs') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload.encoding).toBe('base64');
				return new Response(
					JSON.stringify({
						sha: 'workflow-uploaded-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/trees') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload.base_tree).toBe('workflow-base-tree-sha');
				expect(payload.tree[0]).toMatchObject({
					path: '.github/workflows/test.yml',
					sha: 'workflow-uploaded-blob-sha',
				});
				return new Response(
					JSON.stringify({
						sha: 'workflow-tree-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/commits' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload).toMatchObject({
					message: 'Upload workflow via stream',
					tree: 'workflow-tree-sha',
					parents: ['workflow-base-ref-sha'],
				});
				return new Response(
					JSON.stringify({
						sha: 'workflow-commit-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/git/refs/heads/agent/workflow-stream-test') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
					return new Response(
						JSON.stringify({
							ref: 'refs/heads/agent/workflow-stream-test',
							object: { sha: 'workflow-commit-sha' },
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						object: { sha: 'workflow-base-ref-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createChatgptMcpClient();
		const startResult = await client.callTool({
			name: 'repo_upload_start',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				branch: 'agent/workflow-stream-test',
				path: '.github/workflows/test.yml',
				message: 'Upload workflow via stream',
				expected_blob_sha: 'workflow-blob-sha',
				total_bytes: 42,
			},
		});
		const startText = 'text' in startResult.content[0] ? startResult.content[0].text : '';
		const startJson = JSON.parse(startText);
		expect(startJson).toMatchObject({
			ok: true,
			data: {
				upload_id: expect.any(String),
				existing_blob_sha: 'workflow-blob-sha',
			},
		});

		const uploadId = startJson.data.upload_id as string;
		const chunkOne = btoa('name: test\non: workflow_');
		const chunkTwo = btoa('dispatch\njobs: {}\n');
		await client.callTool({
			name: 'repo_upload_append',
			arguments: {
				upload_id: uploadId,
				chunk_b64: chunkOne,
				chunk_index: 0,
				byte_offset: 0,
			},
		});
		await client.callTool({
			name: 'repo_upload_append',
			arguments: {
				upload_id: uploadId,
				chunk_b64: chunkTwo,
				chunk_index: 1,
				byte_offset: 24,
			},
		});
		const commitResult = await client.callTool({
			name: 'repo_upload_commit',
			arguments: {
				upload_id: uploadId,
			},
		});
		const commitText = 'text' in commitResult.content[0] ? commitResult.content[0].text : '';
		expect(JSON.parse(commitText)).toMatchObject({
			ok: true,
			data: {
				ok: true,
				result: {
					content: {
						path: '.github/workflows/test.yml',
						sha: 'workflow-uploaded-blob-sha',
					},
					commit: {
						sha: 'workflow-commit-sha',
						message: 'Upload workflow via stream',
					},
				},
			},
		});
		await client.close();
	});

	it('streams general file uploads over /mcp and rejects oversized repo_update_file payloads', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/ref/heads/agent/backup-stream-test') {
				return new Response(
					JSON.stringify({
						object: { sha: 'backup-base-ref-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/contents/README.md?ref=agent%2Fbackup-stream-test') {
				return new Response(
					JSON.stringify({
						path: 'README.md',
						type: 'file',
						sha: 'backup-readme-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/commits/backup-base-ref-sha') {
				return new Response(
					JSON.stringify({
						tree: { sha: 'backup-base-tree-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/blobs') {
				return new Response(
					JSON.stringify({
						sha: 'backup-uploaded-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/trees') {
				return new Response(
					JSON.stringify({
						sha: 'backup-tree-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (
				url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/commits' &&
				(init?.method ?? 'GET').toUpperCase() === 'POST'
			) {
				return new Response(
					JSON.stringify({
						sha: 'backup-commit-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/git/refs/heads/agent/backup-stream-test') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
					return new Response(
						JSON.stringify({
							ref: 'refs/heads/agent/backup-stream-test',
							object: { sha: 'backup-commit-sha' },
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						object: { sha: 'backup-base-ref-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const startResult = await client.callTool({
			name: 'repo_upload_start',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				branch: 'agent/backup-stream-test',
				path: 'README.md',
				message: 'Stream upload README',
				expected_blob_sha: 'backup-readme-sha',
				total_bytes: 37,
			},
		});
		const startText = 'text' in startResult.content[0] ? startResult.content[0].text : '';
		const uploadId = JSON.parse(startText).data.upload_id as string;
		await client.callTool({
			name: 'repo_upload_append',
			arguments: {
				upload_id: uploadId,
				chunk_b64: btoa('# Backup Repo\n\n'),
				chunk_index: 0,
				byte_offset: 0,
			},
		});
		await client.callTool({
			name: 'repo_upload_append',
			arguments: {
				upload_id: uploadId,
				chunk_b64: btoa('Stream path verified.\n'),
				chunk_index: 1,
				byte_offset: 15,
			},
		});
		const commitResult = await client.callTool({
			name: 'repo_upload_commit',
			arguments: {
				upload_id: uploadId,
			},
		});
		const commitText = 'text' in commitResult.content[0] ? commitResult.content[0].text : '';
		expect(JSON.parse(commitText)).toMatchObject({
			ok: true,
			data: {
				result: {
					content: {
						path: 'README.md',
						sha: 'backup-uploaded-blob-sha',
					},
					commit: {
						sha: 'backup-commit-sha',
					},
				},
			},
		});

		const hugePayload = btoa('a'.repeat(300_000));
		const tooLargeResult = await client.callTool({
			name: 'repo_update_file',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				branch: 'agent/backup-stream-test',
				path: 'README.md',
				message: 'This should be rejected',
				content_b64: hugePayload,
				expected_blob_sha: 'backup-readme-sha',
			},
		});
		const tooLargeText = 'text' in tooLargeResult.content[0] ? tooLargeResult.content[0].text : '';
		expect(JSON.parse(tooLargeText)).toMatchObject({
			ok: false,
			code: 'repo_update_file_payload_too_large',
		});
		await client.close();
	});

	it('allows repo read and branch write operations for the backup mirror repository', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/opengpt-github-mcp-worker-mirror-backup/contents/README.md') {
				if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
					const payload = JSON.parse(String(init?.body ?? '{}'));
					return new Response(
						JSON.stringify({
							content: {
								path: 'README.md',
								sha: 'backup-readme-updated',
							},
							commit: {
								sha: 'backup-commit-sha',
								message: payload.message,
							},
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response(
					JSON.stringify({
						path: 'README.md',
						name: 'README.md',
						type: 'file',
						content: btoa('# Backup Repo\n'),
						encoding: 'base64',
						sha: 'backup-readme-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const readResult = await client.callTool({
			name: 'repo_get_file',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				path: 'README.md',
			},
		});
		const readText = 'text' in readResult.content[0] ? readResult.content[0].text : '';
		expect(JSON.parse(readText)).toMatchObject({
			ok: true,
			data: {
				path: 'README.md',
				decoded_text: null,
				access_mode: 'summary_first',
			},
		});

		const writeResult = await client.callTool({
			name: 'repo_update_file',
			arguments: {
				owner: 'iusung111',
				repo: 'opengpt-github-mcp-worker-mirror-backup',
				branch: 'agent/backup-write-test',
				path: 'README.md',
				message: 'Verify backup repo MCP write path',
				content_b64: btoa('# Backup Repo\n\nMCP write path verified.\n'),
				expected_blob_sha: 'backup-readme-sha',
			},
		});
		const writeText = 'text' in writeResult.content[0] ? writeResult.content[0].text : '';
		expect(JSON.parse(writeText)).toMatchObject({
			ok: true,
			data: {
				content: {
					path: 'README.md',
				},
				commit: {
					message: 'Verify backup repo MCP write path',
				},
			},
		});
		await client.close();
	});

	it('serves the direct /mcp surface for bearer-authenticated ChatGPT callers', async () => {
		const client = await createDirectMcpBearerClient();
		const jobsListResult = await client.callTool({
			name: 'jobs_list',
			arguments: {},
		});
		const jobsListText = 'text' in jobsListResult.content[0] ? jobsListResult.content[0].text : '';
		expect(JSON.parse(jobsListText)).toMatchObject({
			ok: true,
			data: {
				jobs: expect.any(Array),
			},
		});
		await client.close();
	});

	it('builds a batch permission approval bundle', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				preset: 'implementation_with_workflow',
				reason: 'need one approval for branch creation, code edits, workflow rerun, and queue updates',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				status: 'ready_for_approval',
				bundle: {
					preset: {
						id: 'implementation_with_workflow',
					},
					repos: ['iusung111/OpenGPT'],
					approved_tools: expect.arrayContaining(['repo_create_branch', 'workflow_dispatch', 'job_append_note']),
				},
			},
		});
		await client.close();
	});

	it('links permission approval requests into the job event feed', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-approval-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});

		const permissionResult = await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				preset: 'implementation_with_workflow',
				reason: 'Need approval to continue workflow execution',
				job_id: 'job-approval-1',
				blocked_action: 'workflow_dispatch',
			},
		});
		const permissionText = 'text' in permissionResult.content[0] ? permissionResult.content[0].text : '';
		expect(JSON.parse(permissionText)).toMatchObject({
			ok: true,
			data: {
				notification: {
					job_id: 'job-approval-1',
					status: 'pending_approval',
					blocked_action: 'workflow_dispatch',
				},
			},
		});
		expect((permissionResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.permission_bundle',
			notification: {
				job_id: 'job-approval-1',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'job-approval-1' },
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		expect(JSON.parse(progressText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					run_summary: {
						status: 'pending_approval',
						approval_reason: 'Need approval to continue workflow execution',
					},
					blocking_state: {
						kind: 'approval',
						blocked_action: 'workflow_dispatch',
					},
				},
			},
		});

		const feedResult = await client.callTool({
			name: 'job_event_feed',
			arguments: {
				job_id: 'job-approval-1',
				status: 'pending_approval',
				limit: 10,
			},
		});
		const feedText = 'text' in feedResult.content[0] ? feedResult.content[0].text : '';
		const feedJson = JSON.parse(feedText);
		expect(feedJson.ok).toBe(true);
		expect(
			feedJson.data.items.some(
				(item: { source_layer: string; linked_refs?: { blocked_action?: string } }) =>
					item.source_layer === 'gpt' && item.linked_refs?.blocked_action === 'workflow_dispatch',
			),
		).toBe(true);
		await client.close();
	});

	it('builds repo-scoped incident bundles across all active jobs', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-incident-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});
		await client.callTool({
			name: 'request_permission_bundle',
			arguments: {
				repos: ['iusung111/OpenGPT'],
				reason: 'Need approval before preview deploy',
				job_id: 'job-incident-1',
				blocked_action: 'preview_env_create',
			},
		});

		const bundleResult = await client.callTool({
			name: 'incident_bundle_create',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				scope: 'all_active',
				include_layer_logs: true,
			},
		});
		const bundleText = 'text' in bundleResult.content[0] ? bundleResult.content[0].text : '';
		expect(JSON.parse(bundleText)).toMatchObject({
			ok: true,
			data: {
				repo: 'iusung111/OpenGPT',
				scope: 'all_active',
				runs: expect.arrayContaining([
					expect.objectContaining({
						job_id: 'job-incident-1',
					}),
				]),
				layer_logs: expect.any(Array),
				error_logs: expect.any(Array),
			},
		});
		expect((bundleResult as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
			kind: 'opengpt.notification_contract.incident_bundle',
			scope: 'all_active',
		});
		await client.close();
	});

	it('returns help guidance and request templates for supported work', async () => {
		const client = await createMcpClient();
		const defaultHelpResult = await client.callTool({
			name: 'help',
			arguments: {},
		});
		const defaultHelpText = 'text' in defaultHelpResult.content[0] ? defaultHelpResult.content[0].text : '';
		const defaultHelpPayload = JSON.parse(defaultHelpText);
		expect(defaultHelpPayload).toMatchObject({
			ok: true,
			data: {
				title: 'GitHub MCP work selection guide',
				recommended_workflow: 'real_change',
				request_checklist: expect.arrayContaining(['repo', 'request', 'target_paths']),
				reviewer_workflow: expect.arrayContaining(['call review_prepare_context when a branch or PR is ready for review']),
				review_finding_shape: {
					required: ['severity', 'file', 'summary', 'rationale'],
					optional: ['line_hint', 'required_fix'],
				},
				permission_bundle_recommendation: {
					preset: 'implementation_with_pr',
				},
				recommended_template: expect.objectContaining({
					label: 'Real change with PR',
				}),
				related_workflows: expect.arrayContaining(['main_ready', 'dry_run']),
			},
		});

		const mainHelpResult = await client.callTool({
			name: 'help',
			arguments: {
				query: 'main',
			},
		});
		const mainHelpText = 'text' in mainHelpResult.content[0] ? mainHelpResult.content[0].text : '';
		expect(JSON.parse(mainHelpText)).toMatchObject({
			ok: true,
			data: {
				recommended_workflow: 'main_ready',
				permission_bundle_recommendation: {
					preset: 'implementation_with_workflow',
				},
				recommended_template: {
					label: 'Main-ready change',
				},
			},
		});
		await client.close();
	});

	it('keeps a single active workspace and sorts workspace_list by active repo first', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/repos/sandbox/OpenGPT',
			},
		});
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				workspace_path: '/home/uieseong/workspace/opengpt-github-mcp-worker',
			},
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		let listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		let listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		let listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/OpenGPT',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: false,
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: false,
		});
		await client.close();
	});

	it('returns a concise job progress snapshot with recent notes and audits', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-progress-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-progress-1',
			},
		});
		await client.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-progress-1',
				status: 'working',
				next_actor: 'system',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'inspecting branch cleanup candidates',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'verifying open PR state',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: {
				job_id: 'job-progress-1',
			},
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		const progressJson = JSON.parse(progressText);
		expect(progressJson).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-progress-1',
					latest_note: 'verifying open PR state',
					recent_notes: ['inspecting branch cleanup candidates', 'verifying open PR state'],
				},
			},
		});
		expect(
			progressJson.data.progress.recent_audits.some(
				(item: { event_type: string }) => item.event_type === 'job_append_note',
			),
		).toBe(true);
		await client.close();
	});

	it('retains only the most recent audit records per configured limit', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-audit-retention',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});
		for (let index = 0; index < 6; index += 1) {
			await client.callTool({
				name: 'job_append_note',
				arguments: {
					job_id: 'job-audit-retention',
					note: `note-${index}`,
				},
			});
		}

		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-audit-retention',
				limit: 10,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(auditJson.data.audits).toHaveLength(5);
		expect(auditJson.data.audits.at(-1).event_type).toBe('job_append_note');
		expect(
			auditJson.data.audits.some(
				(item: { event_type: string; payload: { note?: string } }) =>
					item.payload.note === 'note-0',
			),
		).toBe(false);
		await client.close();
	});

	it('returns specific failure code when workflow dispatch is not allowlisted', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'not-allowed.yml',
				ref: 'main',
				inputs: {},
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'workflow_not_allowlisted',
		});
		await client.close();
	});

	it('returns specific failure code when workflow file has no workflow_dispatch trigger', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/actions/workflows/pr-merge.yml') {
				return new Response(
					JSON.stringify({
						id: 1,
						name: 'pr-merge',
						path: '.github/workflows/pr-merge.yml',
						state: 'active',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/pr-merge.yml?ref=main') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/pr-merge.yml',
						name: 'pr-merge.yml',
						type: 'file',
						content: btoa('name: pr-merge\non:\n  pull_request:\n    types: [opened]\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'pr-merge.yml',
				ref: 'main',
				inputs: {
					pull_number: '29',
					merge_method: 'squash',
					delete_branch: true,
				},
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'workflow_missing_dispatch_trigger',
		});
		await client.close();
	});

	it('deduplicates repeated workflow dispatch requests for the same working job', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/actions/workflows/agent-run.yml') {
				return new Response(
					JSON.stringify({
						id: 2,
						name: 'agent-run',
						path: '.github/workflows/agent-run.yml',
						state: 'active',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/OpenGPT/contents/.github/workflows/agent-run.yml?ref=main') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/agent-run.yml',
						name: 'agent-run.yml',
						type: 'file',
						content: btoa('name: agent-run\non:\n  workflow_dispatch:\n'),
						encoding: 'base64',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		});

		const client = await createMcpClient();
		const inputs = {
			job_id: 'job-dispatch-dedupe',
			operation_type: 'run_commands',
			base_branch: 'main',
			target_paths: '',
			instructions_b64: 'eyJjb21tYW5kcyI6W1sicHdkIl1dfQ==',
			dry_run: true,
			auto_improve: true,
		};
		const fingerprint = await buildDispatchFingerprint(
			'iusung111',
			'OpenGPT',
			'agent-run.yml',
			'main',
			inputs,
			0,
		);

		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-dispatch-dedupe',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				status: 'working',
				next_actor: 'system',
				workflow_run_id: 999,
				auto_improve_cycle: 0,
				worker_manifest: {
					dispatch_request: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						workflow_id: 'agent-run.yml',
						ref: 'main',
						inputs,
						fingerprint,
						dispatched_at: new Date().toISOString(),
					},
					last_workflow_run: {
						status: 'queued',
						conclusion: null,
						html_url: null,
					},
				},
			}),
		});

		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'agent-run.yml',
				ref: 'main',
				inputs,
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				deduplicated: true,
			},
		});
		await client.close();
	});

	it('rejects unsafe workspace registration paths', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '../unsafe',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'queue_action_failed',
		});
		await client.close();
	});
});
