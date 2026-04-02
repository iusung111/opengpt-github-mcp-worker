import { describe, expect, it } from 'vitest';
import { createMcpClient } from '../runtime-helpers';

describe('runtime mcp review skill guidance', () => {
	it('returns review skill guidance in reviewer context', async () => {
		const client = await createMcpClient();
		await client.callTool({
			name: 'job_create',
			arguments: {
				job_id: 'job-review-skill-guidance',
				repo: 'iusung111/Project_OpenGPT',
				base_branch: 'main',
				work_branch: 'agent/job-review-skill-guidance',
			},
		});
		await client.callTool({
			name: 'job_update_status',
			arguments: {
				job_id: 'job-review-skill-guidance',
				status: 'review_pending',
				next_actor: 'reviewer',
			},
		});

		const result = await client.callTool({
			name: 'review_prepare_context',
			arguments: {
				job_id: 'job-review-skill-guidance',
				include_recent_audits: false,
				include_workflow_runs: false,
			},
		});
		const text = 'text' in result.content[0] ? result.content[0].text : '';
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			data: {
				review_skill_guidance: {
					preferred_invocation: '$gstack-review',
					alternate_invocations: ['$review'],
					mcp_followup: ['review_prepare_context', 'job_submit_review'],
				},
				reviewer_steps: expect.arrayContaining([
					'if host skills are available, invoke $gstack-review before finalizing the verdict',
				]),
			},
		});
		await client.close();
	});
});
