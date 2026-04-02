import { seal } from 'tweetsodium';
import * as z from 'zod/v4';
import { getReadObservabilitySnapshot } from '../read-observability';
import { listPermissionPresets, listToolGroups } from '../tool-catalog';
import { AppEnv } from '../contracts';
import {
	getAllowedWorkflows,
	getAllowedWorkflowsByRepo,
	getAllowedWorkflowsForRepo,
	getDefaultBaseBranch,
	getSelfCurrentUrl,
	getSelfDefaultDeployTarget,
	getSelfDeployEnv,
	getSelfDeployWorkflow,
	getSelfLiveUrl,
	getSelfMirrorUrl,
	getSelfRepoKey,
	getSelfReleaseCommitSha,
	githubGet,
	queueJson,
	selfRequiresMirrorForLive,
	fail,
	toolText,
} from '../utils';

export const permissionBundleStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.permission_bundle'),
		request_id: z.string().nullable().optional(),
		bundle: z.object({}).passthrough(),
		notification: z.object({}).passthrough().nullable().optional(),
		status: z.string().nullable().optional(),
		requested_at: z.string().nullable().optional(),
		resolved_at: z.string().nullable().optional(),
		current_progress: z.object({}).passthrough().nullable().optional(),
	})
	.passthrough();

export const selfHostStatusStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.self_host_status'),
		self_repo_key: z.string(),
		github: z.object({}).passthrough().nullable().optional(),
		workspace: z.object({}).passthrough().nullable().optional(),
		live: z.object({}).passthrough(),
		mirror: z.object({}).passthrough(),
		deploy_strategy: z.object({}).passthrough(),
		current_deploy: z.object({}).passthrough().optional(),
		workflow_allowlist: z.object({}).passthrough().optional(),
		read_observability: z.object({}).passthrough().optional(),
		self_deploy_workflow: z.string(),
		recent_self_deploy_runs: z.array(z.object({}).passthrough()),
		warnings: z.array(z.string()).optional(),
	})
	.passthrough();

export const jobsListStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.jobs_list'),
		gui_url: z.string().nullable().optional(),
		selected_job_id: z.string().nullable().optional(),
		selected_job_url: z.string().nullable().optional(),
		jobs: z.array(
			z
				.object({
					job_id: z.string(),
					run_summary: z.object({}).passthrough().optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export function queueActionResult(
	result: { ok: boolean; code?: string | null; error?: string | null; data?: Record<string, unknown> | null },
	meta: Record<string, unknown>,
) {
	if (result.ok) {
		return toolText({ ...result, meta });
	}
	return toolText(fail(result.code ?? 'queue_action_failed', result.error ?? result.code ?? 'queue action failed', meta));
}

export function mirrorConfigured(env: AppEnv): boolean {
	const liveUrl = getSelfLiveUrl(env);
	const mirrorUrl = getSelfMirrorUrl(env);
	return Boolean(liveUrl && mirrorUrl && liveUrl !== mirrorUrl);
}

export function decodeBase64Bytes(value: string): Uint8Array {
	const binary = atob(value.replace(/\n/g, ''));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeBase64Bytes(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function getWorkerScriptNameFromUrl(url: string | null): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).hostname.split('.')[0] ?? null;
	} catch {
		return null;
	}
}

export async function fetchHealthSnapshot(
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

async function captureResult<T>(task: Promise<T>): Promise<{ value: T | null; error: string | null }> {
	try {
		return {
			value: await task,
			error: null,
		};
	} catch (error) {
		return {
			value: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function buildSelfHostStatusPayload(env: AppEnv, include_healthz: boolean): Promise<Record<string, unknown>> {
	const selfRepoKey = getSelfRepoKey(env);
	const [owner, repo] = selfRepoKey.split('/');
	const liveUrl = getSelfLiveUrl(env);
	const mirrorUrl = getSelfMirrorUrl(env);
	const currentUrl = getSelfCurrentUrl(env);
	const [workspaceResult, repoSnapshot, workflowRunsSnapshot, liveHealth, mirrorHealth] = await Promise.all([
		queueJson(env, { action: 'workspace_get', repo_key: selfRepoKey }),
		captureResult(githubGet(env, `/repos/${owner}/${repo}`) as Promise<Record<string, unknown>>),
		captureResult(
			githubGet(env, `/repos/${owner}/${repo}/actions/runs`, { params: { per_page: 5 } }) as Promise<{
				workflow_runs?: Array<Record<string, unknown>>;
			}>,
		),
		include_healthz ? fetchHealthSnapshot(liveUrl, currentUrl) : Promise.resolve(null),
		include_healthz ? fetchHealthSnapshot(mirrorUrl, currentUrl) : Promise.resolve(null),
	]);
	const warnings = [repoSnapshot.error, workflowRunsSnapshot.error].filter((value): value is string => Boolean(value));
	const repoResult = repoSnapshot.value ?? {};
	const workflowRuns = workflowRunsSnapshot.value?.workflow_runs ?? [];
	return {
		kind: 'opengpt.notification_contract.self_host_status',
		self_repo_key: selfRepoKey,
		github: {
			html_url: repoResult.html_url ?? null,
			default_branch: repoResult.default_branch ?? null,
			pushed_at: repoResult.pushed_at ?? null,
			open_issues_count: repoResult.open_issues_count ?? null,
		},
		workspace: workspaceResult.ok ? workspaceResult.data?.workspace ?? null : null,
		live: { url: liveUrl, healthz: liveHealth },
		mirror: { url: mirrorUrl, healthz: mirrorHealth },
		deploy_strategy: {
			default_target: getSelfDefaultDeployTarget(env),
			require_mirror_for_live: selfRequiresMirrorForLive(env),
			mirror_distinct_from_live: mirrorConfigured(env),
		},
		current_deploy: {
			environment: getSelfDeployEnv(env),
			current_url: currentUrl,
			release_commit_sha: getSelfReleaseCommitSha(env),
		},
		workflow_allowlist: {
			global: getAllowedWorkflows(env),
			self_repo: getAllowedWorkflowsForRepo(env, selfRepoKey),
			by_repo: getAllowedWorkflowsByRepo(env),
		},
		read_observability: getReadObservabilitySnapshot(),
		self_deploy_workflow: getSelfDeployWorkflow(env),
		recent_self_deploy_runs: workflowRuns
			.filter((run) => run.path === `.github/workflows/${getSelfDeployWorkflow(env)}`)
			.slice(0, 5)
			.map((run) => ({
				id: run.id,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
				created_at: run.created_at,
				head_branch: run.head_branch,
				event: run.event,
			})),
		warnings,
	};
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

export function buildHelpPayload(query: string | undefined): Record<string, unknown> {
	const normalized = normalizeHelpQuery(query);
	const templates = {
		real_change: {
			label: 'Real change with PR',
			prompt: [
				'Make a real change in the target repo. If local planning or artifacts are needed, keep them under projects/<project-slug>.',
				'- repo: <owner/repo>',
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
				'Prepare a real change in the target repo so it is ready for merge to main. If local project context is needed, store it under projects/<project-slug>.',
				'- repo: <owner/repo>',
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

