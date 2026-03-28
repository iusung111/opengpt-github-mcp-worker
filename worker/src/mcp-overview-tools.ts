import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seal } from 'tweetsodium';
import * as z from 'zod/v4';
import { cloudflarePut } from './cloudflare';
import { buildPermissionBundleMessage, listPermissionPresets, listToolGroups } from './tool-catalog';
import { AppEnv } from './types';
import {
	activateRepoWorkspace,
	errorCodeFor,
	fail,
	getBranchPrefix,
	getDefaultBaseBranch,
	getSelfCurrentUrl,
	getSelfDefaultDeployTarget,
	getSelfDeployWorkflow,
	getSelfLiveUrl,
	getSelfMirrorUrl,
	getSelfRepoKey,
	githubGet,
	githubPost,
	githubPut,
	ok,
	nowIso,
	queueJson,
	selfRequiresMirrorForLive,
	toolText,
	ensureRepoAllowed,
} from './utils';

export interface ToolAnnotations extends Record<string, unknown> {
	readOnlyHint: boolean;
	openWorldHint: boolean;
	destructiveHint?: boolean;
}

function queueActionResult(
	result: { ok: boolean; code?: string | null; error?: string | null; data?: Record<string, unknown> | null },
	meta: Record<string, unknown>,
) {
	if (result.ok) {
		return toolText({ ...result, meta });
	}
	return toolText(fail('queue_action_failed', result.error ?? result.code ?? 'queue action failed', meta));
}

async function queueJsonOrThrow(
	env: AppEnv,
	payload: Parameters<typeof queueJson>[1],
	fallbackMessage: string,
) {
	const result = await queueJson(env, payload);
	if (!result.ok) {
		throw new Error(result.error ?? result.code ?? fallbackMessage);
	}
	return result;
}

