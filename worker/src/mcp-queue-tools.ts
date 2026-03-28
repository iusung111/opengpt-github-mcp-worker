import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import { createEmptyWorkerManifest } from './job-manifest';
import { ToolAnnotations } from './mcp-overview-tools';
import { notificationWidgetToolMeta } from './mcp-widget-resources';
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

const notificationReadMeta = notificationWidgetToolMeta({
	'openai/toolInvocation/invoking': 'Loading run status',
	'openai/toolInvocation/invoked': 'Run status ready',
});

const attentionStatusSchema = z.enum(['idle', 'pending_approval', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']);
const sourceLayerSchema = z.enum(['gpt', 'mcp', 'cloudflare', 'repo', 'system']);
const notificationCountsSchema = z
	.object({
		idle: z.number(),
		pending_approval: z.number(),
		running: z.number(),
		paused: z.number(),
		cancelled: z.number(),
		interrupted: z.number(),
		completed: z.number(),
		failed: z.number(),
	})
	.passthrough();
const runSummarySchema = z
	.object({
		run_id: z.string(),
		job_id: z.string().optional(),
		status: attentionStatusSchema,
	})
	.passthrough();
const blockingStateSchema = z
	.object({
		kind: z.enum(['none', 'approval', 'review', 'failure', 'paused', 'cancelled', 'interrupted']),
		reason: z.string().nullable().optional(),
		blocked_action: z.string().nullable().optional(),
		resume_hint: z.string().nullable().optional(),
	})
	.passthrough();
const notificationItemSchema = z
	.object({
		id: z.string(),
		job_id: z.string(),
		run_id: z.string(),
		status: attentionStatusSchema,
		source_layer: sourceLayerSchema,
	})
	.passthrough();
const layerLogEntrySchema = z
	.object({
		id: z.string(),
		job_id: z.string(),
		run_id: z.string(),
		source_layer: sourceLayerSchema,
		level: z.enum(['info', 'warning', 'error']),
	})
	.passthrough();
const jobProgressStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.job_progress'),
		action: z.string().optional(),
		progress: z
			.object({
				job_id: z.string(),
				run_summary: runSummarySchema,
				blocking_state: blockingStateSchema.optional(),
				latest_notification: notificationItemSchema.nullable().optional(),
				notification_counts: notificationCountsSchema.optional(),
			})
			.passthrough(),
		run_summary: runSummarySchema,
		blocking_state: blockingStateSchema.optional(),
		latest_notification: notificationItemSchema.nullable().optional(),
		notification_counts: notificationCountsSchema.optional(),
		resume_strategy: z.string().optional(),
		workflow_cancel: z.object({}).passthrough().nullable().optional(),
	})
	.passthrough();
const jobsListStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.jobs_list'),
		jobs: z.array(
			z
				.object({
					job_id: z.string(),
					run_summary: runSummarySchema.optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();
const jobEventFeedStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.job_event_feed'),
		items: z.array(notificationItemSchema),
		logs: z.array(layerLogEntrySchema),
		counts: notificationCountsSchema,
	})
	.passthrough();

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
			outputSchema: jobProgressStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationReadMeta,
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
			outputSchema: jobsListStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationReadMeta,
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
		'job_event_feed',
		{
			description:
				'List derived MCP notification items and layer logs for one job or across active jobs. Use this when you need the normalized run attention feed rather than raw audit rows.',
			inputSchema: {
				job_id: z.string().optional(),
				status: z.enum(['idle', 'pending_approval', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed']).optional(),
				source_layer: z.enum(['gpt', 'mcp', 'cloudflare', 'repo', 'system']).optional(),
				since: z.string().optional(),
				limit: z.number().int().positive().max(200).default(50),
			},
			outputSchema: jobEventFeedStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Loading run events',
				'openai/toolInvocation/invoked': 'Run events ready',
			}),
		},
		async ({ job_id, status, source_layer, since, limit }) => {
			try {
				const result = await queueJson(env, {
					action: 'job_event_feed',
					job_id,
					attention_status: status,
					source_layer,
					since,
					limit,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_event_feed_failed'), error, readAnnotations));
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
		'job_control',
		{
			description:
				'Pause, resume, cancel, or retry a queue job. Use this from the Run Console when execution should be explicitly held, resumed, cancelled, or re-dispatched.',
			inputSchema: {
				job_id: z.string(),
				action: z.enum(['pause', 'resume', 'cancel', 'retry']),
				reason: z.string().optional(),
				resume_strategy: z.enum(['refresh', 'redispatch']).optional(),
				expected_state: z
					.enum(['active', 'paused', 'cancelled', 'idle', 'pending_approval', 'running', 'interrupted', 'completed', 'failed'])
					.optional(),
			},
			outputSchema: jobProgressStructuredSchema,
			annotations: writeAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Updating run control state',
				'openai/toolInvocation/invoked': 'Run control state updated',
			}),
		},
		async ({ job_id, action, reason, resume_strategy, expected_state }) => {
			try {
				const result = await queueJson(env, {
					action: 'job_control',
					job_id,
					control_action: action,
					reason,
					resume_strategy,
					expected_state,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_control_failed'), error, writeAnnotations));
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
