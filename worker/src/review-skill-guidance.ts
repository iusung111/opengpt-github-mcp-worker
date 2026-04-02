export type ReviewSkillGuidance = {
	preferred_invocation: string;
	alternate_invocations: string[];
	usage: string;
	reason: string;
	trigger_examples: string[];
	mcp_followup: string[];
};

export function buildReviewSkillGuidance(): ReviewSkillGuidance {
	return {
		preferred_invocation: '$gstack-review',
		alternate_invocations: ['$review'],
		usage: 'Use this when the host supports gstack skills and the user is asking for a PR, branch, or diff review.',
		reason: 'Run the gstack pre-landing review workflow before persisting the final MCP queue verdict.',
		trigger_examples: ['review this PR', 'code review', 'check my diff', 'address review feedback'],
		mcp_followup: ['review_prepare_context', 'job_submit_review'],
	};
}
