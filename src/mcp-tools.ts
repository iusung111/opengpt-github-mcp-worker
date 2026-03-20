import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seal } from 'tweetsodium';
import * as z from 'zod/v4';
import { AppEnv, DispatchRequestRecord } from './types';
import { cloudflarePut } from './cloudflare';
import { registerCollabTools } from './mcp-collab-tools';
import { registerOverviewTools } from './mcp-overview-tools';
import { registerRepoReadTools } from './mcp-repo-read-tools';
import {
	activateRepoWorkspace,
	buildDispatchFingerprint,
	decodeBase64Text,
	diagnosticLog,
	encodeBase64Text,
	encodeGitHubPath,
	encodeGitHubRef,
	ensureBranchAllowed,
	ensureNotDefaultBranch,
	ensureRepoAllowed,
	ensureSafePath,
	ensureWorkflowAllowed,
	errorCodeFor,
	fail,
	getAllowedWorkflows,
	getBranchPrefix,
	getDefaultAutoImproveMaxCycles,
	getDefaultBaseBranch,
	getDispatchDedupeWindowMs,
	getSelfCurrentUrl,
	getSelfDefaultDeployTarget,
	getSelfDeployWorkflow,
	getSelfLiveUrl,
	getSelfMirrorUrl,
	getSelfRepoKey,
	githubDelete,
	githubGet,
	githubPost,
	githubPut,
	isOlderThan,
	nowIso,
	ok,
	queueJson,
	selfRequiresMirrorForLive,
	toolText,
	validateWorkflowInputs,
} from './utils';

