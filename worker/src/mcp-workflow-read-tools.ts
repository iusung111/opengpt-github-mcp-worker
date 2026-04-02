import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './contracts';
import { ToolAnnotations } from './mcp/contracts';
import {
	ensureRepoAllowed,
	errorCodeFor,
	fail,
	githubGet,
	inspectAllowedWorkflowsForRepo,
	ok,
	toolText,
} from './utils';

export function registerWorkflowReadTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'workflow_allowlist_inspect',
		{
			description:
				'Inspect the effective workflow allowlist for a repository, including repo-managed config, env overrides, the merged result, and precedence rules.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo }) => {
			const repoKey = `${owner}/${repo}`;
			try {
				ensureRepoAllowed(env, repoKey);
				const inspection = inspectAllowedWorkflowsForRepo(env, repoKey);
				return toolText(ok(inspection, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'workflow_allowlist_inspect_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_runs_list',
		{
			description: 'List workflow runs for an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch: z.string().optional(),
				event: z.string().optional(),
				per_page: z.number().int().positive().max(100).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, branch, event, per_page }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
					params: { branch, event, per_page },
				})) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'workflow_runs_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_run_get',
		{
			description: 'Fetch a single workflow run for an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${run_id}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'workflow_run_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_artifacts_list',
		{
			description: 'List artifacts for a workflow run in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${run_id}/artifacts`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'workflow_artifacts_list_failed'), error, readAnnotations));
			}
		},
	);
}


