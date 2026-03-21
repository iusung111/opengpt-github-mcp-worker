import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv, DispatchRequestRecord } from './types';
import { ToolAnnotations } from './mcp-overview-tools';
import {
	activateRepoWorkspace,
	buildDispatchFingerprint,
	diagnosticLog,
	ensureBranchAllowed,
	ensureRepoAllowed,
	ensureWorkflowAllowed,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	getDispatchDedupeWindowMs,
	githubPost,
	isOlderThan,
	nowIso,
	ok,
	queueJson,
	toolText,
	validateWorkflowInputs,
} from './utils';

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
