import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	queueAuthHeaders,
	queueJsonHeaders,
	waitFor,
	webhookSignature,
} from './runtime-helpers';

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

	it('creates and fetches queue jobs', async () => {
		const createResponse = await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-1',
				repo: 'iusung111/OpenGPT',
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

	it('rejects unauthenticated queue access', async () => {
		const response = await SELF.fetch('https://example.com/queue/jobs');
		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			code: 'unauthorized',
			error: 'invalid queue token',
		});
	});

	it('updates queue state from webhook payload', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-2',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-2',
				status: 'working',
				next_actor: 'system',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 2,
			}),
		});

		const body = JSON.stringify({
			action: 'completed',
			repository: { full_name: 'iusung111/OpenGPT' },
			workflow_run: {
				id: 101,
				head_branch: 'agent/job-2',
				name: 'pr-validate',
				status: 'completed',
				conclusion: 'failure',
			},
		});
		const response = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-GitHub-Event': 'workflow_run',
				'X-Hub-Signature-256': await webhookSignature(body),
			},
			body,
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			outcome: {
				matched: true,
				status: 'rework_pending',
				next_actor: 'worker',
			},
		});
	});

	it('reconciles stale working jobs to rework when no workflow run is linked', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-stale-working',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-stale-working',
				status: 'working',
				next_actor: 'system',
				auto_improve_enabled: false,
			}),
		});

		await waitFor(35);

		const getResponse = await SELF.fetch('https://example.com/queue/job/job-stale-working', {
			headers: queueAuthHeaders,
		});
		await expect(getResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'rework_pending',
					next_actor: 'worker',
					stale_reason: 'working_timeout',
				},
			},
		});
	});

	it('marks stale review jobs for visibility without changing reviewer ownership', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-stale-review',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-stale-review',
				status: 'review_pending',
				next_actor: 'reviewer',
			}),
		});

		await waitFor(35);

		const getResponse = await SELF.fetch('https://example.com/queue/job/job-stale-review', {
			headers: queueAuthHeaders,
		});
		await expect(getResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'review_pending',
					next_actor: 'reviewer',
					stale_reason: 'review_timeout',
				},
			},
		});
	});

	it('does not append duplicate stale review notes on repeated reads', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-stale-review-repeat',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-stale-review-repeat',
				status: 'review_pending',
				next_actor: 'reviewer',
			}),
		});

		await waitFor(35);

		await SELF.fetch('https://example.com/queue/job/job-stale-review-repeat', {
			headers: queueAuthHeaders,
		});
		const second = await SELF.fetch('https://example.com/queue/job/job-stale-review-repeat', {
			headers: queueAuthHeaders,
		});
		await expect(second.json()).resolves.toMatchObject({
			ok: true,
			data: {
				job: {
					stale_reason: 'review_timeout',
					notes: ['review pending beyond configured threshold'],
				},
			},
		});
	});

	it('preserves agent work branch when workflow_run is linked by run id from main ref', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-3',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-3',
				workflow_run_id: 303,
				status: 'working',
				next_actor: 'system',
			}),
		});

		const workflowBody = JSON.stringify({
			action: 'completed',
			repository: { full_name: 'iusung111/OpenGPT' },
			workflow_run: {
				id: 303,
				head_branch: 'main',
				name: 'agent-run',
				status: 'completed',
				conclusion: 'success',
			},
		});
		const workflowResponse = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-GitHub-Event': 'workflow_run',
				'X-Hub-Signature-256': await webhookSignature(workflowBody),
			},
			body: workflowBody,
		});
		expect(workflowResponse.status).toBe(200);

		const prBody = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'iusung111/OpenGPT' },
			pull_request: {
				number: 7,
				head: { ref: 'agent/job-3-303' },
			},
		});
		const prResponse = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-GitHub-Event': 'pull_request',
				'X-Hub-Signature-256': await webhookSignature(prBody),
			},
			body: prBody,
		});
		expect(prResponse.status).toBe(200);
		await expect(prResponse.json()).resolves.toMatchObject({
			ok: true,
			outcome: {
				matched: true,
				job_id: 'job-3',
				pr_number: 7,
				work_branch: 'agent/job-3-303',
			},
		});

		const getResponse = await SELF.fetch('https://example.com/queue/job/job-3', {
			headers: queueAuthHeaders,
		});
		await expect(getResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				job: {
					work_branch: 'agent/job-3-303',
					pr_number: 7,
					status: 'working',
					next_actor: 'system',
				},
			},
		});
	});

	it('rejects webhook for unallowlisted repo', async () => {
		const body = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'other/repo' },
			pull_request: {
				number: 5,
				head: { ref: 'agent/job-x' },
			},
		});
		const response = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-GitHub-Event': 'pull_request',
				'X-Hub-Signature-256': await webhookSignature(body),
			},
			body,
		});
		expect(response.status).toBe(403);
	});

	it('deduplicates repeated webhook deliveries by GitHub delivery id', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-dup-webhook',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-dup-webhook',
				status: 'working',
				next_actor: 'system',
			}),
		});

		const body = JSON.stringify({
			action: 'completed',
			repository: { full_name: 'iusung111/OpenGPT' },
			workflow_run: {
				id: 515,
				head_branch: 'agent/job-dup-webhook',
				name: 'agent-run',
				status: 'completed',
				conclusion: 'success',
			},
		});
		const headers = {
			'content-type': 'application/json',
			'X-GitHub-Event': 'workflow_run',
			'X-GitHub-Delivery': 'delivery-515',
			'X-Hub-Signature-256': await webhookSignature(body),
		};

		const first = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers,
			body,
		});
		await expect(first.json()).resolves.toMatchObject({
			ok: true,
			outcome: {
				matched: true,
				job_id: 'job-dup-webhook',
				status: 'working',
			},
		});

		const second = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers,
			body,
		});
		await expect(second.json()).resolves.toMatchObject({
			ok: true,
			outcome: {
				matched: false,
				duplicate: true,
				delivery_id: 'delivery-515',
			},
		});
	});

	it('evicts old delivery dedupe records when retention limit is exceeded', async () => {
		const body = JSON.stringify({
			action: 'completed',
			repository: { full_name: 'iusung111/OpenGPT' },
			workflow_run: {
				id: 9991,
				head_branch: 'agent/no-match',
				name: 'agent-run',
				status: 'completed',
				conclusion: 'success',
			},
		});

		for (const deliveryId of ['delivery-a', 'delivery-b', 'delivery-c', 'delivery-d']) {
			const response = await SELF.fetch('https://example.com/webhooks/github', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'X-GitHub-Event': 'workflow_run',
					'X-GitHub-Delivery': deliveryId,
					'X-Hub-Signature-256': await webhookSignature(body),
				},
				body,
			});
			await expect(response.json()).resolves.toMatchObject({
				ok: true,
				outcome: {
					matched: false,
				},
			});
		}

		const recycled = await SELF.fetch('https://example.com/webhooks/github', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-GitHub-Event': 'workflow_run',
				'X-GitHub-Delivery': 'delivery-a',
				'X-Hub-Signature-256': await webhookSignature(body),
			},
			body,
		});
		const recycledJson = await recycled.json();
		expect(recycledJson).toMatchObject({
			ok: true,
			outcome: {
				matched: false,
			},
		});
		expect(recycledJson.outcome.duplicate).not.toBe(true);
	});
});
