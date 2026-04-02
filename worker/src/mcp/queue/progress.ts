import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { notificationWidgetToolMeta } from '../../mcp-widget-resources';
import { errorCodeFor, fail, queueJson, toolText } from '../../utils';
import {
	jobEventFeedStructuredSchema,
	jobProgressStructuredSchema,
	jobsListStructuredSchema,
	notificationReadMeta,
} from './shared';

export function registerQueueProgressTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'job_progress',
		{
			description:
				'Get a concise progress snapshot for a queue job, including current status, latest note, and recent audit events. Use this during long read or investigation phases to make progress visible.',
			inputSchema: { job_id: z.string() },
			outputSchema: jobProgressStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationReadMeta,
		},
		async ({ job_id }) => {
			try {
				return toolText(await queueJson(env, { action: 'job_progress', job_id }));
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
				return toolText(await queueJson(env, { action: 'jobs_list', status, next_actor }));
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
				status: z
					.enum(['idle', 'pending_approval', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed'])
					.optional(),
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
				return toolText(
					await queueJson(env, {
						action: 'job_event_feed',
						job_id,
						attention_status: status,
						source_layer,
						since,
						limit,
					}),
				);
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
				return toolText(await queueJson(env, { action: 'audit_list', job_id, limit }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'audit_list_failed'), error, readAnnotations));
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
				return toolText(
					await queueJson(env, {
						action: 'job_control',
						job_id,
						control_action: action,
						reason,
						resume_strategy,
						expected_state,
					}),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_control_failed'), error, writeAnnotations));
			}
		},
	);
}
