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
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file_summary')).toBe(true);
		await client.close();
	});

});
