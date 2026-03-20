import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import { ToolAnnotations } from './mcp-overview-tools';
import {
	activateRepoWorkspace,
	encodeGitHubRef,
	ensureBranchAllowed,
	ensureNotDefaultBranch,
	ensureRepoAllowed,
	errorCodeFor,
	fail,
	getBranchPrefix,
	githubDelete,
	githubGet,
	ok,
	queueJson,
	toolText,
} from './utils';

export function registerCollabTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'branch_cleanup_candidates',
		{
			description:
				'List candidate agent branches that appear safe to clean up. Use this direct cleanup flow before branch deletion instead of workflow dispatch or workflow-file editing.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				per_page: z.number().int().positive().max(100).default(100),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, per_page }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const branchPrefix = getBranchPrefix(env);
				const [branchesData, jobsData] = await Promise.all([
					githubGet(env, `/repos/${owner}/${repo}/branches`, { params: { per_page } }) as Promise<
						Array<{ name?: string; protected?: boolean; commit?: { sha?: string } }>
					>,
					queueJson(env, { action: 'jobs_list' }),
				]);
				const activeJobs = (((jobsData.data?.jobs as unknown[] | undefined) ?? []).filter((item) => {
					const job = item as Record<string, unknown>;
					return job.repo === repoKey && job.status !== 'done' && job.status !== 'failed';
				}) as Array<Record<string, unknown>>);
				const candidates = await Promise.all(
					branchesData
						.filter((branch) => String(branch.name ?? '').startsWith(branchPrefix))
						.map(async (branch) => {
							const branchName = String(branch.name ?? '');
							const pulls = (await githubGet(env, `/repos/${owner}/${repo}/pulls`, {
								params: { state: 'all', head: `${owner}:${branchName}`, per_page: 20 },
							})) as Array<{ number?: number; state?: string; html_url?: string; updated_at?: string }>;
							const openPr = pulls.find((pull) => pull.state === 'open');
							const latestPr = pulls[0];
							const linkedJobs = activeJobs
								.filter((job) => {
									const workBranch = String(job.work_branch ?? '');
									return workBranch === branchName || workBranch.startsWith(`${branchName}-`);
								})
								.map((job) => ({
									job_id: job.job_id,
									status: job.status,
									next_actor: job.next_actor,
								}));
							const cleanupSafe = !openPr && linkedJobs.length === 0;
							return {
								branch_name: branchName,
								protected: Boolean(branch.protected),
								head_sha: branch.commit?.sha ?? null,
								open_pr: openPr
									? {
											number: openPr.number ?? null,
											html_url: openPr.html_url ?? null,
									  }
									: null,
								latest_pr: latestPr
									? {
											number: latestPr.number ?? null,
											state: latestPr.state ?? null,
											html_url: latestPr.html_url ?? null,
											updated_at: latestPr.updated_at ?? null,
									  }
									: null,
								active_jobs: linkedJobs,
								cleanup_safe: cleanupSafe,
								reason: cleanupSafe
									? 'no_open_pr_and_no_active_job'
									: openPr
										? 'open_pr_exists'
										: 'active_job_exists',
							};
						}),
				);
				return toolText(ok({ candidates }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'branch_cleanup_candidates_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'branch_cleanup_execute',
		{
			description:
				'Delete an agent branch directly only when it is allowlisted, not the default branch, has no open PR, and has no active queue job. Do not route branch deletion through workflow dispatch or workflow-file editing.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch_name: z.string(),
			},
			annotations: {
				...writeAnnotations,
				destructiveHint: true,
			},
		},
		async ({ owner, repo, branch_name }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				ensureBranchAllowed(env, branch_name);
				ensureNotDefaultBranch(env, branch_name);
				const [pulls, jobsData] = await Promise.all([
					githubGet(env, `/repos/${owner}/${repo}/pulls`, {
						params: { state: 'open', head: `${owner}:${branch_name}`, per_page: 20 },
					}) as Promise<Array<{ number?: number }>>,
					queueJson(env, { action: 'jobs_list' }),
				]);
				const activeJobs = (((jobsData.data?.jobs as unknown[] | undefined) ?? []).filter((item) => {
					const job = item as Record<string, unknown>;
					const workBranch = String(job.work_branch ?? '');
					return (
						job.repo === repoKey &&
						job.status !== 'done' &&
						job.status !== 'failed' &&
						(workBranch === branch_name || workBranch.startsWith(`${branch_name}-`))
					);
				}) as Array<Record<string, unknown>>);
				if (pulls.length > 0) {
					throw new Error(`branch has open pull request: #${pulls[0].number ?? 'unknown'}`);
				}
				if (activeJobs.length > 0) {
					throw new Error(`branch has active queue job: ${String(activeJobs[0].job_id ?? 'unknown')}`);
				}
				await githubDelete(env, `/repos/${owner}/${repo}/git/refs/heads/${encodeGitHubRef(branch_name)}`);
				return toolText(ok({ branch_name, deleted: true }, { ...writeAnnotations, destructiveHint: true }));
			} catch (error) {
				return toolText(
					fail(errorCodeFor(error, 'branch_cleanup_execute_failed'), error, {
						...writeAnnotations,
						destructiveHint: true,
					}),
				);
			}
		},
	);

	server.registerTool(
		'issue_get',
		{
			description: 'Fetch a GitHub issue from an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				issue_number: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, issue_number }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/issues/${issue_number}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'issue_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_get',
		{
			description: 'Fetch a GitHub pull request from an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				pull_number: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, pull_number }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/pulls/${pull_number}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'pr_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_get_files',
		{
			description: 'List changed files for a pull request in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				pull_number: z.number().int().positive(),
				page: z.number().int().positive().default(1),
				per_page: z.number().int().positive().max(100).default(100),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, pull_number, page, per_page }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const files = (await githubGet(env, `/repos/${owner}/${repo}/pulls/${pull_number}/files`, {
					params: { page, per_page },
				})) as unknown[];
				return toolText(ok({ files }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'pr_get_files_failed'), error, readAnnotations));
			}
		},
	);
}
