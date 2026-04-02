import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities } from '../../project-capabilities';
import { buildConfirmToken, validateConfirmToken } from '../../state-tokens';
import { dispatchStandardWorkflow } from '../../workflow-execution';
import {
	ensureBranchAllowed,
	ensureRepoAllowed,
	ensureWorkflowAllowed,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	nowIso,
	ok,
	toolText,
} from '../../utils';
import { readRepoTree } from '../../fullstack/repo-utils';
import { summarizeRun } from '../../fullstack/logic';
import { updateJobState } from '../../fullstack/job-state';
import { dbMutationSchema } from './shared';

export function registerFullstackDatabaseTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'db_schema_inspect',
		{
			description: 'Inspect repository schema and migration paths using project capability metadata.',
			inputSchema: { owner: z.string(), repo: z.string(), ref: z.string().optional() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				const inspectPaths = new Set<string>();
				for (const entry of tree) {
					const entryPath = String(entry.path ?? '');
					if (!entryPath) continue;
					if (capabilities.db.inspect_paths.some((prefix) => entryPath === prefix || entryPath.startsWith(`${prefix}/`))) {
						inspectPaths.add(entryPath);
					}
				}
				return toolText(ok({ repo: repoKey, ref: effectiveRef, db_mode: capabilities.db_mode, inspect_paths: Array.from(inspectPaths).sort() }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_schema_inspect_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'db_migration_apply',
		{
			description: 'Dispatch configured database migration commands through the standard execution workflow.',
			inputSchema: dbMutationSchema,
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.migration_commands.length === 0) throw new Error('db migration commands are not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'db_migration', commands: capabilities.db.migration_commands },
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
					workerManifest: { runtime: { status: result.conclusion === 'success' ? 'ready' : 'failed', updated_at: nowIso() } },
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_migration_apply_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_seed_run',
		{
			description: 'Dispatch configured database seed commands through the standard execution workflow.',
			inputSchema: dbMutationSchema,
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.seed_commands.length === 0) throw new Error('db seed commands are not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'db_seed', commands: capabilities.db.seed_commands },
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_seed_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_reset_prepare',
		{
			description: 'Issue a short-lived signed confirm token for db_reset on an allowlisted repository/ref.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				ttl_minutes: z.number().int().positive().max(30).default(10),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, ttl_minutes }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.reset_commands.length === 0) throw new Error('db reset commands are not configured');
				const issued = await buildConfirmToken(env, { action: 'db_reset', repo: repoKey, ref: effectiveRef, ttl_minutes });
				return toolText(ok({ repo: repoKey, ref: effectiveRef, confirm_token: issued.token, confirm: issued.payload }, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_reset_prepare_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_reset',
		{
			description: 'Run destructive DB reset commands only when the confirm token was minted by db_reset_prepare for the same repo/ref.',
			inputSchema: { ...dbMutationSchema, confirm_token: z.string() },
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds, confirm_token }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				await validateConfirmToken(env, { token: confirm_token, action: 'db_reset', repo: repoKey, ref: effectiveRef });
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.reset_commands.length === 0) throw new Error('db reset commands are not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'db_reset', commands: capabilities.db.reset_commands },
				});
				await updateJobState(env, { jobId: job_id, repoKey, status: result.conclusion === 'success' ? 'working' : 'failed', nextActor: 'system' });
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_reset_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_query_safe',
		{
			description: 'Run a repo-defined DB query command with OPENGPT_QUERY_TEXT passed via the workflow environment.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				query_text: z.string(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, query_text, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (!capabilities.db.query_command) throw new Error('db query command is not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'db_query', query_command: capabilities.db.query_command, query_text },
				});
				await updateJobState(env, { jobId: job_id, repoKey, status: result.conclusion === 'success' ? 'working' : 'failed', nextActor: 'system' });
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_query_safe_failed'), error, writeAnnotations));
			}
		},
	);
}
