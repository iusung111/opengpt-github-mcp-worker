import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import { ToolAnnotations } from './mcp-overview-tools';
import {
	activateRepoWorkspace,
	encodeGitHubPath,
	ensureBranchAllowed,
	ensureNotDefaultBranch,
	ensureRepoAllowed,
	ensureSafePath,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	githubGet,
	githubPost,
	githubPut,
	ok,
	toolText,
} from './utils';

export function registerWriteTools(
	server: McpServer,
	env: AppEnv,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'repo_create_branch',
		{
			description: 'Create an agent branch from the default base branch in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch_name: z.string(),
				base_branch: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, branch_name, base_branch }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch_name);
				await activateRepoWorkspace(env, repoKey);
				const baseRef = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch || getDefaultBaseBranch(env))}`,
				)) as { object?: { sha?: string } };
				const sha = baseRef.object?.sha;
				if (!sha) {
					throw new Error('base branch sha not found');
				}
				const data = (await githubPost(env, `/repos/${owner}/${repo}/git/refs`, {
					ref: `refs/heads/${branch_name}`,
					sha,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_create_branch_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_update_file',
		{
			description: 'Update a file on an agent branch in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				content_b64: z.string(),
				expected_blob_sha: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, branch, path, message, content_b64, expected_blob_sha }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch);
				ensureNotDefaultBranch(env, branch);
				ensureSafePath(path);
				await activateRepoWorkspace(env, repoKey);
				atob(content_b64);
				const payload: Record<string, unknown> = {
					message,
					content: content_b64,
					branch,
				};
				if (expected_blob_sha) {
					payload.sha = expected_blob_sha;
				}
				const data = (await githubPut(
					env,
					`/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`,
					payload,
				)) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_update_file_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_create',
		{
			description: 'Create a pull request in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				title: z.string(),
				body: z.string(),
				head: z.string(),
				base: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, title, body, head, base }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/pulls`, {
					title,
					body,
					head,
					base,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'pr_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_merge',
		{
			description: 'Merge an open pull request in an allowlisted repository when it is ready to land on the base branch.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				pull_number: z.number().int().positive(),
				merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
				commit_title: z.string().optional(),
				commit_message: z.string().optional(),
				expected_head_sha: z.string().optional(),
			},
			annotations: {
				...writeAnnotations,
				destructiveHint: true,
			},
		},
		async ({ owner, repo, pull_number, merge_method, commit_title, commit_message, expected_head_sha }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				const payload: Record<string, unknown> = { merge_method };
				if (commit_title) {
					payload.commit_title = commit_title;
				}
				if (commit_message) {
					payload.commit_message = commit_message;
				}
				if (expected_head_sha) {
					payload.sha = expected_head_sha;
				}
				const data = (await githubPut(
					env,
					`/repos/${owner}/${repo}/pulls/${pull_number}/merge`,
					payload,
				)) as Record<string, unknown>;
				return toolText(ok(data, { ...writeAnnotations, destructiveHint: true }));
			} catch (error) {
				return toolText(
					fail(errorCodeFor(error, 'pr_merge_failed'), error, {
						...writeAnnotations,
						destructiveHint: true,
					}),
				);
			}
		},
	);

	server.registerTool(
		'comment_create',
		{
			description: 'Create an issue or PR comment in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				issue_number: z.number().int().positive(),
				body: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, issue_number, body }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
					body,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'comment_create_failed'), error, writeAnnotations));
			}
		},
	);
}
