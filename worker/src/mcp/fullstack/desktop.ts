import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities } from '../../project-capabilities';
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
import { fetchRunSummary, summarizeRun } from '../../fullstack/logic';
import { resolveRunIdFromInput, updateJobState } from '../../fullstack/job-state';
import { normalizeArtifacts } from './shared';

export function registerFullstackDesktopTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'desktop_build_run',
		{
			description: 'Run the desktop packaging workflow using desktop build commands resolved from project capabilities.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			const repoKey = `${owner}/${repo}`;
			const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
			try {
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const commands =
					capabilities.desktop.build_commands.length > 0
						? capabilities.desktop.build_commands
						: capabilities.verify_profiles.filter((profile) => profile.kind === 'desktop_build').flatMap((profile) => profile.commands);
				if (commands.length === 0) throw new Error('desktop build commands are not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.package);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.package,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'desktop_build',
						commands,
						package_targets: capabilities.package_targets,
						artifact_paths: capabilities.desktop.artifact_paths,
						desktop_shell: capabilities.desktop_shell,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
					workerManifest: {
						desktop: {
							status: result.conclusion === 'success' ? 'packaged' : 'failed',
							runtime: capabilities.desktop_shell === 'electron' || capabilities.desktop_shell === 'tauri' ? capabilities.desktop_shell : null,
							package_targets: capabilities.package_targets,
							artifacts: normalizeArtifacts(result.artifacts),
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.package, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'desktop_build_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'desktop_smoke_run',
		{
			description: 'Run desktop shell smoke commands using the package workflow.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			const repoKey = `${owner}/${repo}`;
			const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
			try {
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const commands =
					capabilities.desktop.smoke_commands.length > 0
						? capabilities.desktop.smoke_commands
						: capabilities.verify_profiles.filter((profile) => profile.kind === 'desktop_smoke').flatMap((profile) => profile.commands);
				if (commands.length === 0) throw new Error('desktop smoke commands are not configured');
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.package);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.package,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'desktop_smoke',
						commands,
						package_targets: capabilities.package_targets,
						desktop_shell: capabilities.desktop_shell,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
					workerManifest: {
						desktop: {
							status: result.conclusion === 'success' ? 'passed' : 'failed',
							runtime: capabilities.desktop_shell === 'electron' || capabilities.desktop_shell === 'tauri' ? capabilities.desktop_shell : null,
							package_targets: capabilities.package_targets,
							artifacts: normalizeArtifacts(result.artifacts),
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.package, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'desktop_smoke_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'desktop_artifacts_get',
		{
			description: 'List desktop build/smoke workflow artifacts and include any summary artifact that was uploaded.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive().optional(),
				job_id: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id, job_id }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id, 'desktop');
				const { artifacts, summary } = await fetchRunSummary(env, owner, repo, resolvedRunId);
				return toolText(ok({ repo: repoKey, run_id: resolvedRunId, artifacts, summary }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'desktop_artifacts_get_failed'), error, readAnnotations));
			}
		},
	);
}
