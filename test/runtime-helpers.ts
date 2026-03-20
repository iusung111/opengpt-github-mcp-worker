import { env, SELF } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function webhookSignature(body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.WEBHOOK_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return `sha256=${Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
}

export async function createMcpClient(): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			return SELF.fetch(url, init);
		},
	});
	const client = new Client({ name: 'worker-test-client', version: '1.0.0' });
	await client.connect(transport);
	return client;
}

export async function waitFor(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export const queueJsonHeaders = {
	'content-type': 'application/json',
	'x-queue-token': 'test-webhook-secret',
};

export const queueAuthHeaders = {
	'x-queue-token': 'test-webhook-secret',
};
