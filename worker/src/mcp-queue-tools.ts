import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import { createEmptyWorkerManifest } from './job-manifest';
import { ToolAnnotations } from './mcp-overview-tools';
import {
	activateRepoWorkspace,
	ensureBranchAllowed,
	ensureRepoAllowed,
	errorCodeFor,
	fail,
	getDefaultAutoImproveMaxCycles,
	getDefaultBaseBranch,
	queueJson,
	toolText,
} from './utils';

const reviewFindingSchema = z.object({
	severity: z.enum(['low', 'medium', 'high', 'critical']),
	file: z.string().min(1),
	line_hint: z.string().optional(),
	summary: z.string().min(1),
	rationale: z.string().min(1),
	required_fix: z.string().optional(),
});

export function registerQueueTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'job_create',
		{
			description: 'Create a persistent queue job for worker or reviewer loops.',
			inputSchema: {
				job_id: z.string(),
				repo: z.string(),
				base_branch: z.string().default(getDefaultBaseBranch(env)),
				work_branch: z.string().optional(),
				operation_type: z.string().optional(),
				target_paths: z.array(z.string()).default([]),
				next_actor: z.enum(['worker', 'reviewer', 'system']).default('worker'),
				auto_improve_enabled: z.boolean().default(false),
				auto_improve_max_cycles: z.number().int().min(0).default(getDefaultAutoImproveMaxCycles(env)),
			},
			annotations: writeAnnotations,
		},
		async (input) => {
			try {
				ensureRepoAllowed(env, input.repo);
				await activateRepoWorkspace(env, input.repo);
				if (input.work_branch) {
					ensureBranchAllowed(env, input.work_branch);
				}
				const result = await queueJson(env, {
					action: 'job_create',
					job: {
						...input,
						status: 'queued',
						next_actor: input.next_actor,
						auto_improve_cycle: 0,
						worker_manifest: createEmptyWorkerManifest(),
						review_findings: [],
						notes: [],
					},
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_get',
		{
			description: 'Get a queue job by job_id.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_get', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'job_progress',
		{
			description:
				'Get a concise progress snapshot for a queue job, including current status, latest note, and recent audit events. Use this during long read or investigation phases to make progress visible.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_progress', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_progress_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'jobs_list',
		{
			description: 'List queue jobs filtered by status or next actor.',
			inputSchema: {
				status: z.enum(['queued', 'working', 'review_pending', 'rework_pending', 'done', 'failed']).optional(),
				next_actor: z.enum(['worker', 'reviewer', 'system']).optional(),
			},
			annotations: readAnnotations,
		},
		async ({ status, next_actor }) => {
			try {
				const result = await queueJson(env, { action: 'jobs_list', status, next_actor });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'jobs_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'audit_list',
		{
			description: 'List recent audit events for a specific job or global events.',
			inputSchema: {
				job_id: z.string().optional(),
				limit: z.number().int().positive().max(50).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ job_id, limit }) => {
			try {
				const result = await queueJson(env, { action: 'audit_list', job_id, limit });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'audit_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'job_update_status',
		{
			description: 'Manually update the status and next actor of a job.',
			inputSchema: {
				job_id: z.string(),
				status: z.enum(['queued', 'working', 'review_pending', 'rework_pending', 'done', 'failed']),
				next_actor: z.enum(['worker', 'reviewer', 'system']),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, status, next_actor }) => {
			try {
				const result = await queueJson(env, { action: 'job_update_status', job_id, status, next_actor });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_update_status_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_append_note',
		{
			description: 'Append a short text note to a job for progress tracking.',
			inputSchema: {
				job_id: z.string(),
				note: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, note }) => {
			try {
				const result = await queueJson(env, { action: 'job_append_note', job_id, note });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_append_note_failed'), error, writeAnnotations));
			}
		},
	);

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
				const result = await queueJson(env, {
					action: 'job_submit_review',
					job_id,
					review_verdict,
					findings,
					next_action,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_submit_review_failed'), error, writeAnnotations));
			}
		},
	);
}
