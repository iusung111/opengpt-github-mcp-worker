import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { errorCodeFor, fail, queueJson, toolText } from '../../utils';
import { reviewFindingSchema } from './shared';

export function registerQueueReviewTools(
	server: McpServer,
	env: AppEnv,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'job_submit_review',
		{
			description:
				'Submit a structured review verdict for a job in review_pending state. Use findings with severity, file, summary, rationale, and required_fix so the worker can address exact review issues.',
			inputSchema: {
				job_id: z.string(),
				review_verdict: z.enum(['approved', 'changes_requested', 'blocked']),
				findings: z.array(reviewFindingSchema).default([]),
				next_action: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, review_verdict, findings, next_action }) => {
			try {
				return toolText(
					await queueJson(env, {
						action: 'job_submit_review',
						job_id,
						review_verdict,
						findings,
						next_action,
					}),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_submit_review_failed'), error, writeAnnotations));
			}
		},
	);
}
