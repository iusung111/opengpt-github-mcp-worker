import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './contracts';
import { getManifestDispatchRequest } from './job-manifest';
import { ToolAnnotations } from './mcp/contracts';
import { buildReviewSkillGuidance } from './review-skill-guidance';
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
		'review_prepare_context',
		{
			description:
				'Prepare a reviewer context bundle for a queued job. Returns the original request, PR details, changed files, workflow runs, queue progress, and a review checklist so GPT can verify correctness before approving or requesting changes.',
			inputSchema: {
				job_id: z.string(),
				include_recent_audits: z.boolean().default(true),
				include_workflow_runs: z.boolean().default(true),
				workflow_run_limit: z.number().int().positive().max(10).default(5),
			},
			annotations: readAnnotations,
		},
		async ({ job_id, include_recent_audits, include_workflow_runs, workflow_run_limit }) => {
			try {
				const reviewSkillGuidance = buildReviewSkillGuidance();
				const jobResult = await queueJson(env, { action: 'job_get', job_id });
				const job = (jobResult.data?.job ?? null) as Record<string, unknown> | null;
				if (!jobResult.ok || !job) {
					return toolText(jobResult);
				}

				const repoKey = String(job.repo ?? '');
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				const [owner, repo] = repoKey.split('/');
				const prNumber = typeof job.pr_number === 'number' ? job.pr_number : null;
				const workBranch = typeof job.work_branch === 'string' ? job.work_branch : null;
				const dispatchRequest = getManifestDispatchRequest(job.worker_manifest);

				const [progressResult, auditResult, prResult, prFilesResult, workflowRunsResult] = await Promise.all([
					queueJson(env, { action: 'job_progress', job_id }),
					include_recent_audits ? queueJson(env, { action: 'audit_list', job_id, limit: 10 }) : Promise.resolve(null),
					prNumber
						? (githubGet(env, `/repos/${owner}/${repo}/pulls/${prNumber}`) as Promise<Record<string, unknown>>)
						: Promise.resolve(null),
					prNumber
						? (githubGet(env, `/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
								params: { page: 1, per_page: 100 },
						  }) as Promise<Array<Record<string, unknown>>>)
						: Promise.resolve([]),
					include_workflow_runs
						? (githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
								params: {
									per_page: workflow_run_limit,
									...(workBranch ? { branch: workBranch } : {}),
								},
						  }) as Promise<{ workflow_runs?: Array<Record<string, unknown>> }>)
						: Promise.resolve({ workflow_runs: [] }),
				]);

				const requestedChange =
					typeof dispatchRequest?.inputs === 'object' && dispatchRequest.inputs
						? ((dispatchRequest.inputs as Record<string, unknown>).request ?? null)
						: null;

				const changedFiles = (prFilesResult ?? []).map((file) => ({
					filename: file.filename ?? null,
					status: file.status ?? null,
					additions: file.additions ?? null,
					deletions: file.deletions ?? null,
					changes: file.changes ?? null,
					patch: file.patch ?? null,
				}));

				return toolText(
					ok(
						{
							job_id,
							repo: repoKey,
							review_skill_guidance: reviewSkillGuidance,
							reviewer_steps: [
								`if host skills are available, invoke ${reviewSkillGuidance.preferred_invocation} before finalizing the verdict`,
								'confirm the requested change and target paths before reading the diff',
								'compare changed files against the expected target paths',
								'check workflow results and queue progress for failed validation or stale state',
								'verify the PR only contains the intended change and no unrelated edits',
								'submit structured findings with severity, file, summary, rationale, and required_fix',
							],
							finding_schema: {
								severity: ['low', 'medium', 'high', 'critical'],
								required_fields: ['severity', 'file', 'summary', 'rationale'],
								optional_fields: ['line_hint', 'required_fix'],
							},
							context: {
								job,
								original_request: {
									request: requestedChange,
									target_paths: job.target_paths ?? [],
									operation_type: job.operation_type ?? null,
									base_branch: job.base_branch ?? null,
									work_branch: workBranch,
								},
								pr: prResult
									? {
											number: prResult.number ?? null,
											title: prResult.title ?? null,
											state: prResult.state ?? null,
											html_url: prResult.html_url ?? null,
											head_ref: (prResult.head as Record<string, unknown> | undefined)?.ref ?? null,
											base_ref: (prResult.base as Record<string, unknown> | undefined)?.ref ?? null,
									  }
									: null,
								changed_files: changedFiles,
								workflow_runs: (workflowRunsResult.workflow_runs ?? []).map((run) => ({
									id: run.id ?? null,
									name: run.name ?? null,
									event: run.event ?? null,
									status: run.status ?? null,
									conclusion: run.conclusion ?? null,
									html_url: run.html_url ?? null,
									head_branch: run.head_branch ?? null,
									created_at: run.created_at ?? null,
								})),
								queue_progress: progressResult?.data?.progress ?? null,
								recent_audits: auditResult?.data?.audits ?? [],
							},
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'review_prepare_context_failed'), error, readAnnotations));
			}
		},
	);

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


