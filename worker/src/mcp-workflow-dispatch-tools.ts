import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv, DispatchRequestRecord } from './contracts';
import { getManifestDispatchRequest, getManifestWorkflowRun, mergeWorkerManifest } from './job-manifest';
import { ToolAnnotations } from './mcp/contracts';
import {
	activateRepoWorkspace,
	buildDispatchFingerprint,
	decodeBase64Text,
	diagnosticLog,
	ensureBranchAllowed,
	ensureRepoAllowed,
	ensureWorkflowAllowed,
	encodeGitHubPath,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	getDispatchDedupeWindowMs,
	githubGet,
	githubPost,
	isOlderThan,
	nowIso,
	ok,
	queueJson,
	toolText,
	validateWorkflowInputs,
} from './utils';

async function matchesDispatchFingerprint(
	existingDispatch: Partial<DispatchRequestRecord> | null,
	expectedFingerprint: string,
	autoImproveCycle: number,
): Promise<boolean> {
	if (existingDispatch?.fingerprint === expectedFingerprint) {
		return true;
	}
	if (
		typeof existingDispatch?.owner !== 'string' ||
		typeof existingDispatch.repo !== 'string' ||
		typeof existingDispatch.workflow_id !== 'string' ||
		typeof existingDispatch.ref !== 'string' ||
		typeof existingDispatch.inputs !== 'object' ||
		!existingDispatch.inputs ||
		Array.isArray(existingDispatch.inputs)
	) {
		return false;
	}
	const normalizedExistingFingerprint = await buildDispatchFingerprint(
		existingDispatch.owner,
		existingDispatch.repo,
		existingDispatch.workflow_id,
		existingDispatch.ref,
		existingDispatch.inputs as Record<string, unknown>,
		autoImproveCycle,
	);
	return normalizedExistingFingerprint === expectedFingerprint;
}

export function registerWorkflowDispatchTools(
	server: McpServer,
	env: AppEnv,
	writeAnnotations: ToolAnnotations,
): void {
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
				ensureWorkflowAllowed(env, repoKey, workflow_id);
				validateWorkflowInputs(inputs);
				let workflowPath = `.github/workflows/${workflow_id}`;
				try {
					const workflowMeta = (await githubGet(
						env,
						`/repos/${owner}/${repo}/actions/workflows/${workflow_id}`,
					)) as { path?: string };
					if (typeof workflowMeta.path === 'string' && workflowMeta.path.trim()) {
						workflowPath = workflowMeta.path;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes('github request failed:') && message.includes(' 404 ')) {
						throw new Error(`workflow not found: ${workflow_id}`);
					}
					throw error;
				}
				try {
					const workflowFile = (await githubGet(
						env,
						`/repos/${owner}/${repo}/contents/${encodeGitHubPath(workflowPath)}`,
						{ params: { ref } },
					)) as { content?: string };
					const workflowText = decodeBase64Text(workflowFile.content);
					if (!workflowText || !/(^|\n)\s*workflow_dispatch\s*:/m.test(workflowText)) {
						throw new Error(`workflow does not support workflow_dispatch: ${workflow_id}`);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes('workflow does not support workflow_dispatch')) {
						throw error;
					}
					if (message.includes('github request failed:') && message.includes(' 404 ')) {
						throw new Error(`workflow not found on ref ${ref}: ${workflow_id}`);
					}
					throw error;
				}
				const jobId = typeof inputs.job_id === 'string' ? inputs.job_id : undefined;
				let existingJob:
					| {
							work_branch?: string;
							status?: string;
							next_actor?: string;
							auto_improve_cycle?: number;
							worker_manifest?: unknown;
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
								worker_manifest?: unknown;
						  }
						| null);
				}
				const autoImproveCycle =
					typeof existingJob?.auto_improve_cycle === 'number' ? existingJob.auto_improve_cycle : 0;
				const fingerprint = await buildDispatchFingerprint(owner, repo, workflow_id, ref, inputs, autoImproveCycle);
				const existingDispatch = getManifestDispatchRequest(existingJob?.worker_manifest) as Partial<DispatchRequestRecord> | null;
				const workflowState = getManifestWorkflowRun(existingJob?.worker_manifest);
				const isDuplicateDispatch = await matchesDispatchFingerprint(existingDispatch, fingerprint, autoImproveCycle);
				if (
					jobId &&
					existingJob?.status === 'working' &&
					existingJob?.next_actor === 'system' &&
					isDuplicateDispatch &&
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
							worker_manifest: mergeWorkerManifest(existingJob?.worker_manifest, {
								dispatch_request: {
									owner,
									repo,
									workflow_id,
									ref,
									inputs,
									fingerprint,
									dispatched_at: dispatchedAtIso,
								},
							}),
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
}