function queueActionResult(
	result: { ok: boolean; code?: string | null; error?: string | null; data?: Record<string, unknown> | null },
	meta: Record<string, unknown>,
) {
	if (result.ok) {
		return toolText({ ...result, meta });
	}
	return toolText(fail('queue_action_failed', result.error ?? result.code ?? 'queue action failed', meta));
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

function normalizeTreePath(path: string | undefined): string {
	if (!path) {
		return '';
	}
	return path.replace(/^\/+|\/+$/g, '');
}

function summarizeTreeEntries(
	entries: Array<Record<string, unknown>>,
	basePath: string,
	depth: number,
	maxEntries: number,
): Record<string, unknown> {
	const normalizedBasePath = normalizeTreePath(basePath);
	const basePrefix = normalizedBasePath ? `${normalizedBasePath}/` : '';
	const scopedEntries = entries.filter((entry) => {
		const entryPath = String(entry.path ?? '');
		return !normalizedBasePath || entryPath === normalizedBasePath || entryPath.startsWith(basePrefix);
	});

	const directDirectories = new Set<string>();
	const directFiles = new Set<string>();
	const samplePaths: string[] = [];
	const projectRootCandidates = new Set<string>();

	for (const entry of scopedEntries) {
		const entryPath = String(entry.path ?? '');
		if (!entryPath || entryPath === normalizedBasePath) {
			continue;
		}

		const relativePath = normalizedBasePath
			? entryPath.startsWith(basePrefix)
				? entryPath.slice(basePrefix.length)
				: entryPath
			: entryPath;
		if (!relativePath) {
			continue;
		}

		const segments = relativePath.split('/').filter(Boolean);
		if (segments.length === 0) {
			continue;
		}

		if (segments.length === 1) {
			if (String(entry.type ?? '') === 'tree') {
				directDirectories.add(segments[0]);
			} else {
				directFiles.add(segments[0]);
			}
		}

		if (segments.length <= depth && samplePaths.length < maxEntries) {
			samplePaths.push(entryPath);
		}

		const firstSegment = segments[0];
		if (['projects', 'apps', 'examples', 'samples', 'tools', 'playground', 'playgrounds'].includes(firstSegment)) {
			projectRootCandidates.add(firstSegment);
		}
	}

	return {
		base_path: normalizedBasePath,
		depth,
		total_entries: scopedEntries.length,
		directories: Array.from(directDirectories).sort(),
		files: Array.from(directFiles).sort(),
		sample_paths: samplePaths,
		project_root_candidates: Array.from(projectRootCandidates).sort(),
	};
}

function buildHelpPayload(query: string | undefined): Record<string, unknown> {
	const normalized = normalizeHelpQuery(query);
	const templates = {
		real_change: {
			label: 'Real change with PR',
			prompt: [
				'iusung111/OpenGPT에서 다음 변경 진행:',
				'- job_id: change-001',
				'- 목표: <구체적인 수정 내용>',
				'- 변경 파일: <path들>',
				'- dry_run: false',
				'- 완료 기준: 가능한 범위의 검증 후 PR 생성',
			].join('\n'),
		},
		main_ready: {
			label: 'Main-ready change',
			prompt: [
				'iusung111/OpenGPT에서 다음 변경을 진행하고 main 반영 기준으로 마무리해줘:',
				'- job_id: main-ready-001',
				'- 목표: <구체적인 수정 내용>',
				'- 변경 파일: <path들>',
				'- dry_run: false',
				'- 완료 기준: 검증 완료, branch push, PR 생성, 가능하면 merge까지',
			].join('\n'),
		},
		dry_run: {
			label: 'Dry run only',
			prompt: [
				'iusung111/OpenGPT에서 다음 작업을 dry-run으로 검증해줘:',
				'- job_id: dryrun-001',
				'- 목표: <무엇을 바꿀지>',
				'- 변경 파일: <path들>',
				'- dry_run: true',
				'- 완료 기준: workflow success와 queue 상태 전이 확인',
			].join('\n'),
		},
		review: {
			label: 'Review follow-up',
			prompt: [
				'iusung111/OpenGPT에서 job_id <값>의 현재 상태를 확인하고,',
				'PR / workflow / queue 기준으로 다음 액션을 정리해줘.',
			].join('\n'),
		},
		merge: {
			label: 'Merge approved PR',
			prompt: [
				'iusung111/OpenGPT에서 PR #<번호>를 main에 merge해줘.',
				'- merge_method: merge',
				'- 가능하면 merge 후 main 상태까지 확인해줘.',
			].join('\n'),
		},
		branch_cleanup: {
			label: 'Branch cleanup',
			prompt: 'iusung111/OpenGPT에서 정리 가능한 agent 브랜치를 확인하고, 있으면 cleanup 흐름으로 정리해줘.',
		},
	};
	const workflows = [
		{
			id: 'real_change',
			label: '코드 수정과 PR 생성',
			when_to_use: '실제 파일 변경과 PR 생성까지 원할 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=false + 완료 기준',
			recommended_template: templates.real_change,
		},
		{
			id: 'main_ready',
			label: 'main 반영 직전까지 준비',
			when_to_use: 'main 기준으로 마무리하고 싶고, 가능하면 merge까지 이어가고 싶을 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=false + main 반영 기준 완료 기준',
			recommended_template: templates.main_ready,
		},
		{
			id: 'merge_pr',
			label: '승인된 PR merge',
			when_to_use: '이미 준비된 PR을 allowlisted repo의 base branch로 합칠 때',
			request_pattern: 'repo + PR 번호 + optional merge_method',
			recommended_template: templates.merge,
		},
		{
			id: 'dry_run',
			label: 'dry-run 검증',
			when_to_use: '위험하거나 모호한 변경을 먼저 검증하고 싶을 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=true',
			recommended_template: templates.dry_run,
		},
		{
			id: 'review_followup',
			label: '리뷰 후속 액션 정리',
			when_to_use: '이미 있는 job, PR, workflow 상태를 기준으로 다음 액션이 필요할 때',
			request_pattern: 'job_id 또는 repo 문맥 + 상태 확인 요청',
			recommended_template: templates.review,
		},
		{
			id: 'branch_cleanup',
			label: 'agent 브랜치 정리',
			when_to_use: '열린 PR과 active job이 없는 agent 브랜치를 정리할 때',
			request_pattern: 'repo + 브랜치 정리 요청',
			recommended_template: templates.branch_cleanup,
		},
	];

	const commonFields = [
		{ field: 'job_id', required: false, guidance: '없으면 자동 생성 가능하지만, 이어서 추적하려면 넣는 편이 좋습니다.' },
		{ field: '목표', required: true, guidance: '바꾸고 싶은 동작이나 결과를 짧게 적습니다.' },
		{ field: '변경 파일', required: false, guidance: '예상 파일을 적으면 범위를 좁히기 쉽습니다.' },
		{ field: 'dry_run', required: false, guidance: 'true면 검증만, false면 실제 변경과 PR 준비 흐름입니다.' },
		{ field: '완료 기준', required: false, guidance: 'PR 생성, workflow 성공, main 반영 직전까지 등 종료 조건을 적습니다.' },
	];

	const basePayload = {
		summary: 'GitHub repo 작업, dry-run 검증, PR 준비, branch cleanup, 진행 상태 확인을 도와줄 수 있습니다.',
		intent: normalized || 'general',
		how_to_ask: {
			required_minimum: ['repo', '목표'],
			recommended_fields: commonFields,
			notes: [
				'실제 변경이면 dry_run=false가 자연스럽습니다.',
				'main 반영 요청은 가능하면 merge까지 시도하고, 불가능하면 정확한 남은 액션을 알려줍니다.',
			],
		},
		progress_tracking: {
			read_tools: ['repo_work_context', 'job_progress', 'audit_list'],
			write_tools: ['job_append_note'],
			pattern: '긴 읽기나 조사 중에는 짧은 메모를 남기고 progress 스냅샷을 다시 읽습니다.',
		},
		workflows,
		next_actions: [
			'원하는 repo와 목표를 말해주면 바로 적절한 workflow로 이어갈 수 있습니다.',
			'모호하면 먼저 dry-run으로 검증해볼 수 있습니다.',
		],
	};

	if (!normalized) {
		return {
			...basePayload,
			recommended_workflow: 'real_change',
			examples: [templates.real_change, templates.main_ready, templates.dry_run, templates.branch_cleanup],
		};
	}

	if (normalized.includes('main')) {
		return {
			...basePayload,
			summary: 'main 반영 요청은 실제 변경으로 해석하고, 검증과 PR 준비 뒤 merge 도구가 가능하면 main merge까지 시도합니다.',
			recommended_workflow: 'main_ready',
			recommended_template: templates.main_ready,
			next_actions: [
				'dry_run=false로 요청하면 가장 자연스럽습니다.',
				'merge 자체가 수행되지 않았으면 main이 이미 바뀌었다고 말하지 않습니다.',
			],
		};
	}

	if (normalized.includes('merge') || normalized.includes('머지')) {
		return {
			...basePayload,
			summary: '승인된 PR이 mergeable 상태라면 allowlisted repo의 base branch로 직접 merge할 수 있습니다.',
			recommended_workflow: 'merge_pr',
			recommended_template: templates.merge,
			recommended_tools: ['pr_get', 'pr_merge'],
		};
	}

	if (normalized.includes('dry') || normalized.includes('검증')) {
		return {
			...basePayload,
			summary: '위험하거나 모호한 작업은 dry-run 검증으로 먼저 확인할 수 있습니다.',
			recommended_workflow: 'dry_run',
			recommended_template: templates.dry_run,
		};
	}

	if (normalized.includes('리뷰') || normalized.includes('review')) {
		return {
			...basePayload,
			summary: '기존 job, PR, workflow를 기준으로 리뷰 후속 액션을 정리할 수 있습니다.',
			recommended_workflow: 'review_followup',
			recommended_template: templates.review,
		};
	}

	if (normalized.includes('브랜치') || normalized.includes('cleanup') || normalized.includes('삭제')) {
		return {
			...basePayload,
			summary: '브랜치 삭제는 workflow 편집이 아니라 branch cleanup 흐름으로 처리합니다.',
			recommended_workflow: 'branch_cleanup',
			recommended_template: templates.branch_cleanup,
			recommended_tools: ['branch_cleanup_candidates', 'branch_cleanup_execute'],
		};
	}

	if (normalized.includes('진행') || normalized.includes('상태') || normalized.includes('progress')) {
		return {
			...basePayload,
			summary: '작업 도중 진행 상태는 짧은 메모와 progress 스냅샷으로 확인할 수 있습니다.',
			recommended_tools: ['job_append_note', 'job_progress', 'audit_list'],
			recommended_workflow: 'progress_tracking',
			next_actions: [
				'이미 job_id가 있으면 job_progress로 바로 현재 상태를 읽을 수 있습니다.',
				'중간 메모가 필요하면 job_append_note를 함께 사용합니다.',
			],
		};
	}

	return {
		...basePayload,
		summary: '원하는 작업 내용을 repo, 목표, 변경 파일, dry_run 여부, 완료 기준과 함께 말하면 가장 안정적으로 진행할 수 있습니다.',
		recommended_workflow: 'real_change',
		recommended_template: templates.real_change,
		related_workflows: ['main_ready', 'dry_run', 'review_followup'],
	};
}

export function buildMcpServer(env: AppEnv): McpServer {
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.2.1',
	});

	const readAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};
	registerOverviewTools(server, env, readAnnotations, writeAnnotations);
	registerRepoReadTools(server, env, readAnnotations);
	registerCollabTools(server, env, readAnnotations, writeAnnotations);
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

	server.registerTool(
		'workflow_dispatch',
		{
			description: 'Dispatch an allowlisted workflow in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				workflow_id: z.string(),
				ref: z.string(),
				inputs: z.record(z.string(), z.unknown()).default({}),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, workflow_id, ref, inputs }) => {
			const startedAt = Date.now();
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				if (ref !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, ref);
				}
				ensureWorkflowAllowed(env, workflow_id);
				validateWorkflowInputs(inputs);
				const jobId = typeof inputs.job_id === 'string' ? inputs.job_id : undefined;
				let existingJob:
					| {
							work_branch?: string;
							status?: string;
							next_actor?: string;
							auto_improve_cycle?: number;
							worker_manifest?: Record<string, unknown>;
					  }
					| null = null;
				if (jobId) {
					const existingJobResult = await queueJson(env, {
						action: 'job_get',
						job_id: jobId,
					});
					existingJob = ((existingJobResult.data?.job ?? null) as
						| {
								work_branch?: string;
								status?: string;
								next_actor?: string;
								auto_improve_cycle?: number;
								worker_manifest?: Record<string, unknown>;
						  }
						| null);
				}
				const autoImproveCycle =
					typeof existingJob?.auto_improve_cycle === 'number' ? existingJob.auto_improve_cycle : 0;
				const fingerprint = await buildDispatchFingerprint(owner, repo, workflow_id, ref, inputs, autoImproveCycle);
				const existingDispatch = (existingJob?.worker_manifest?.dispatch_request ?? null) as
					| Partial<DispatchRequestRecord>
					| null;
				const workflowState = (existingJob?.worker_manifest?.last_workflow_run ?? null) as
					| {
							status?: string;
					  }
					| null;
				if (
					jobId &&
					existingJob?.status === 'working' &&
					existingJob?.next_actor === 'system' &&
					existingDispatch?.fingerprint === fingerprint &&
					workflowState?.status !== 'completed' &&
					!isOlderThan(existingDispatch?.dispatched_at || nowIso(), getDispatchDedupeWindowMs(env))
				) {
					diagnosticLog('workflow_dispatch_deduplicated', {
						owner,
						repo,
						workflow_id,
						ref,
						job_id: jobId,
						auto_improve_cycle: autoImproveCycle,
					});
					return toolText(ok({ workflow_id, ref, inputs, deduplicated: true }, writeAnnotations));
				}
				const dispatchedAtIso = nowIso();
				await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`, {
					ref,
					inputs,
				});
				if (jobId) {
					const existingWorkBranch =
						typeof existingJob?.work_branch === 'string' ? existingJob.work_branch : undefined;
					await queueJson(env, {
						action: 'job_upsert',
						job: {
							job_id: jobId,
							status: 'working',
							next_actor: 'system',
							worker_manifest: {
								...(existingJob?.worker_manifest ?? {}),
								dispatch_request: {
									owner,
									repo,
									workflow_id,
									ref,
									inputs,
									fingerprint,
									dispatched_at: dispatchedAtIso,
								},
							},
							// If we are dispatching on a branch that matches the job's work branch, preserve it.
							// Otherwise if we are dispatching on main, we might not be setting a work branch here.
							work_branch: existingWorkBranch,
						},
					});
				}
				return toolText(ok({ workflow_id, ref, inputs, dispatched_at: dispatchedAtIso }, writeAnnotations));
			} catch (error) {
				diagnosticLog('workflow_dispatch_error', {
					owner,
					repo,
					duration_ms: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				});
				return toolText(fail(errorCodeFor(error, 'workflow_dispatch_failed'), error, writeAnnotations));
			} finally {
				diagnosticLog('workflow_dispatch_complete', {
					owner,
					repo,
					duration_ms: Date.now() - startedAt,
				});
			}
		},
	);

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
			},
			annotations: writeAnnotations,
		},
		async (input) => {
			try {
				ensureRepoAllowed(env, input.repo);
				await activateRepoWorkspace(env, input.repo);
				if (input.work_branch) {
					ensureBranchAllowed(env, input.work_branch);
				}
				const result = await queueJson(env, {
					action: 'job_create',
					job: {
						...input,
						status: 'queued',
						next_actor: input.next_actor,
						auto_improve_cycle: 0,
						worker_manifest: {},
						review_findings: [],
						notes: [],
					},
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_get',
		{
			description: 'Get a queue job by job_id.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_get', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'job_progress',
		{
			description:
				'Get a concise progress snapshot for a queue job, including current status, latest note, and recent audit events. Use this during long read or investigation phases to make progress visible.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_progress', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_progress_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'jobs_list',
		{
			description: 'List queue jobs filtered by status or next actor.',
			inputSchema: {
				status: z.enum(['queued', 'working', 'review_pending', 'rework_pending', 'done', 'failed']).optional(),
				next_actor: z.enum(['worker', 'reviewer', 'system']).optional(),
			},
			annotations: readAnnotations,
		},
		async ({ status, next_actor }) => {
			try {
				const result = await queueJson(env, { action: 'jobs_list', status, next_actor });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'jobs_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'audit_list',
		{
			description: 'List recent audit events for a specific job or global events.',
			inputSchema: {
				job_id: z.string().optional(),
				limit: z.number().int().positive().max(50).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ job_id, limit }) => {
			try {
				const result = await queueJson(env, { action: 'audit_list', job_id, limit });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'audit_list_failed'), error, readAnnotations));
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
				const result = await queueJson(env, { action: 'job_update_status', job_id, status, next_actor });
				return toolText(result);
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
				const result = await queueJson(env, { action: 'job_append_note', job_id, note });
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_append_note_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_submit_review',
		{
			description: 'Submit a review verdict for a job in review_pending state.',
			inputSchema: {
				job_id: z.string(),
				review_verdict: z.enum(['approved', 'changes_requested', 'blocked']),
				findings: z.array(z.any()).default([]),
				next_action: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, review_verdict, findings, next_action }) => {
			try {
				const result = await queueJson(env, {
					action: 'job_submit_review',
					job_id,
					review_verdict,
					findings,
					next_action,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'job_submit_review_failed'), error, writeAnnotations));
			}
		},
	);

	return server;
}
