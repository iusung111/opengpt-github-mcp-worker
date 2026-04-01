import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seal } from 'tweetsodium';
import * as z from 'zod/v4';
import { cloudflarePut } from './cloudflare';
import { notificationWidgetToolMeta } from './mcp-widget-resources';
import { listPermissionPresets, listToolGroups, buildPermissionBundleMessage } from './tool-catalog';
import { AppEnv } from './types';
import {
	activateRepoWorkspace,
	errorCodeFor,
	fail,
	getBranchPrefix,
	getDefaultBaseBranch,
	getSelfCurrentUrl,
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
	mirrorConfigured,
} from './utils';

import {
	buildHelpPayload,
	buildSelfHostStatusPayload,
	decodeBase64Bytes,
	encodeBase64Bytes,
	fetchHealthSnapshot,
	getWorkerScriptNameFromUrl,
	jobsListStructuredSchema,
	permissionBundleStructuredSchema,
	queueActionResult,
	selfHostStatusStructuredSchema,
} from './overview/logic';

export interface ToolAnnotations extends Record<string, unknown> {
	readOnlyHint: boolean;
	openWorldHint: boolean;
	destructiveHint?: boolean;
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

export function registerOverviewTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool('help', { description: 'Explain what kinds of GitHub work this MCP server can do and return example request templates. Use this when the user asks what work is possible or how to phrase a request.', inputSchema: { query: z.string().optional() }, annotations: readAnnotations }, async ({ query }) => {
		try { return toolText(ok(buildHelpPayload(query), readAnnotations)); } catch (error) { return toolText(fail(errorCodeFor(error, 'help_failed'), error, readAnnotations)); }
	});
	server.registerTool('request_permission_bundle', { description: 'Build a batch approval bundle for one or more repositories so the user can approve the smallest useful set of MCP actions in one step.', inputSchema: { repos: z.array(z.string()).min(1).describe('List of owner/repo'), preset: z.enum(listPermissionPresets().map((preset) => preset.id) as [string, ...string[]]).optional(), capabilities: z.array(z.enum(['read', 'write', 'workflow', 'review', 'workspace', 'queue', 'self_host'])).default([]), extra_tools: z.array(z.string()).default([]).describe('Optional extra tools to include explicitly'), reason: z.string().describe('Why are these permissions needed?'), job_id: z.string().optional(), blocked_action: z.string().optional() }, outputSchema: permissionBundleStructuredSchema, annotations: readAnnotations, _meta: notificationWidgetToolMeta({ 'openai/toolInvocation/invoking': 'Preparing approval bundle', 'openai/toolInvocation/invoked': 'Approval bundle ready' }) }, async ({ repos, preset, capabilities, extra_tools, reason, job_id, blocked_action }) => {
		try {
			const requestId = crypto.randomUUID();
			const bundle = buildPermissionBundleMessage({
				repos,
				reason,
				preset,
				capabilities,
				extraTools: extra_tools,
			});
			let notification: Record<string, unknown> | null = null;
			let status: 'drafted' | 'requested' = 'drafted';
			let requestedAt: string | null = null;
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
				requestedAt = nowIso();
				status = 'requested';
				await queueJsonOrThrow(env, {
					action: 'job_upsert',
					job: {
						job_id,
						repo: jobRepo,
						worker_manifest: {
							attention: {
								approval: {
									pending: true,
									request_id: requestId,
									status: 'requested',
									reason,
									blocked_action: blocked_action ?? null,
									bundle,
									note: null,
									requested_at: requestedAt,
									resolved_at: null,
									cleared_at: null,
								},
							},
							control: {
								state: 'active',
								last_interrupt: null,
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
						request_id: requestId,
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
					request_id: requestId,
					blocked_action: blocked_action ?? null,
					reason,
					requested_at: requestedAt,
				};
			}
			return toolText(
				ok(
					{
						request_id: requestId,
						status,
						requested_at: requestedAt,
						resolved_at: null,
						available_presets: listPermissionPresets(),
						available_tool_groups: listToolGroups().map((group) => ({
							id: group.id,
							label: group.label,
							description: group.description,
						})),
						bundle,
						notification,
					},
					readAnnotations,
				),
			);
		} catch (error) { return toolText(fail(errorCodeFor(error, 'request_permission_bundle_failed'), error, readAnnotations)); }
	});
	server.registerTool('permission_request_resolve', { description: 'Record the outcome of a previously requested permission bundle for a queue job. This updates queue state for approval-approved, rejected, or superseded flows without bypassing host-native grants.', inputSchema: { job_id: z.string(), request_id: z.string(), resolution: z.enum(['approved', 'rejected', 'superseded']), note: z.string().optional() }, outputSchema: permissionBundleStructuredSchema, annotations: writeAnnotations, _meta: notificationWidgetToolMeta({ 'openai/toolInvocation/invoking': 'Recording approval outcome', 'openai/toolInvocation/invoked': 'Approval outcome recorded' }) }, async ({ job_id, request_id, resolution, note }) => {
		try {
			const result = await queueJson(env, {
				action: 'permission_request_resolve',
				job_id,
				request_id,
				resolution,
				note,
			});
			return toolText(result);
		} catch (error) { return toolText(fail(errorCodeFor(error, 'permission_request_resolve_failed'), error, writeAnnotations)); }
	});
	server.registerTool('run_console_open', {
		description:
			'Open the Run Console widget directly and preload current queue jobs. Returns the direct /gui/ URL too so ChatGPT web can expose the console link alongside the widget.',
		inputSchema: {
			include_healthz: z.boolean().default(true),
		},
		outputSchema: jobsListStructuredSchema,
		annotations: readAnnotations,
		_meta: notificationWidgetToolMeta({
			'openai/toolInvocation/invoking': 'Opening run console',
			'openai/toolInvocation/invoked': 'Run console ready',
		}),
	}, async ({ include_healthz }) => {
		try {
			const jobsResult = await queueJsonOrThrow(env, { action: 'jobs_list' }, 'failed to load queue jobs');
			const jobs = Array.isArray(jobsResult.data?.jobs) ? jobsResult.data.jobs : [];
			const appOrigin = getSelfCurrentUrl(env) ?? getSelfLiveUrl(env) ?? getSelfMirrorUrl(env);
			const guiUrl = appOrigin ? `${appOrigin}/gui/` : null;
			const firstJob = jobs.length > 0 ? (jobs[0] as Record<string, unknown>) : null;
			const selectedJobId = firstJob && typeof firstJob.job_id === 'string' ? firstJob.job_id : null;
			const selectedJobUrl =
				guiUrl && selectedJobId ? `${guiUrl}?job=${encodeURIComponent(selectedJobId)}&tab=overview` : null;
			const response = ok(
				{
					jobs,
					include_healthz,
					gui_url: guiUrl,
					selected_job_id: selectedJobId,
					selected_job_url: selectedJobUrl,
				},
				readAnnotations,
			);
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
				structuredContent: {
					kind: 'opengpt.notification_contract.jobs_list' as const,
					gui_url: guiUrl,
					selected_job_id: selectedJobId,
					selected_job_url: selectedJobUrl,
					jobs,
				},
			};
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'run_console_open_failed'), error, readAnnotations));
		}
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
	server.registerTool('workspace_resolve', { description: 'Resolve repo-first workspace guidance for a repository. Returns any registered local workspace as secondary metadata plus a project-relative recommendation instead of a host-specific absolute path.', inputSchema: { repo_key: z.string() }, annotations: readAnnotations }, async ({ repo_key }) => {
		try {
			const existing = await queueJson(env, { action: 'workspace_get', repo_key });
			const similar = await queueJson(env, { action: 'workspace_find_similar', repo_key });
			const repoSlug = String(repo_key.split('/').pop() ?? repo_key)
				.trim()
				.toLowerCase()
				.replace(/[\s_]+/g, '-');
			const similarWorkspaces = (similar.data?.matches as unknown[] | undefined) ?? [];
			return toolText(ok({ repo_key, existing_workspace: existing.ok ? existing.data?.workspace ?? null : null, similar_workspaces: similarWorkspaces, requires_confirmation: Boolean(existing.ok && existing.data?.workspace) || similarWorkspaces.length > 0, recommended_workspace_relative_path: `projects/${repoSlug}`, recommended_workspace_kind: 'project', local_workspace_optional: true }, readAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_resolve_failed'), error, readAnnotations)); }
	});
	server.registerTool('workspace_register', { description: 'Register or update an optional absolute local filesystem workspace path for a repo so future chat sessions can reuse it as secondary context.', inputSchema: { repo_key: z.string(), workspace_path: z.string(), display_name: z.string().optional(), aliases: z.array(z.string()).default([]) }, annotations: writeAnnotations }, async ({ repo_key, workspace_path, display_name, aliases }) => {
		try { const result = await queueJson(env, { action: 'workspace_register', workspace: { repo_key, workspace_path, display_name, aliases } }); if (result.ok) await activateRepoWorkspace(env, repo_key); return queueActionResult(result, writeAnnotations); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_register_failed'), error, writeAnnotations)); }
	});
	server.registerTool('workspace_find_similar', { description: 'Find registered workspace folders similar to a repo or folder name before creating a new GitHub workspace folder.', inputSchema: { query: z.string().optional(), repo_key: z.string().optional() }, annotations: readAnnotations }, async ({ query, repo_key }) => { try { return toolText(await queueJson(env, { action: 'workspace_find_similar', query, repo_key })); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_find_similar_failed'), error, readAnnotations)); } });
	server.registerTool('workspace_list', { description: 'List registered GitHub workspace folders known to this MCP server.', annotations: readAnnotations }, async () => { try { return toolText(await queueJson(env, { action: 'workspace_list' })); } catch (error) { return toolText(fail(errorCodeFor(error, 'workspace_list_failed'), error, readAnnotations)); } });
	server.registerTool('self_host_status', { description: 'Inspect the GitHub self-repo plus configured Cloudflare live and mirror health endpoints for maintenance and self-improvement checks.', inputSchema: { include_healthz: z.boolean().default(true) }, outputSchema: selfHostStatusStructuredSchema, annotations: readAnnotations, _meta: notificationWidgetToolMeta({ 'openai/toolInvocation/invoking': 'Loading self host status', 'openai/toolInvocation/invoked': 'Self host status ready' }) }, async ({ include_healthz }) => {
		try {
			return toolText(ok(await buildSelfHostStatusPayload(env, include_healthz), readAnnotations));
		} catch (error) { return toolText(fail(errorCodeFor(error, 'self_host_status_failed'), error, readAnnotations)); }
	});
	server.registerTool('self_deploy', { description: 'Deploy the self repo through the self-deploy workflow with mirror-first guardrails. Use mirror for self-improvement validation, then explicitly promote to live.', inputSchema: { deploy_target: z.enum(['mirror', 'live']).default(getSelfMirrorUrl(env) ? 'mirror' : 'live'), reason: z.string().optional(), expected_commit_sha: z.string().optional(), verify_mirror_first: z.boolean().default(true) }, annotations: writeAnnotations }, async ({ deploy_target, reason, expected_commit_sha, verify_mirror_first }) => {
		try {
			const selfRepoKey = getSelfRepoKey(env);
			const [owner, repo] = selfRepoKey.split('/');
			const distinctMirror = mirrorConfigured(env);
			if (deploy_target === 'live' && selfRequiresMirrorForLive(env) && !distinctMirror) throw new Error('live self deploy requires a distinct mirror url to be configured first');
			if (deploy_target === 'live' && verify_mirror_first) { const mirrorHealth = await fetchHealthSnapshot(getSelfMirrorUrl(env)); if (mirrorHealth && !mirrorHealth.ok) throw new Error('mirror health check failed; refusing live promotion'); }
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
