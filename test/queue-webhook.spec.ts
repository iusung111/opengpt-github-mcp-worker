import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function webhookSignature(body: string): Promise<string> {
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

const queueJsonHeaders = {
	'content-type': 'application/json',
	'x-queue-token': 'test-webhook-secret',
};

const queueAuthHeaders = {
	'x-queue-token': 'test-webhook-secret',
};

describe('queue webhook reconciliation', () => {
	it('promotes a working job to review_pending from PR webhook alone', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-pr-only',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-pr-only',
				status: 'working',
				next_actor: 'system',
			}),
		});

		const prBody = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'iusung111/OpenGPT' },
			pull_request: {
				number: 8,
				state: 'open',
				head: { ref: 'agent/job-pr-only-404' },
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
				job_id: 'job-pr-only',
				pr_number: 8,
				work_branch: 'agent/job-pr-only-404',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
	});

	it('matches PR webhook to job_id encoded in agent branch when work_branch is unset', async () => {
		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-branch-hint',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				status: 'working',
				next_actor: 'system',
			}),
		});

		const prBody = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'iusung111/OpenGPT' },
			pull_request: {
				number: 9,
				state: 'open',
				head: { ref: 'agent/job-branch-hint-505' },
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
				job_id: 'job-branch-hint',
				pr_number: 9,
				work_branch: 'agent/job-branch-hint-505',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});

		const getResponse = await SELF.fetch('https://example.com/queue/job/job-branch-hint', {
			headers: queueAuthHeaders,
		});
		await expect(getResponse.json()).resolves.toMatchObject({
			ok: true,
			data: {
				job: {
					work_branch: 'agent/job-branch-hint-505',
					pr_number: 9,
					status: 'review_pending',
					next_actor: 'reviewer',
				},
			},
		});
	});
});
