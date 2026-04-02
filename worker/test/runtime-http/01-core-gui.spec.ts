import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	mcpAccessHeaders,
	queueAuthHeaders,
	queueJsonHeaders,
	waitFor,
	webhookSignature,
} from '../runtime-helpers';

describe('runtime http surface', () => {

	it('redirects root requests to the GUI entrypoint', async () => {
		const response = await SELF.fetch('https://example.com/', { redirect: 'manual' });
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe('https://example.com/gui/');
	});

	it('returns healthz payload', async () => {
		const response = await SELF.fetch('https://example.com/healthz');
		expect(response.status).toBe(200);
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		service: 'opengpt-github-mcp-worker',
		runtime: 'cloudflare-workers',
		mcp_access_auth_required: false,
		mcp_access_mode: 'disabled',
		direct_mcp_auth_mode: 'disabled',
		chatgpt_mcp_auth_mode: 'oidc_email_allowlist',
		chatgpt_allowed_emails_count: 1,
	});
});

	it('returns protocol negotiation error for unauthenticated direct MCP probes by default', async () => {
		const response = await SELF.fetch('https://example.com/mcp');
		expect(response.status).toBe(406);
	});

	it('rejects unauthenticated ChatGPT MCP requests when bearer auth is required', async () => {
		const response = await SELF.fetch('https://example.com/chatgpt/mcp');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			route: '/chatgpt/mcp',
			auth_type: 'oauth',
		});
	});

	it('returns OAuth protected resource metadata with a reachable documentation URL', async () => {
		const response = await SELF.fetch('https://example.com/.well-known/oauth-protected-resource/chatgpt/mcp');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			resource: 'https://example.com/chatgpt/mcp',
			resource_documentation:
				'https://github.com/iusung111/opengpt-github-mcp-worker/blob/main/docs/CHATGPT_MCP.md',
		});
	});

	it('requires auth for the standalone GUI operator API', async () => {
		const response = await SELF.fetch('https://example.com/gui/api/session');
		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			code: 'unauthorized',
		});
	});

	it('returns browser login config for the standalone GUI without requiring auth', async () => {
		const response = await SELF.fetch('https://example.com/gui/api/auth/config');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			data: {
				auth: {
					enabled: true,
					provider: 'auth0',
					client_id: 'spa-client-id',
					audience: 'chatgpt-mcp-worker',
					scope: 'openid profile email',
					redirect_uri: 'https://example.com/gui/',
					authorization_url: 'https://auth.example.com/authorize',
					token_url: 'https://auth.example.com/oauth/token',
				},
			},
		});
	});

	it('returns a standalone GUI session payload when Access auth is present', async () => {
		const response = await SELF.fetch('https://example.com/gui/api/session', {
			headers: mcpAccessHeaders,
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			data: {
				session: {
					email: 'developer@example.com',
					auth_type: 'access',
				},
				capabilities: {
					live_queue_api: true,
					host_message_bridge: false,
				},
			},
		});
	});

	it('creates and fetches queue jobs', async () => {
		const createResponse = await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-1',
				repo: 'iusung111/Project_OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-1',
				operation_type: 'run_commands',
			}),
		});
		expect(createResponse.status).toBe(200);
		const created = (await createResponse.json()) as {
			ok: boolean;
			data: { job: { job_id: string } };
		};
		expect(created.ok).toBe(true);
		expect(created.data.job.job_id).toBe('job-1');

		const getResponse = await SELF.fetch('https://example.com/queue/job/job-1', {
			headers: queueAuthHeaders,
		});
		expect(getResponse.status).toBe(200);
		const fetched = (await getResponse.json()) as {
			ok: boolean;
			data: { job: { work_branch: string } };
		};
		expect(fetched.ok).toBe(true);
		expect(fetched.data.job.work_branch).toBe('agent/job-1');
	});

	it('lists jobs and controls them through the standalone GUI operator API', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-gui-1',
				repo: 'iusung111/Project_OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-gui-1',
				status: 'working',
				next_actor: 'system',
				auto_improve_enabled: false,
			}),
		});

		const listResponse = await SELF.fetch('https://example.com/gui/api/jobs', {
			headers: mcpAccessHeaders,
		});
		expect(listResponse.status).toBe(200);
		await expect(listResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				jobs: expect.arrayContaining([
					expect.objectContaining({
						job_id: 'job-gui-1',
						repo: 'iusung111/Project_OpenGPT',
					}),
				]),
			},
		});

		const pauseResponse = await SELF.fetch('https://example.com/gui/api/jobs/job-gui-1/control', {
			method: 'POST',
			headers: {
				...mcpAccessHeaders,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				action: 'pause',
				reason: 'Pause from standalone GUI test',
				expected_state: 'active',
			}),
		});
		expect(pauseResponse.status).toBe(200);
		await expect(pauseResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				action: 'pause',
				progress: {
					job_id: 'job-gui-1',
					control_state: {
						state: 'paused',
					},
				},
			},
		});

		const detailResponse = await SELF.fetch('https://example.com/gui/api/jobs/job-gui-1', {
			headers: mcpAccessHeaders,
		});
		expect(detailResponse.status).toBe(200);
		await expect(detailResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-gui-1',
					control_state: {
						state: 'paused',
					},
				},
			},
		});
	});

});
