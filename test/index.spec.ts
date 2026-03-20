import { env, SELF } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { buildDispatchFingerprint } from '../src/utils';

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

async function createMcpClient(): Promise<Client> {
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

async function waitFor(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

const queueJsonHeaders = {
	'content-type': 'application/json',
	'x-queue-token': 'test-webhook-secret',
};

const queueAuthHeaders = {
	'x-queue-token': 'test-webhook-secret',
};

describe('opengpt-github-mcp-worker', () => {
	it('returns healthz payload', async () => {
		const response = await SELF.fetch('https://example.com/healthz');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			service: 'opengpt-github-mcp-worker',
			runtime: 'cloudflare-workers',
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

	it('treats blocked reviews as terminal and respects review rework limit', async () => {
		const blockedClient = await createMcpClient();
		await blockedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-1',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await blockedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-1',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const blockedResult = await blockedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-1',
				review_verdict: 'blocked',
				findings: [],
				next_action: 'security concern',
			},
		});
		const blockedText = 'text' in blockedResult.content[0] ? blockedResult.content[0].text : '';
		expect(JSON.parse(blockedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'failed',
					next_actor: 'system',
					last_error: 'review blocked: security concern',
				},
			},
		});
		await blockedClient.close();

		const limitedClient = await createMcpClient();
		await limitedClient.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-2',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-2',
				auto_improve_enabled: true,
				auto_improve_max_cycles: 1,
			},
		});
		await limitedClient.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-2',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});
		const limitedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'needs another pass',
			},
		});
		const limitedText = 'text' in limitedResult.content[0] ? limitedResult.content[0].text : '';
		expect(JSON.parse(limitedText)).toMatchObject({
			ok: true,
			data: {
				job: {
					status: 'rework_pending',
					next_actor: 'worker',
					auto_improve_cycle: 1,
				},
			},
		});

		const cappedResult = await limitedClient.callTool({
			name: 'job_submit_review',
			arguments: {
				job_id: 'job-review-2',
				review_verdict: 'changes_requested',
				findings: [],
				next_action: 'limit reached',
			},
		});
		const cappedText = 'text' in cappedResult.content[0] ? cappedResult.content[0].text : '';
		expect(JSON.parse(cappedText)).toMatchObject({
			ok: false,
			code: 'invalid_state',
			error: 'job is not waiting for reviewer input',
		});
		await limitedClient.close();
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
					status: 'review_pending',
					next_actor: 'reviewer',
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
				status: 'review_pending',
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

	it('serves MCP tools and queue actions over /mcp', async () => {
		const client = await createMcpClient();
		const tools = await client.listTools();
		expect(tools.tools.some((tool) => tool.name === 'help')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'audit_list')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_candidates')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'branch_cleanup_execute')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_progress')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_work_context')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'repo_get_file')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'job_create')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'pr_merge')).toBe(true);
		expect(tools.tools.some((tool) => tool.name === 'workspace_resolve')).toBe(true);

		const createResult = await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-mcp-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-mcp-1',
				operation_type: 'run_commands',
			},
		});
		const createText = 'text' in createResult.content[0] ? createResult.content[0].text : '';
		expect(JSON.parse(createText)).toMatchObject({
			ok: true,
			data: {
				job: {
					job_id: 'job-mcp-1',
					repo: 'iusung111/OpenGPT',
				},
			},
		});

		const getResult = await client.callTool({
			name: 'job_get',
			arguments: { job_id: 'job-mcp-1' },
		});
		const getText = 'text' in getResult.content[0] ? getResult.content[0].text : '';
		expect(JSON.parse(getText)).toMatchObject({
			ok: true,
			data: {
				job: {
					work_branch: 'agent/job-mcp-1',
				},
			},
		});

		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-mcp-1',
				note: 'reading repo state',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: { job_id: 'job-mcp-1' },
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		expect(JSON.parse(progressText)).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-mcp-1',
					status: 'queued',
					latest_note: 'reading repo state',
					recent_notes: ['reading repo state'],
				},
			},
		});

		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-mcp-1',
				limit: 5,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(auditJson.data.audits.some((item: { event_type: string; payload: { job_id?: string } }) => item.event_type === 'job_create' && item.payload.job_id === 'job-mcp-1')).toBe(true);

		const registerWorkspaceResult = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/github/OpenGPT',
				aliases: ['opengpt'],
			},
		});
		const registerWorkspaceText =
			'text' in registerWorkspaceResult.content[0] ? registerWorkspaceResult.content[0].text : '';
		expect(JSON.parse(registerWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				workspace: {
					repo_key: 'iusung111/OpenGPT',
					workspace_path: '/home/uieseong/workspace/github/OpenGPT',
				},
			},
		});

		const resolveWorkspaceResult = await client.callTool({
			name: 'workspace_resolve',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		const resolveWorkspaceText =
			'text' in resolveWorkspaceResult.content[0] ? resolveWorkspaceResult.content[0].text : '';
		expect(JSON.parse(resolveWorkspaceText)).toMatchObject({
			ok: true,
			data: {
				repo_key: 'iusung111/OpenGPT',
				default_workspace_path: '/home/uieseong/workspace/github/OpenGPT',
				existing_workspace: {
					repo_key: 'iusung111/OpenGPT',
					workspace_path: '/home/uieseong/workspace/github/OpenGPT',
				},
				requires_confirmation: true,
			},
		});
		await client.close();
	});

	it('returns help guidance and request templates for supported work', async () => {
		const client = await createMcpClient();
		const defaultHelpResult = await client.callTool({
			name: 'help',
			arguments: {},
		});
		const defaultHelpText = 'text' in defaultHelpResult.content[0] ? defaultHelpResult.content[0].text : '';
		expect(JSON.parse(defaultHelpText)).toMatchObject({
			ok: true,
			data: {
				summary: expect.stringContaining('GitHub repo ?묒뾽'),
				recommended_workflow: 'real_change',
				how_to_ask: {
					required_minimum: ['repo', '紐⑺몴'],
				},
				workflows: expect.arrayContaining([
					expect.objectContaining({ id: 'real_change', label: '肄붾뱶 ?섏젙怨?PR ?앹꽦' }),
					expect.objectContaining({ id: 'main_ready', label: 'main 諛섏쁺 吏곸쟾源뚯? 以鍮? }),
				]),
			},
		});

		const mainHelpResult = await client.callTool({
			name: 'help',
			arguments: {
				query: 'main??諛섏쁺?섎젮硫??대뼸寃?留먰빐?',
			},
		});
		const mainHelpText = 'text' in mainHelpResult.content[0] ? mainHelpResult.content[0].text : '';
		expect(JSON.parse(mainHelpText)).toMatchObject({
			ok: true,
			data: {
				summary: expect.stringContaining('main 諛섏쁺 ?붿껌'),
				recommended_workflow: 'main_ready',
				recommended_template: {
					label: 'Main-ready change',
				},
			},
		});
		await client.close();
	});

	it('keeps a single active workspace and sorts workspace_list by active repo first', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '/home/uieseong/workspace/OpenGPT',
			},
		});
		await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				workspace_path: '/home/uieseong/workspace/opengpt-github-mcp-worker',
			},
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
			},
		});
		let listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		let listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		let listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/OpenGPT',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: false,
		});

		await client.callTool({
			name: 'workspace_activate',
			arguments: {
				repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		listResult = await client.callTool({
			name: 'workspace_list',
			arguments: {},
		});
		listText = 'text' in listResult.content[0] ? listResult.content[0].text : '';
		listJson = JSON.parse(listText);
		expect(listJson).toMatchObject({
			ok: true,
			data: {
				active_repo_key: 'iusung111/opengpt-github-mcp-worker',
			},
		});
		expect(listJson.data.workspaces[0]).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			is_active: true,
		});
		expect(listJson.data.workspaces[1]).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			is_active: false,
		});
		await client.close();
	});

	it('returns a concise job progress snapshot with recent notes and audits', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-progress-1',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-progress-1',
			},
		});
		await client.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-progress-1',
				status: 'working',
				next_actor: 'system',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'inspecting branch cleanup candidates',
			},
		});
		await client.callTool({
			name: 'job_append_note',
			arguments: {
				job_id: 'job-progress-1',
				note: 'verifying open PR state',
			},
		});

		const progressResult = await client.callTool({
			name: 'job_progress',
			arguments: {
				job_id: 'job-progress-1',
			},
		});
		const progressText = 'text' in progressResult.content[0] ? progressResult.content[0].text : '';
		const progressJson = JSON.parse(progressText);
		expect(progressJson).toMatchObject({
			ok: true,
			data: {
				progress: {
					job_id: 'job-progress-1',
					latest_note: 'verifying open PR state',
					recent_notes: ['inspecting branch cleanup candidates', 'verifying open PR state'],
				},
			},
		});
		expect(progressJson.data.progress.recent_audits.some((item: { event_type: string }) => item.event_type === 'job_append_note')).toBe(true);
		await client.close();
	});

	it('retains only the most recent audit records per configured limit', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-audit-retention',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
			},
		});
		for (let index = 0; index < 6; index += 1) {
			await client.callTool({
				name: 'job_append_note',
				arguments: {
					job_id: 'job-audit-retention',
					note: `note-${index}`,
				},
			});
		}

		const auditResult = await client.callTool({
			name: 'audit_list',
			arguments: {
				job_id: 'job-audit-retention',
				limit: 10,
			},
		});
		const auditText = 'text' in auditResult.content[0] ? auditResult.content[0].text : '';
		const auditJson = JSON.parse(auditText);
		expect(auditJson.ok).toBe(true);
		expect(auditJson.data.audits).toHaveLength(5);
		expect(auditJson.data.audits.at(-1).event_type).toBe('job_append_note');
		expect(auditJson.data.audits.some((item: { event_type: string; payload: { note?: string } }) => item.payload.note === 'note-0')).toBe(false);
		await client.close();
	});

	it('returns specific failure code when workflow dispatch is not allowlisted', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'not-allowed.yml',
				ref: 'main',
				inputs: {},
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'workflow_not_allowlisted',
		});
		await client.close();
	});

	it('deduplicates repeated workflow dispatch requests for the same working job', async () => {
		const client = await createMcpClient();
		const inputs = {
			job_id: 'job-dispatch-dedupe',
			operation_type: 'run_commands',
			base_branch: 'main',
			target_paths: '',
			instructions_b64: 'eyJjb21tYW5kcyI6W1sicHdkIl1dfQ==',
			dry_run: true,
			auto_improve: true,
		};
		const fingerprint = await buildDispatchFingerprint(
			'iusung111',
			'OpenGPT',
			'agent-run.yml',
			'main',
			inputs,
			0,
		);

		await SELF.fetch('https://example.com/queue/job', {
			method: 'POST',
			headers: queueJsonHeaders,
			body: JSON.stringify({
				job_id: 'job-dispatch-dedupe',
				repo: 'iusung111/OpenGPT',
				base_branch: 'main',
				status: 'working',
				next_actor: 'system',
				workflow_run_id: 999,
				auto_improve_cycle: 0,
				worker_manifest: {
					dispatch_request: {
						owner: 'iusung111',
						repo: 'OpenGPT',
						workflow_id: 'agent-run.yml',
						ref: 'main',
						inputs,
						fingerprint,
						dispatched_at: new Date().toISOString(),
					},
					last_workflow_run: {
						status: 'queued',
						conclusion: null,
						html_url: null,
					},
				},
			}),
		});

		const result = await client.callTool({
			name: 'workflow_dispatch',
			arguments: {
				owner: 'iusung111',
				repo: 'OpenGPT',
				workflow_id: 'agent-run.yml',
				ref: 'main',
				inputs,
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				deduplicated: true,
			},
		});
		await client.close();
	});

	it('rejects unsafe workspace registration paths', async () => {
		const client = await createMcpClient();
		const result = await client.callTool({
			name: 'workspace_register',
			arguments: {
				repo_key: 'iusung111/OpenGPT',
				workspace_path: '../unsafe',
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			code: 'queue_action_failed',
		});
		await client.close();
	});
});
