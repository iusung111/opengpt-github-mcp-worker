import { SELF } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { matchesTreePathScope } from '../src/mcp-repo-read-tools';
import { mcpAccessHeaders } from './runtime-helpers';

async function createMcpClient(): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			for (const [key, value] of Object.entries(mcpAccessHeaders)) {
				headers.set(key, value);
			}
			return SELF.fetch(url, {
				...init,
				headers,
			});
		},
	});
	const client = new Client({ name: 'worker-tree-test-client', version: '1.0.0' });
	await client.connect(transport);
	return client;
}

describe('repo_tree_snapshot tool', () => {
	it('is exposed by the MCP server', async () => {
		const client = await createMcpClient();
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'repo_tree_snapshot')).toBe(true);
		await client.close();
	});
});

describe('matchesTreePathScope', () => {
	it('only includes the requested directory boundary', () => {
		expect(matchesTreePathScope('src/index.ts', 'src')).toBe(true);
		expect(matchesTreePathScope('src', 'src')).toBe(true);
		expect(matchesTreePathScope('src2/index.ts', 'src')).toBe(false);
	});

	it('normalizes leading and trailing slashes in the requested path', () => {
		expect(matchesTreePathScope('src/index.ts', '/src/')).toBe(true);
		expect(matchesTreePathScope('src2/index.ts', '/src/')).toBe(false);
	});
});