async function fetchHealthSnapshot(
	baseUrl: string | null,
	currentUrl?: string | null,
): Promise<Record<string, unknown> | null> {
	if (!baseUrl) {
		return null;
	}
	if (currentUrl && baseUrl === currentUrl) {
		return {
			url: baseUrl,
			ok: true,
			skipped: true,
			note: 'skipped self-fetch for current worker url; use external health checks for this endpoint',
		};
	}
	try {
		const response = await fetch(`${baseUrl}/healthz`);
		const contentType = response.headers.get('content-type') ?? '';
		const payload = contentType.includes('application/json') ? await response.json() : await response.text();
		return {
			url: baseUrl,
			ok: response.ok,
			status: response.status,
			payload,
		};
	} catch (error) {
		return {
			url: baseUrl,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function mirrorConfigured(env: AppEnv): boolean {
	const liveUrl = getSelfLiveUrl(env);
	const mirrorUrl = getSelfMirrorUrl(env);
	return Boolean(liveUrl && mirrorUrl && liveUrl !== mirrorUrl);
}

function decodeBase64Bytes(value: string): Uint8Array {
	const binary = atob(value.replace(/\n/g, ''));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Bytes(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function getWorkerScriptNameFromUrl(url: string | null): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).hostname.split('.')[0] ?? null;
	} catch {
		return null;
	}
}

function normalizeHelpQuery(query: string | undefined): string {
	return (query ?? '').trim().toLowerCase();
}

function helpContextForWorkflow(workflow: 'real_change' | 'main_ready' | 'dry_run' | 'review_followup') {
	const permissionPresetByWorkflow = {
		real_change: 'implementation_with_pr',
		main_ready: 'implementation_with_workflow',
		dry_run: 'repo_readonly_review',
		review_followup: 'review_followup',
	} as const;

	const whenToUseByWorkflow = {
		real_change: 'Use this when the user wants a concrete repository change and expects a branch plus pull request.',
		main_ready: 'Use this when the user wants a merge-ready result, not just a draft branch or dry run.',
		dry_run: 'Use this when the user wants validation, investigation, or a no-commit rehearsal.',
		review_followup: 'Use this when the user is responding to review findings on an existing branch or pull request.',
	} as const;

	return {
		recommended_permission_preset: permissionPresetByWorkflow[workflow],
		when_to_use: whenToUseByWorkflow[workflow],
	};
}

function buildHelpPayload(query: string | undefined): Record<string, unknown> {
	const normalized = normalizeHelpQuery(query);
	const templates = {
		real_change: {
			label: 'Real change with PR',
			prompt: [
				'Make a real change in the target repo and keep local planning or artifacts under projects/<project-slug>.',
				'- repo: <owner/repo>',
				'- local_project_path: projects/<project-slug>',
				'- job_id: change-001',
				'- request: <exact user-facing or code-facing change>',
				'- target_paths: <path>',
				'- dry_run: false',
				'- done_when: branch is pushed and a PR is created',
			].join('\n'),
		},
		main_ready: {
			label: 'Main-ready change',
			prompt: [
				'Prepare a real change in the target repo so it is ready for merge to main, with local project context stored under projects/<project-slug>.',
				'- repo: <owner/repo>',
				'- local_project_path: projects/<project-slug>',
				'- job_id: main-ready-001',
				'- request: <exact user-facing or code-facing change>',
				'- target_paths: <path>',
				'- dry_run: false',
				'- done_when: validation is complete, branch is pushed, PR is created, and merge is attempted if allowed',
			].join('\n'),
		},
		dry_run: {
			label: 'Dry run',
			prompt: [
				'Run a dry-run request for the target repo without creating a final branch or PR.',
				'- repo: <owner/repo>',
				'- local_project_path: projects/<project-slug>',
				'- job_id: dry-run-001',
				'- request: <exact user-facing or code-facing change>',
				'- target_paths: <path>',
				'- dry_run: true',
				'- done_when: validation completes and the queue captures the result without merge intent',
			].join('\n'),
		},
		review_followup: {
			label: 'Review follow-up',
			prompt: [
				'Follow up on an existing PR review request.',
				'- repo: <owner/repo>',
				'- local_project_path: projects/<project-slug>',
				'- branch or PR: <existing branch or PR>',
				'- request: <review feedback summary>',
				'- done_when: review findings are addressed and the PR is updated',
			].join('\n'),
		},
	};
	const permissionPresets = listPermissionPresets().map((preset) => ({
		id: preset.id,
		label: preset.label,
		capabilities: preset.capabilities,
	}));

	let recommendedWorkflow: 'real_change' | 'main_ready' | 'dry_run' | 'review_followup' = 'real_change';
	let summary =
		'Include the repo, the exact requested change, expected target paths, dry_run intent, and what counts as done.';
	let relatedWorkflows = ['main_ready', 'dry_run', 'review_followup'];

	if (normalized.includes('main')) {
		recommendedWorkflow = 'main_ready';
		summary = 'Use this when the user wants a real change prepared all the way to a merge-ready PR on main.';
		relatedWorkflows = ['real_change', 'dry_run', 'review_followup'];
	} else if (normalized.includes('dry') || normalized.includes('test')) {
		recommendedWorkflow = 'dry_run';
		summary = 'Use this when the user wants validation, investigation, or a no-commit rehearsal without a real merge path.';
		relatedWorkflows = ['real_change', 'main_ready'];
	} else if (normalized.includes('review')) {
		recommendedWorkflow = 'review_followup';
		summary = 'Use this when the user is responding to review feedback on an existing branch or pull request.';
		relatedWorkflows = ['real_change', 'main_ready'];
	}

	const context = helpContextForWorkflow(recommendedWorkflow);
	return {
		title: 'GitHub MCP work selection guide',
		summary,
		recommended_workflow: recommendedWorkflow,
		recommended_template: templates[recommendedWorkflow],
		related_workflows: relatedWorkflows,
		when_to_use: context.when_to_use,
		quick_start: [
			'pick the workflow that matches the user intent',
			'fill repo, request, target_paths, dry_run, and done_when explicitly',
			'request a single permission bundle early if the run will need multiple write actions',
			'start repository exploration with repo_navigation_manifest or repo_context_snapshot before reading full files',
			'prefer repo_get_file_summary and repo_get_file_chunk over repo_get_file for large docs, workflows, and tool files',
			'prefer job_progress for concise status and audit_list only for full timeline review',
		],
		reviewer_workflow: [
			'call review_prepare_context when a branch or PR is ready for review',
			'compare the original request, target paths, and changed files before deciding the verdict',
			'check workflow runs for failing validation or incomplete execution',
			'submit job_submit_review with structured findings instead of a free-form verdict',
		],
		review_finding_shape: {
			required: ['severity', 'file', 'summary', 'rationale'],
			optional: ['line_hint', 'required_fix'],
		},
		request_checklist: ['repo', 'request', 'target_paths', 'dry_run', 'done_when'],
		permission_bundle_recommendation: {
			preset: context.recommended_permission_preset,
			why: 'Use one up-front approval bundle when the run will touch multiple tools or follow-up actions.',
		},
		workflow_choices: {
			real_change: { label: templates.real_change.label, when_to_use: helpContextForWorkflow('real_change').when_to_use },
			main_ready: { label: templates.main_ready.label, when_to_use: helpContextForWorkflow('main_ready').when_to_use },
			dry_run: { label: templates.dry_run.label, when_to_use: helpContextForWorkflow('dry_run').when_to_use },
			review_followup: { label: templates.review_followup.label, when_to_use: helpContextForWorkflow('review_followup').when_to_use },
		},
		tool_group_summary: listToolGroups().map((group) => ({
			id: group.id,
			label: group.label,
			description: group.description,
		})),
		permission_presets: permissionPresets,
	};
}

export function registerOverviewTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool('help', { description: 'Explain what kinds of GitHub work this MCP server can do and return example request templates. Use this when the user asks what work is possible or how to phrase a request.', inputSchema: { query: z.string().optional() }, annotations: readAnnotations }, async ({ query }) => {
		try { return toolText(ok(buildHelpPayload(query), readAnnotations)); } catch (error) { return toolText(fail(errorCodeFor(error, 'help_failed'), error, readAnnotations)); }
	});
	server.registerTool('request_permission_bundle', { description: 'Build a batch approval bundle for one or more repositories so the user can approve the smallest useful set of MCP actions in one step.', inputSchema: { repos: z.array(z.string()).min(1).describe('List of owner/repo'), preset: z.enum(listPermissionPresets().map((preset) => preset.id) as [string, ...string[]]).optional(), capabilities: z.array(z.enum(['read', 'write', 'workflow', 'review', 'workspace', 'queue', 'self_host'])).default([]), extra_tools: z.array(z.string()).default([]).describe('Optional extra tools to include explicitly'), reason: z.string().describe('Why are these permissions needed?'), job_id: z.string().optional(), blocked_action: z.string().optional() }, annotations: readAnnotations }, async ({ repos, preset, capabilities, extra_tools, reason, job_id, blocked_action }) => {
		try {
			let notification: Record<string, unknown> | null = null;
			if (job_id) {
				const jobResult = await queueJsonOrThrow(env, { action: 'job_get', job_id }, `failed to load job ${job_id}`);
				const job = (jobResult.data?.job ?? null) as Record<string, unknown> | null;
				const jobRepo = typeof job?.repo === 'string' ? job.repo : null;
				if (!jobRepo) {
					throw new Error(`job repo missing for ${job_id}`);
				}
				if (!repos.includes(jobRepo)) {
					throw new Error(`job repo ${jobRepo} must be included in repos`);
				}
				const requestedAt = nowIso();
				await queueJsonOrThrow(env, {
					action: 'job_upsert',
					job: {
						job_id,
						repo: jobRepo,
						worker_manifest: {
							attention: {
								approval: {
									pending: true,
									reason,
									blocked_action: blocked_action ?? null,
									requested_at: requestedAt,
									cleared_at: null,
								},
							},
						},
					},
				}, `failed to update approval state for ${job_id}`);
				await queueJsonOrThrow(env, {
					action: 'audit_write',
					event_type: 'job_attention_approval_requested',
					payload: {
						job_id,
						repo: jobRepo,
						reason,
						blocked_action: blocked_action ?? null,
						source_layer: 'gpt',
						attention_status: 'pending_approval',
						title: 'Approval requested',
						message: reason,
						dedupe_key: `approval_requested:${job_id}:${blocked_action ?? 'generic'}`,
						requested_at: requestedAt,
					},
				}, `failed to write approval audit for ${job_id}`);
				notification = {
					job_id,
					run_id: job_id,
					status: 'pending_approval',
					source_layer: 'gpt',
					blocked_action: blocked_action ?? null,
					reason,
					requested_at: requestedAt,
				};
			}
			return toolText(
				ok(
					{
						status: 'ready_for_approval',
						available_presets: listPermissionPresets(),
						available_tool_groups: listToolGroups().map((group) => ({
							id: group.id,
							label: group.label,
							description: group.description,
						})),
						bundle: buildPermissionBundleMessage({
							repos,
							reason,
							preset,
							capabilities,
							extraTools: extra_tools,
						}),
						notification,
					},
					readAnnotations,
				),
			);
		} catch (error) { return toolText(fail(errorCodeFor(error, 'request_permission_bundle_failed'), error, readAnnotations)); }
	});
	server.registerTool('repo_work_context', { description: 'Use the GitHub repository itself as the primary working context instead of a local folder. Returns open agent PRs, active queue jobs, and recent workflow runs so chat can continue work in stages.', inputSchema: { owner: z.string(), repo: z.string(), include_completed_jobs: z.boolean().default(false) }, annotations: readAnnotations }, async ({ owner, repo, include_completed_jobs }) => {
		const repoKey = `${owner}/${repo}`;
		try {
			ensureRepoAllowed(env, repoKey);
			await activateRepoWorkspace(env, repoKey);
			const [repoData, prsData, runsData, jobsData, workspaceData] = await Promise.all([
				githubGet(env, `/repos/${owner}/${repo}`) as Promise<Record<string, unknown>>,
				githubGet(env, `/repos/${owner}/${repo}/pulls`, { params: { state: 'open', per_page: 20 } }) as Promise<Array<Record<string, unknown>>>,
				githubGet(env, `/repos/${owner}/${repo}/actions/runs`, { params: { per_page: 10 } }) as Promise<{ workflow_runs?: Array<Record<string, unknown>> }>,
				queueJson(env, { action: 'jobs_list' }),
				queueJson(env, { action: 'workspace_get', repo_key: repoKey }),
			]);
			const branchPrefix = getBranchPrefix(env);
			const openAgentPrs = prsData.filter((item) => String(((item.head ?? null) as { ref?: string } | null)?.ref ?? '').startsWith(branchPrefix)).map((item) => ({ number: item.number, title: item.title, state: item.state, head_ref: ((item.head ?? null) as { ref?: string } | null)?.ref ?? null, base_ref: ((item.base ?? null) as { ref?: string } | null)?.ref ?? null, html_url: item.html_url, updated_at: item.updated_at }));
			const repoJobs = ((jobsData.data?.jobs as unknown[] | undefined) ?? []).filter((item) => { const job = item as Record<string, unknown>; return job.repo === repoKey && (include_completed_jobs || (job.status !== 'done' && job.status !== 'failed')); }).map((job) => ({ job_id: (job as Record<string, unknown>).job_id, status: (job as Record<string, unknown>).status, next_actor: (job as Record<string, unknown>).next_actor, work_branch: (job as Record<string, unknown>).work_branch ?? null, pr_number: (job as Record<string, unknown>).pr_number ?? null, stale_reason: (job as Record<string, unknown>).stale_reason ?? null, last_transition_at: (job as Record<string, unknown>).last_transition_at ?? null, last_webhook_event_at: (job as Record<string, unknown>).last_webhook_event_at ?? null, updated_at: (job as Record<string, unknown>).updated_at ?? null }));
			const recentRuns = (runsData.workflow_runs ?? []).slice(0, 5).map((item) => ({ id: item.id, name: item.name, event: item.event, status: item.status, conclusion: item.conclusion, html_url: item.html_url, created_at: item.created_at, head_branch: item.head_branch }));
			return toolText(ok({ repo_key: repoKey, use_repo_as_workspace: true, repo_default_branch: repoData.default_branch ?? getDefaultBaseBranch(env), repo_html_url: repoData.html_url ?? null, open_agent_prs: openAgentPrs, active_jobs: repoJobs, recent_workflow_runs: recentRuns, registered_workspace: workspaceData.ok ? workspaceData.data?.workspace ?? null : null, recommended_next_step: openAgentPrs.length > 0 || repoJobs.length > 0 ? 'reuse_existing_repo_context' : 'start_new_repo_job' }, readAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'repo_work_context_failed'), error, readAnnotations)); }
	});
	server.registerTool('workspace_activate', { description: 'Mark one registered repository workspace as the current active repo context so recent workspace ordering stays unified around the repo you are actively working in.', inputSchema: { repo_key: z.string() }, annotations: writeAnnotations }, async ({ repo_key }) => { try { return toolText(await queueJson(env, { action: 'workspace_activate', repo_key })); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_activate_failed'), error, writeAnnotations)); } });
	server.registerTool('workspace_resolve', { description: 'Resolve the preferred GitHub workspace folder for a repo. Returns a registered folder if one exists, otherwise a default project-first workspace path plus similar registered matches to review before creating a new folder.', inputSchema: { repo_key: z.string(), preferred_root: z.string().default('/home/uieseong/workspace/projects') }, annotations: readAnnotations }, async ({ repo_key, preferred_root }) => {
		try {
			const existing = await queueJson(env, { action: 'workspace_get', repo_key });
			const similar = await queueJson(env, { action: 'workspace_find_similar', repo_key });
			const repoSlug = repo_key.split('/').pop() ?? repo_key;
			const defaultWorkspacePath = `${preferred_root.replace(/\/$/, '')}/${repoSlug}`;
			return toolText(ok({ repo_key, default_workspace_path: defaultWorkspacePath, existing_workspace: existing.ok ? existing.data?.workspace ?? null : null, similar_workspaces: similar.data?.matches ?? [], requires_confirmation: Boolean(existing.ok && existing.data?.workspace) || (((similar.data?.matches as unknown[] | undefined)?.length ?? 0) > 0) }, readAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_resolve_failed'), error, readAnnotations)); }
	});
	server.registerTool('workspace_register', { description: 'Register or update the preferred GitHub workspace folder for a repo so future chat sessions can reuse it instead of creating a similar new folder.', inputSchema: { repo_key: z.string(), workspace_path: z.string(), display_name: z.string().optional(), aliases: z.array(z.string()).default([]) }, annotations: writeAnnotations }, async ({ repo_key, workspace_path, display_name, aliases }) => {
		try { const result = await queueJson(env, { action: 'workspace_register', workspace: { repo_key, workspace_path, display_name, aliases } }); await activateRepoWorkspace(env, repo_key); return queueActionResult(result, writeAnnotations); } catch (error) { return toolText(fail('queue_action_failed', error, writeAnnotations)); }
	});
	server.registerTool('workspace_find_similar', { description: 'Find registered workspace folders similar to a repo or folder name before creating a new GitHub workspace folder.', inputSchema: { query: z.string().optional(), repo_key: z.string().optional() }, annotations: readAnnotations }, async ({ query, repo_key }) => { try { return toolText(await queueJson(env, { action: 'workspace_find_similar', query, repo_key })); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_find_similar_failed'), error, readAnnotations)); } });
	server.registerTool('workspace_list', { description: 'List registered GitHub workspace folders known to this MCP server.', annotations: readAnnotations }, async () => { try { return toolText(await queueJson(env, { action: 'workspace_list' })); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_list_failed'), error, readAnnotations)); } });
	server.registerTool('self_host_status', { description: 'Inspect the GitHub self-repo plus configured Cloudflare live and mirror health endpoints for maintenance and self-improvement checks.', inputSchema: { include_healthz: z.boolean().default(true) }, annotations: readAnnotations }, async ({ include_healthz }) => {
		try {
			const selfRepoKey = getSelfRepoKey(env);
			const [owner, repo] = selfRepoKey.split('/');
			const liveUrl = getSelfLiveUrl(env);
			const mirrorUrl = getSelfMirrorUrl(env);
			const currentUrl = getSelfCurrentUrl(env);
			const [workspaceResult, repoResult, workflowRunsResult, liveHealth, mirrorHealth] = await Promise.all([
				queueJson(env, { action: 'workspace_get', repo_key: selfRepoKey }),
				githubGet(env, `/repos/${owner}/${repo}`) as Promise<Record<string, unknown>>,
				githubGet(env, `/repos/${owner}/${repo}/actions/runs`, { params: { per_page: 5 } }) as Promise<{ workflow_runs?: Array<Record<string, unknown>> }>,
				include_healthz ? fetchHealthSnapshot(liveUrl, currentUrl) : Promise.resolve(null),
				include_healthz ? fetchHealthSnapshot(mirrorUrl, currentUrl) : Promise.resolve(null),
			]);
			return toolText(ok({ self_repo_key: selfRepoKey, github: { html_url: repoResult.html_url ?? null, default_branch: repoResult.default_branch ?? null, pushed_at: repoResult.pushed_at ?? null, open_issues_count: repoResult.open_issues_count ?? null }, workspace: workspaceResult.ok ? workspaceResult.data?.workspace ?? null : null, live: { url: liveUrl, healthz: liveHealth }, mirror: { url: mirrorUrl, healthz: mirrorHealth }, deploy_strategy: { default_target: getSelfDefaultDeployTarget(env), require_mirror_for_live: selfRequiresMirrorForLive(env), mirror_distinct_from_live: mirrorConfigured(env) }, self_deploy_workflow: getSelfDeployWorkflow(env), recent_self_deploy_runs: (workflowRunsResult.workflow_runs ?? []).filter((run) => run.path === `.github/workflows/${getSelfDeployWorkflow(env)}`).slice(0, 5).map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, html_url: run.html_url, created_at: run.created_at, head_branch: run.head_branch, event: run.event })) }, readAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'self_host_status_failed'), error, readAnnotations)); }
	});
	server.registerTool('self_deploy', { description: 'Deploy the self repo through the self-deploy workflow with mirror-first guardrails. Use mirror for self-improvement validation, then explicitly promote to live.', inputSchema: { deploy_target: z.enum(['mirror', 'live']).default(getSelfDefaultDeployTarget(env)), reason: z.string().optional(), expected_commit_sha: z.string().optional(), verify_mirror_first: z.boolean().default(true) }, annotations: writeAnnotations }, async ({ deploy_target, reason, expected_commit_sha, verify_mirror_first }) => {
		try {
			const selfRepoKey = getSelfRepoKey(env);
			const [owner, repo] = selfRepoKey.split('/');
			const distinctMirror = mirrorConfigured(env);
			if (deploy_target === 'live' && selfRequiresMirrorForLive(env) && !distinctMirror) throw new Error('live self deploy requires a distinct mirror url to be configured first');
			if (deploy_target === 'live' && verify_mirror_first) { const mirrorHealth = await fetchHealthSnapshot(getSelfMirrorUrl(env)); if (!mirrorHealth?.ok) throw new Error('mirror health check failed; refusing live promotion'); }
			await activateRepoWorkspace(env, selfRepoKey);
			const workflowId = getSelfDeployWorkflow(env);
			const inputs: Record<string, unknown> = { deploy_target, verify_mirror_first };
			if (reason) inputs.reason = reason;
			if (expected_commit_sha) inputs.expected_commit_sha = expected_commit_sha;
			await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, { ref: getDefaultBaseBranch(env), inputs });
			return toolText(ok({ repo: selfRepoKey, workflow_id: workflowId, deploy_target, verify_mirror_first, reason: reason ?? null, expected_commit_sha: expected_commit_sha ?? null }, writeAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'self_deploy_failed'), error, writeAnnotations)); }
	});
	server.registerTool('self_bootstrap_repo_secrets', { description: 'Bootstrap GitHub Actions secrets for the self repo using the live worker secret values plus the provided Cloudflare credentials. This is intended for first-time self-improvement setup and recovery.', inputSchema: { cloudflare_api_token: z.string().min(1), cloudflare_account_id: z.string().min(1) }, annotations: writeAnnotations }, async ({ cloudflare_api_token, cloudflare_account_id }) => {
		try {
			const selfRepoKey = getSelfRepoKey(env);
			const [owner, repo] = selfRepoKey.split('/');
			if (!env.GITHUB_APP_PRIVATE_KEY_PEM) throw new Error('live worker GitHub App private key is missing');
			if (!env.WEBHOOK_SECRET) throw new Error('live worker webhook secret is missing');
			await activateRepoWorkspace(env, selfRepoKey);
			const publicKeyResult = (await githubGet(env, `/repos/${owner}/${repo}/actions/secrets/public-key`)) as { key?: string; key_id?: string };
			const publicKey = publicKeyResult.key;
			const keyId = publicKeyResult.key_id;
			if (!publicKey || !keyId) throw new Error('self repo actions public key not available');
			const sealedKey = decodeBase64Bytes(publicKey);
			const writeSecret = async (name: string, value: string) => {
				const encryptedValue = encodeBase64Bytes(seal(new TextEncoder().encode(value), sealedKey));
				await githubPut(env, `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`, { encrypted_value: encryptedValue, key_id: keyId });
			};
			await writeSecret('CLOUDFLARE_API_TOKEN', cloudflare_api_token);
			await writeSecret('CLOUDFLARE_ACCOUNT_ID', cloudflare_account_id);
			await writeSecret('APP_PRIVATE_KEY_PEM', env.GITHUB_APP_PRIVATE_KEY_PEM);
			await writeSecret('WEBHOOK_SECRET', env.WEBHOOK_SECRET);
			return toolText(ok({ repo: selfRepoKey, secrets_written: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'APP_PRIVATE_KEY_PEM', 'WEBHOOK_SECRET'] }, writeAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'self_bootstrap_repo_secrets_failed'), error, writeAnnotations)); }
	});
	server.registerTool('self_sync_mirror_secrets', { description: 'Copy the live worker GitHub App private key and webhook secret into the configured mirror worker using the provided Cloudflare credentials.', inputSchema: { cloudflare_api_token: z.string().min(1), cloudflare_account_id: z.string().min(1), mirror_script_name: z.string().optional() }, annotations: writeAnnotations }, async ({ cloudflare_api_token, cloudflare_account_id, mirror_script_name }) => {
		try {
			if (!env.GITHUB_APP_PRIVATE_KEY_PEM) throw new Error('live worker GitHub App private key is missing');
			if (!env.WEBHOOK_SECRET) throw new Error('live worker webhook secret is missing');
			const resolvedMirrorScriptName = mirror_script_name?.trim() || getWorkerScriptNameFromUrl(getSelfMirrorUrl(env));
			if (!resolvedMirrorScriptName) throw new Error('mirror worker script name could not be resolved');
			const cloudflareEnv = { ...env, CLOUDFLARE_API_TOKEN: cloudflare_api_token, CLOUDFLARE_ACCOUNT_ID: cloudflare_account_id };
			const accountId = cloudflare_account_id.trim();
			const upsertSecret = async (name: string, value: string) => cloudflarePut<Record<string, unknown>>(cloudflareEnv, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(resolvedMirrorScriptName)}/secrets`, { body: { name, text: value, type: 'secret_text' } });
			await upsertSecret('GITHUB_APP_PRIVATE_KEY_PEM', env.GITHUB_APP_PRIVATE_KEY_PEM);
			await upsertSecret('WEBHOOK_SECRET', env.WEBHOOK_SECRET);
			return toolText(ok({ mirror_script_name: resolvedMirrorScriptName, secrets_written: ['GITHUB_APP_PRIVATE_KEY_PEM', 'WEBHOOK_SECRET'] }, writeAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'self_sync_mirror_secrets_failed'), error, writeAnnotations)); }
	});
}
