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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/docs/new-file.md') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/docs/upsert-file.md?ref=agent%2Fupsert-file-test') {
				return new Response(
					JSON.stringify({
						path: 'docs/upsert-file.md',
						type: 'file',
						sha: 'existing-upsert-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/docs/upsert-file.md') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/ref/heads/agent/workflow-stream-test') {
				return new Response(
					JSON.stringify({
						object: {
							sha: 'workflow-base-ref-sha',
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/.github/workflows/test.yml?ref=agent%2Fworkflow-stream-test') {
				return new Response(
					JSON.stringify({
						path: '.github/workflows/test.yml',
						type: 'file',
						sha: 'workflow-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/commits/workflow-base-ref-sha') {
				return new Response(
					JSON.stringify({
						tree: {
							sha: 'workflow-base-tree-sha',
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/blobs') {
				const payload = JSON.parse(String(init?.body ?? '{}'));
				expect(payload.encoding).toBe('base64');
				return new Response(
					JSON.stringify({
						sha: 'workflow-uploaded-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/trees') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/commits' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
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
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/refs/heads/agent/workflow-stream-test') {
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

});
