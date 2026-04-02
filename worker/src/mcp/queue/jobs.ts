import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
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
} from '../../utils';
import { browserSessionSeedSchema, createWorkerManifestWithBrowserSessionSeed } from './shared';

export function registerQueueJobTools(
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
				browser_session_seed: browserSessionSeedSchema.optional(),
			},
			annotations: writeAnnotations,
		},
		async (input) => {
			try {
				const { browser_session_seed, ...jobInput } = input;
				ensureRepoAllowed(env, input.repo);
				await activateRepoWorkspace(env, input.repo);
				if (input.work_branch) {
					ensureBranchAllowed(env, input.work_branch);
				}
				return toolText(
					await queueJson(env, {
						action: 'job_create',
						job: {
							...jobInput,
							status: 'queued',
							next_actor: input.next_actor,
							auto_improve_cycle: 0,
							worker_manifest: createWorkerManifestWithBrowserSessionSeed(browser_session_seed),
							review_findings: [],
							notes: [],
						},
					}),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_get',
		{
			description: 'Get a queue job by job_id.',
			inputSchema: { job_id: z.string() },
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				return toolText(await queueJson(env, { action: 'job_get', job_id }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_get_failed'), error, readAnnotations));
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
				return toolText(await queueJson(env, { action: 'job_update_status', job_id, status, next_actor }));
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
				return toolText(await queueJson(env, { action: 'job_append_note', job_id, note }));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_append_note_failed'), error, writeAnnotations));
			}
		},
	);
}
