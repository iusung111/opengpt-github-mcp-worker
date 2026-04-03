import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { notificationWidgetToolMeta } from '../../mcp-widget-resources';
import { errorCodeFor, fail, queueJson, toolText } from '../../utils';
import {
	missionEventFeedStructuredSchema,
	missionListStructuredSchema,
	missionProgressStructuredSchema,
} from './shared';

const laneSchema = z.object({
	lane_id: z.string(),
	title: z.string(),
	role: z.enum(['planner', 'worker', 'reviewer', 'verifier', 'observer', 'custom']).default('worker'),
	depends_on_lane_ids: z.array(z.string()).default([]),
});

export function registerMissionQueueTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'mission_create',
		{
			description: 'Create a multiagent mission with explicit lane dependencies. The queue scheduler fans out child jobs under one mission id.',
			inputSchema: {
				mission_id: z.string(),
				repo: z.string(),
				base_branch: z.string().default('main'),
				title: z.string(),
				operation_type: z.string().optional(),
				target_paths: z.array(z.string()).default([]),
				max_parallelism: z.number().int().min(1).max(4).default(3),
				yolo_mode: z.boolean().default(false),
				lanes: z.array(laneSchema).min(1),
			},
			outputSchema: missionProgressStructuredSchema,
			annotations: writeAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Creating mission',
				'openai/toolInvocation/invoked': 'Mission ready',
			}),
		},
		async (input) => {
			try {
				return toolText(await queueJson(env, { action: 'mission_create', mission: input as unknown as Record<string, unknown> }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'mission_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'mission_list',
		{
			description: 'List mission summaries for the run console dashboard.',
			inputSchema: {
				status: z.enum(['queued', 'running', 'blocked', 'failed', 'completed', 'cancelled']).optional(),
				repo: z.string().optional(),
			},
			outputSchema: missionListStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Loading missions',
				'openai/toolInvocation/invoked': 'Missions ready',
			}),
		},
		async ({ status, repo }) => {
			try {
				return toolText(await queueJson(env, { action: 'mission_list', mission_status: status, repo_key: repo }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'mission_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'mission_progress',
		{
			description: 'Load the aggregate mission progress plus lane state and linked child job snapshots.',
			inputSchema: { mission_id: z.string() },
			outputSchema: missionProgressStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Loading mission progress',
				'openai/toolInvocation/invoked': 'Mission progress ready',
			}),
		},
		async ({ mission_id }) => {
			try {
				return toolText(await queueJson(env, { action: 'mission_progress', mission_id }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'mission_progress_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'mission_event_feed',
		{
			description: 'Aggregate child job notifications and logs for one mission.',
			inputSchema: {
				mission_id: z.string(),
				limit: z.number().int().positive().max(200).default(50),
			},
			outputSchema: missionEventFeedStructuredSchema,
			annotations: readAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Loading mission events',
				'openai/toolInvocation/invoked': 'Mission events ready',
			}),
		},
		async ({ mission_id, limit }) => {
			try {
				return toolText(await queueJson(env, { action: 'mission_event_feed', mission_id, limit }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'mission_event_feed_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'mission_control',
		{
			description: 'Apply bulk control to all current child jobs in a mission, or toggle mission YOLO mode.',
			inputSchema: {
				mission_id: z.string(),
				action: z.enum(['pause', 'resume', 'cancel', 'retry_failed', 'reconcile', 'enable_yolo', 'disable_yolo']),
			},
			outputSchema: missionProgressStructuredSchema,
			annotations: writeAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Updating mission state',
				'openai/toolInvocation/invoked': 'Mission state updated',
			}),
		},
		async ({ mission_id, action }) => {
			try {
				return toolText(await queueJson(env, { action: 'mission_control', mission_id, mission_control_action: action }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'mission_control_failed'), error, writeAnnotations));
			}
		},
	);
}
