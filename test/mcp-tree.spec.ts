import { SELF } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

async function createMcpClient(): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			return SELF.fetch(url, init);
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
