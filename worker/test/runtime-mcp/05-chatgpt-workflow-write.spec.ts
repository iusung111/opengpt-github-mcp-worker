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

	it('serves the full MCP surface over authenticated /chatgpt/mcp', async () => {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/trees/main?recursive=false') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/README.md') {
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
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'repo_list_tree')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file_summary')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_update_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workflow_dispatch')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'self_deploy')).toBe(true);

		const treeResult = await client.callTool({
			name: 'repo_list_tree',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
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
				repo_key: 'iusung111/OpenGPT',
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
				repo_key: 'iusung111/OpenGPT',
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

	it('reads and updates workflow files over authenticated /chatgpt/mcp', async () => {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/.github/workflows/test.yml') {
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
				repo_key: 'iusung111/OpenGPT',
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
				repo_key: 'iusung111/OpenGPT',
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

	it('keeps unauthenticated ChatGPT bootstrap discovery on the full tool catalog and widget resources', async () => {
		const toolsResponse = await SELF.fetch('https://example.com/chatgpt/mcp', {
			method: 'POST',
			headers: {
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'chatgpt-public-tools-list',
				method: 'tools/list',
				params: {},
			}),
		});
		expect(toolsResponse.status).toBe(200);
		const toolsPayload = (await toolsResponse.json()) as { result?: { tools?: Array<{ name?: string }> } };
		const toolNames = (toolsPayload.result?.tools ?? []).map((tool) => tool.name);
		expect(toolNames).toContain('repo_get_file_summary');
		expect(toolNames).toContain('repo_create_branch');
		expect(toolNames).toContain('repo_update_file');
		expect(toolNames).toContain('workflow_dispatch');
		expect(toolNames).toContain('run_console_open');

		const resourcesResponse = await SELF.fetch('https://example.com/chatgpt/mcp', {
			method: 'POST',
			headers: {
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'chatgpt-public-resources-list',
				method: 'resources/list',
				params: {},
			}),
		});
		expect(resourcesResponse.status).toBe(200);
		const resourcesPayload = (await resourcesResponse.json()) as {
			result?: { resources?: Array<{ uri?: string }> };
		};
		expect((resourcesPayload.result?.resources ?? []).map((resource) => resource.uri)).toContain(
			'ui://widget/notification-center.html',
		);

		const readResponse = await SELF.fetch('https://example.com/chatgpt/mcp', {
			method: 'POST',
			headers: {
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'chatgpt-public-resource-read',
				method: 'resources/read',
				params: {
					uri: 'ui://widget/notification-center.html',
				},
			}),
		});
		expect(readResponse.status).toBe(200);
		const readPayload = (await readResponse.json()) as {
			result?: { contents?: Array<{ uri?: string; text?: string }> };
		};
		expect(
			(readPayload.result?.contents ?? []).find((resource) => resource.uri === 'ui://widget/notification-center.html')
				?.text ?? '',
		).toContain('/gui/app.js');
	});

	it('keeps workflow write tools available over direct /mcp', async () => {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/.github/workflows/test.yml') {
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

		const client = await createMcpClient();
		try {
				const tools = await client.listTools();
				expect(tools.tools.some((tool) => tool.name === 'repo_update_file')).toBe(true);

				const workflowUpdateResult = await client.callTool({
					name: 'repo_update_file',
					arguments: {
						repo_key: 'iusung111/OpenGPT',
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
			} finally {
				await client.close();
			}
	});

	it('rejects local filesystem paths for repo read and write tools', async () => {
		const client = await createMcpClient();
		try {
			await expect(
				client.callTool({
					name: 'repo_get_file',
					arguments: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						path: 'D:\\VScode\\OpenGPT\\README.md',
					},
				}),
			).rejects.toThrow(/invalid repo path/i);

			await expect(
				client.callTool({
					name: 'repo_get_file_summary',
					arguments: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						path: '/home/uieseong/workspace/OpenGPT/README.md',
					},
				}),
			).rejects.toThrow(/repository-relative POSIX paths/i);

			await expect(
				client.callTool({
					name: 'repo_update_file',
					arguments: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						branch: 'agent/invalid-path-test',
						path: 'worker\\src\\index.ts',
						message: 'Test invalid repo path',
						content_b64: btoa('test'),
					},
				}),
			).rejects.toThrow(/forward slashes/i);

			await expect(
				client.callTool({
					name: 'repo_batch_write',
					arguments: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						branch: 'agent/invalid-path-test',
						message: 'Test invalid repo path',
						operations: [
							{
								type: 'create_file',
								path: '/tmp/README.md',
								content_b64: btoa('test'),
							},
						],
					},
				}),
			).rejects.toThrow(/repository-relative POSIX paths/i);
		} finally {
			await client.close();
		}
	});

	it('returns corrective invalid-params hints before raw schema errors for repo identity and repo paths', async () => {
		const repoIdentityResponse = await SELF.fetch('https://example.com/mcp', {
			method: 'POST',
			headers: {
				...mcpAccessHeaders,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'repo-identity-preflight',
				method: 'tools/call',
				params: {
					name: 'workflow_runs_list',
					arguments: {
						repo_key: 7,
						ref: 'main',
					},
				},
			}),
		});
		const repoIdentityJson = await repoIdentityResponse.json();
		expect(repoIdentityJson).toMatchObject({
			error: {
				code: -32602,
				message: expect.stringContaining('repo_key must be a string in owner/repo form'),
			},
		});

		const repoPathResponse = await SELF.fetch('https://example.com/mcp', {
			method: 'POST',
			headers: {
				...mcpAccessHeaders,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'repo-path-preflight',
				method: 'tools/call',
				params: {
					name: 'repo_get_file',
					arguments: {
						repo_key: 'iusung111/OpenGPT',
						path: 99,
					},
				},
			}),
		});
		const repoPathJson = await repoPathResponse.json();
		expect(repoPathJson).toMatchObject({
			error: {
				code: -32602,
				message: expect.stringContaining('path must be a string'),
			},
		});
		expect(repoPathJson.error.message).toContain('repository-relative POSIX paths');
	});

});
