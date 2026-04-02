import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities } from '../../project-capabilities';
import { decodeToken, type BrowserResultTokenPayload, type PreviewTokenPayload } from '../../state-tokens';
import { dispatchStandardWorkflow } from '../../workflow-execution';
import { ensureBranchAllowed, ensureWorkflowAllowed, errorCodeFor, fail, getDefaultBaseBranch, ok, toolText } from '../../utils';
import { buildReleaseGates, getSummaryOverallStatus, summarizeRun } from '../../fullstack/logic';
import { updateJobState } from '../../fullstack/job-state';

export function registerFullstackReleaseTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'deploy_promote',
		{
			description: 'Dispatch the configured release workflow for a promote action.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				deploy_target: z.enum(['mirror', 'live']).default('mirror'),
				reason: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, deploy_target, reason, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.release);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.release,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'deploy_promote', deploy_target, reason: reason ?? null },
				});
				await updateJobState(env, { jobId: job_id, repoKey, status: result.conclusion === 'success' ? 'working' : 'failed', nextActor: 'system', workflowRunId: result.run_id });
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.release, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'deploy_promote_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'deploy_rollback',
		{
			description: 'Dispatch the configured release workflow for a rollback action.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				reason: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, reason, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) ensureBranchAllowed(env, effectiveRef);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.release);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.release,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: { kind: 'deploy_rollback', reason: reason ?? null },
				});
				await updateJobState(env, { jobId: job_id, repoKey, status: result.conclusion === 'success' ? 'working' : 'failed', nextActor: 'system', workflowRunId: result.run_id });
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.release, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'deploy_rollback_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'deploy_health_matrix',
		{
			description: 'Aggregate verification, preview, browser, and desktop state into a release health matrix.',
			inputSchema: {
				preview_token: z.string().optional(),
				verify_status: z.string().optional(),
				browser_result_token: z.string().optional(),
				desktop_status: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ preview_token, verify_status, browser_result_token, desktop_status }) => {
			try {
				const preview = preview_token ? await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview') : null;
				const browser = browser_result_token ? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result') : null;
				const previewStatus = preview?.status ?? null;
				const browserStatus = getSummaryOverallStatus(browser?.summary ?? null) === 'pass' ? 'passed' : getSummaryOverallStatus(browser?.summary ?? null);
				const gates = buildReleaseGates({ verifyStatus: verify_status ?? null, previewStatus, browserStatus, desktopStatus: desktop_status ?? null });
				return toolText(ok({ preview, browser, verify_status: verify_status ?? null, desktop_status: desktop_status ?? null, gates, healthy: gates.every((gate) => gate.ok === true) }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'deploy_health_matrix_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'release_verify',
		{
			description: 'Evaluate the minimum release gates across verify, preview, browser, and desktop status inputs.',
			inputSchema: {
				preview_token: z.string().optional(),
				verify_status: z.string().optional(),
				browser_result_token: z.string().optional(),
				desktop_status: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ preview_token, verify_status, browser_result_token, desktop_status }) => {
			try {
				const preview = preview_token ? await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview') : null;
				const browser = browser_result_token ? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result') : null;
				const browserStatus = getSummaryOverallStatus(browser?.summary ?? null) === 'pass' ? 'passed' : getSummaryOverallStatus(browser?.summary ?? null);
				const gates = buildReleaseGates({ verifyStatus: verify_status ?? null, previewStatus: preview?.status ?? null, browserStatus, desktopStatus: desktop_status ?? null });
				return toolText(ok({ release_ready: gates.every((gate) => gate.ok === true), gates }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'release_verify_failed'), error, readAnnotations));
			}
		},
	);
}
