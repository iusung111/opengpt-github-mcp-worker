import { describe, expect, it } from 'vitest';
import { buildHelpPayload } from '../src/overview/logic';
import { buildReviewSkillGuidance } from '../src/review-skill-guidance';

describe('review skill guidance', () => {
	it('publishes the preferred gstack review invocation', () => {
		expect(buildReviewSkillGuidance()).toMatchObject({
			preferred_invocation: '$gstack-review',
			alternate_invocations: ['$review'],
			mcp_followup: ['review_prepare_context', 'job_submit_review'],
		});
	});

	it('includes review skill guidance in help payloads', () => {
		expect(buildHelpPayload('review')).toMatchObject({
			recommended_workflow: 'review_followup',
			review_skill_guidance: {
				preferred_invocation: '$gstack-review',
				alternate_invocations: ['$review'],
			},
			reviewer_workflow: expect.arrayContaining([
				'if host skills are available, invoke $gstack-review before writing the final review verdict',
			]),
		});
	});
});
