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
	}, 15000);

});
