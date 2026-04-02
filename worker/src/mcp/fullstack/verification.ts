import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities, resolveVerifyProfile } from '../../project-capabilities';
import { dispatchStandardWorkflow, downloadWorkflowLogEntries } from '../../workflow-execution';
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
import { getSummaryOverallStatus, buildVerificationSteps, fetchRunSummary, normalizeLogEntries, runStatusFromConclusion, summarizeRun } from '../../fullstack/logic';
import { resolveRunIdFromInput, updateJobState } from '../../fullstack/job-state';
import { normalizeArtifacts } from './shared';

export function registerFullstackVerificationTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'verify_list_suites',
		{
			description: 'Resolve project capability metadata and list verification suites/profiles for an allowlisted repository.',
			inputSchema: { owner: z.string(), repo: z.string(), ref: z.string().optional() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const effectiveRef = ref ?? getDefaultBaseBranch(env);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				return toolText(ok({ repo: repoKey, ref: effectiveRef, capabilities, suites: capabilities.verify_profiles }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'verify_list_suites_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'verify_run',
		{
			description: 'Run a standard verification suite through the repo capability contract and attach the result to the queue manifest when job_id is provided.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				profile_id: z.string().optional(),
				job_id: z.string().optional(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(180),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, profile_id, job_id, wait_timeout_seconds }) => {
			const repoKey = `${owner}/${repo}`;
			const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
			try {
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const profile = resolveVerifyProfile(capabilities, profile_id);
				if (!profile) {
					throw new Error(`verification profile not found: ${profile_id ?? '(default)'}`);
				}
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.verify);
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'working',
					nextActor: 'system',
					workerManifest: {
						verification: { status: 'running', profile: profile.id, suite: profile.label, updated_at: nowIso() },
					},
				});
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.verify,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'verify',
						profile_id: profile.id,
						label: profile.label,
						commands: profile.commands,
						runtime_kind: capabilities.runtime_kind,
					},
				});
				const steps = buildVerificationSteps(result.summary, profile.label, result.conclusion);
				const verificationStatus =
					runStatusFromConclusion(result.conclusion) === 'passed'
						? 'passed'
						: runStatusFromConclusion(result.conclusion) === 'failed'
							? 'failed'
							: 'partial';
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: verificationStatus === 'failed' ? 'failed' : 'working',
					nextActor: 'system',
					workflowRunId: result.run_id,
					lastError: verificationStatus === 'failed' ? `verify run failed for ${profile.id}` : undefined,
					workerManifest: {
						execution: {
							profile: profile.id,
							run_id: result.run_id ? String(result.run_id) : null,
							last_workflow_run: result.run_id
								? {
										name: capabilities.workflow_ids.verify,
										status: result.status,
										conclusion: result.conclusion,
										html_url: result.run_html_url,
										run_id: result.run_id,
										updated_at: nowIso(),
								  }
								: undefined,
							artifacts: normalizeArtifacts(result.artifacts),
							updated_at: nowIso(),
						},
						verification: {
							status: verificationStatus,
							profile: profile.id,
							suite: profile.label,
							run_id: result.run_id ? String(result.run_id) : null,
							steps,
							artifacts: normalizeArtifacts(result.artifacts),
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok({ ...summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.verify, result), profile, steps }, { ...writeAnnotations, job_id: job_id ?? null }));
			} catch (error) {
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'failed',
					nextActor: 'system',
					lastError: error instanceof Error ? error.message : String(error),
					workerManifest: { verification: { status: 'failed', profile: profile_id ?? null, updated_at: nowIso() } },
				});
				return toolText(fail(errorCodeFor(error, 'verify_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'verify_get_logs',
		{
			description: 'Read GitHub Actions logs for a verification or packaging run, optionally scoped to a single file.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive().optional(),
				job_id: z.string().optional(),
				file_name: z.string().optional(),
				query: z.string().optional(),
				tail_lines: z.number().int().positive().max(400).default(80),
				limit: z.number().int().positive().max(100).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id, job_id, file_name, query, tail_lines, limit }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id);
				const logs = await downloadWorkflowLogEntries(env, owner, repo, resolvedRunId);
				return toolText(ok({ repo: repoKey, run_id: resolvedRunId, ...normalizeLogEntries(logs, query, tail_lines, file_name, limit) }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'verify_get_logs_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'verify_compare_runs',
		{
			description: 'Compare two workflow runs using their summary artifacts and step outcomes.',
			inputSchema: { owner: z.string(), repo: z.string(), left_run_id: z.number().int().positive(), right_run_id: z.number().int().positive() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, left_run_id, right_run_id }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const [left, right] = await Promise.all([
					fetchRunSummary(env, owner, repo, left_run_id),
					fetchRunSummary(env, owner, repo, right_run_id),
				]);
				const leftSteps = buildVerificationSteps(left.summary, 'left', null);
				const rightSteps = buildVerificationSteps(right.summary, 'right', null);
				const leftFailed = new Set(leftSteps.filter((step) => step.status === 'failed').map((step) => step.name));
				const rightFailed = new Set(rightSteps.filter((step) => step.status === 'failed').map((step) => step.name));
				return toolText(ok({
					repo: repoKey,
					left: { run_id: left_run_id, status: getSummaryOverallStatus(left.summary), steps: leftSteps },
					right: { run_id: right_run_id, status: getSummaryOverallStatus(right.summary), steps: rightSteps },
					diff: {
						resolved_failures: Array.from(leftFailed).filter((name) => !rightFailed.has(name)),
						new_failures: Array.from(rightFailed).filter((name) => !leftFailed.has(name)),
					},
				}, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'verify_compare_runs_failed'), error, readAnnotations));
			}
		},
	);
}
