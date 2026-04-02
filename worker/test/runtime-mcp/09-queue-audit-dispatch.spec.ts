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
	}, 15000);

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
			code: 'invalid_workspace_path',
		});
		await client.close();
	});
});
