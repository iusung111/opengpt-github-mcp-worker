import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities } from '../../project-capabilities';
import { buildStablePreviewId, decodeToken, encodeToken, type PreviewTokenPayload } from '../../state-tokens';
import { dispatchStandardWorkflow } from '../../workflow-execution';
import {
	activateRepoWorkspace,
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
import { derivePreviewUrls, previewStatusFromSummary, summarizeRun } from '../../fullstack/logic';
import { updateJobState } from '../../fullstack/job-state';
import { fetchPreviewHealth, normalizeArtifacts, toIsoTimestamp } from './shared';

export function registerFullstackPreviewTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'preview_env_create',
		{
			description: 'Create or resolve a preview environment token backed by repo capability metadata and optional workflow commands.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				service: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(180),
				ttl_minutes: z.number().int().positive().max(1440).optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, service, wait_timeout_seconds, ttl_minutes }) => {
			const repoKey = `${owner}/${repo}`;
			const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
			try {
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (!capabilities.web_preview.enabled && !capabilities.web_preview.url_template && capabilities.web_preview.create_commands?.length === 0) {
					throw new Error('preview is not configured for this project');
				}
				let workflowResult: Awaited<ReturnType<typeof dispatchStandardWorkflow>> | null = null;
				if ((capabilities.web_preview.create_commands?.length ?? 0) > 0) {
					ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.preview);
					workflowResult = await dispatchStandardWorkflow(env, {
						owner,
						repo,
						workflow_id: capabilities.workflow_ids.preview,
						ref: effectiveRef,
						wait_timeout_ms: wait_timeout_seconds * 1000,
						request: { kind: 'preview_create', commands: capabilities.web_preview.create_commands, service: service ?? null },
					});
				}
				const urls = derivePreviewUrls(capabilities, owner, repo, effectiveRef, workflowResult?.summary ?? null, service);
				const previewId = await buildStablePreviewId(repoKey, effectiveRef);
				const expiresAt = toIsoTimestamp(Date.now() + 60_000 * (ttl_minutes ?? capabilities.web_preview.ttl_minutes));
				const payload: PreviewTokenPayload = {
					type: 'preview',
					preview_id: previewId,
					repo: repoKey,
					ref: effectiveRef,
					status: previewStatusFromSummary(workflowResult?.conclusion ?? null, urls),
					urls,
					expires_at: expiresAt,
					created_at: nowIso(),
					healthcheck_path: capabilities.web_preview.healthcheck_path ?? null,
					workflow: workflowResult?.run_id && workflowResult?.conclusion ? { owner, repo, run_id: workflowResult.run_id, workflow_id: capabilities.workflow_ids.preview } : undefined,
				};
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: payload.status === 'failed' ? 'failed' : 'working',
					nextActor: 'system',
					workflowRunId: workflowResult?.run_id ?? undefined,
					workerManifest: {
						preview: {
							status: payload.status === 'ready' ? 'ready' : payload.status === 'failed' ? 'failed' : 'creating',
							preview_id: previewId,
							urls,
							expires_at: expiresAt,
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok({
					repo: repoKey,
					ref: effectiveRef,
					preview: payload,
					preview_token: await encodeToken(env, payload),
					workflow: workflowResult ? summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.preview, workflowResult) : null,
				}, { ...writeAnnotations, job_id: job_id ?? null }));
			} catch (error) {
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'failed',
					nextActor: 'system',
					lastError: error instanceof Error ? error.message : String(error),
					workerManifest: { preview: { status: 'failed', updated_at: nowIso() } },
				});
				return toolText(fail(errorCodeFor(error, 'preview_env_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'preview_env_get',
		{
			description: 'Decode preview state and optionally probe the preview URLs for health.',
			inputSchema: { preview_token: z.string(), probe_health: z.boolean().default(false) },
			annotations: readAnnotations,
		},
		async ({ preview_token, probe_health }) => {
			try {
				const preview = await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview');
				const health = probe_health
					? await Promise.all(Object.entries(preview.urls).map(async ([service, url]) => ({ service, ...(await fetchPreviewHealth(url, preview.healthcheck_path ?? null)) })))
					: [];
				return toolText(ok({ preview, health }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'preview_env_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'preview_env_destroy',
		{
			description: 'Destroy a preview token and optionally dispatch preview teardown commands.',
			inputSchema: {
				preview_token: z.string(),
				job_id: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(180),
			},
			annotations: writeAnnotations,
		},
		async ({ preview_token, job_id, wait_timeout_seconds }) => {
			try {
				const preview = await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview');
				const [owner, repo] = preview.repo.split('/');
				ensureRepoAllowed(env, preview.repo);
				if (preview.ref !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, preview.ref);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, preview.ref);
				let workflowResult: Awaited<ReturnType<typeof dispatchStandardWorkflow>> | null = null;
				if ((capabilities.web_preview.destroy_commands?.length ?? 0) > 0) {
					ensureWorkflowAllowed(env, preview.repo, capabilities.workflow_ids.preview);
					workflowResult = await dispatchStandardWorkflow(env, {
						owner,
						repo,
						workflow_id: capabilities.workflow_ids.preview,
						ref: preview.ref,
						wait_timeout_ms: wait_timeout_seconds * 1000,
						request: { kind: 'preview_destroy', commands: capabilities.web_preview.destroy_commands, preview_id: preview.preview_id },
					});
				}
				const destroyed: PreviewTokenPayload = {
					...preview,
					status: workflowResult?.conclusion && workflowResult.conclusion !== 'success' ? 'failed' : 'destroyed',
					created_at: nowIso(),
				};
				await updateJobState(env, {
					jobId: job_id,
					repoKey: preview.repo,
					status: destroyed.status === 'failed' ? 'failed' : 'working',
					nextActor: 'system',
					workflowRunId: workflowResult?.run_id ?? undefined,
					workerManifest: {
						preview: {
							status: destroyed.status === 'failed' ? 'failed' : 'destroyed',
							preview_id: destroyed.preview_id,
							urls: destroyed.urls,
							expires_at: destroyed.expires_at,
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok({
					preview: destroyed,
					preview_token: await encodeToken(env, destroyed),
					workflow: workflowResult ? summarizeRun(preview.repo, preview.ref, capabilities.workflow_ids.preview, workflowResult) : null,
				}, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'preview_env_destroy_failed'), error, writeAnnotations));
			}
		},
	);
}
