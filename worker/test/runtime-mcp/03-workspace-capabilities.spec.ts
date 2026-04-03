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

	it('normalizes Windows workspace registrations before returning them', async () => {
		const client = await createMcpClient();
		const registerWorkspaceResult = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				workspace_path: 'D:\\VScode\\projects\\opengpt-github-mcp-worker\\',
			},
		});
		const registerWorkspaceText =
			'text' in registerWorkspaceResult.content[0] ? registerWorkspaceResult.content[0].text : '';
		expect(JSON.parse(registerWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				workspace: {
					repo_key: 'iusung111/opengpt-github-mcp-worker',
					workspace_path: 'D:/VScode/projects/opengpt-github-mcp-worker',
				},
			},
		});

		const resolveWorkspaceResult = await client.callTool({
			name: 'workspace_resolve',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		const resolveWorkspaceText =
			'text' in resolveWorkspaceResult.content[0] ? resolveWorkspaceResult.content[0].text : '';
		expect(JSON.parse(resolveWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				existing_workspace: {
					workspace_path: 'D:/VScode/projects/opengpt-github-mcp-worker',
				},
				recommended_workspace_relative_path: 'projects/opengpt-github-mcp-worker',
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
				repo_key: 'iusung111/Project_OpenGPT',
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/.opengpt/project-capabilities.json?ref=main') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/package.json?ref=main') {
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
				repo_key: 'iusung111/OpenGPT',
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
				repo_key: 'iusung111/OpenGPT',
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

});
