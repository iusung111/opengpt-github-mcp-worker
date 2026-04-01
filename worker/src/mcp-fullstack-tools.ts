import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { GUI_CAPTURE_WORKFLOW_ID, runGuiCaptureWorkflow } from './mcp-gui-tools';
import { ToolAnnotations } from './mcp-overview-tools';
import { notificationWidgetToolMeta } from './mcp-widget-resources';
import {
	ProjectCapabilities,
	resolveProjectCapabilities,
	resolveVerifyProfile,
} from './project-capabilities';
import {
	buildStableBrowserSessionId,
	buildStablePreviewId,
	BrowserResultTokenPayload,
	BrowserSessionTokenPayload,
	buildConfirmToken,
	decodeToken,
	encodeToken,
	PreviewTokenPayload,
	validateConfirmToken,
} from './state-tokens';
import { AppEnv } from './types';
import {
	dispatchStandardWorkflow,
	downloadWorkflowArtifactEntries,
	downloadWorkflowLogEntries,
	listWorkflowArtifacts,
} from './workflow-execution';
import {
	activateRepoWorkspace,
	ensureBranchAllowed,
	ensureRepoAllowed,
	ensureWorkflowAllowed,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	queueJson,
	getSelfRepoKey,
	ok,
	nowIso,
	sha256Hex,
	toolText,
} from './utils';

import {
	getJobRecord,
	isRecord,
	resolveRunIdFromInput,
	updateJobState,
} from './fullstack/job-state';
import {
	findContractCandidates,
	readRepoTextFile,
	readRepoTree,
} from './fullstack/repo-utils';
import {
	browserDiagnosticsFromSummary,
	buildReleaseGates,
	buildVerificationSteps,
	derivePreviewUrls,
	fetchRunSummary,
	getSummaryOverallStatus,
	normalizeContractValidation,
	normalizeLogEntries,
	previewStatusFromSummary,
	runStatusFromConclusion,
	summarizeRun,
	buildErrorFingerprint,
} from './fullstack/logic';

function toIsoTimestamp(input: number): string {
	return new Date(input).toISOString();
}

function decodeBytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function normalizeArtifacts(artifacts: Array<Record<string, unknown>>): string[] {
	return artifacts
		.map((artifact) => {
			const id = artifact.id;
			if (typeof id === 'number') return String(id);
			if (typeof id === 'string' && id.trim()) return id.trim();
			return '';
		})
		.filter(Boolean);
}

const incidentBundleStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.incident_bundle'),
		bundle_id: z.string(),
		repo: z.string(),
		scope: z.enum(['job', 'all_active']),
		run_id: z.number().int().positive().optional(),
		summary: z.object({}).passthrough().nullable().optional(),
		artifacts: z.array(z.object({}).passthrough()).optional(),
		preview: z.object({}).passthrough().nullable().optional(),
		browser: z.object({}).passthrough().nullable().optional(),
		runs: z.array(z.object({}).passthrough()).optional(),
		layer_logs: z.array(z.object({}).passthrough()).optional(),
		error_logs: z.array(z.object({}).passthrough()).optional(),
	})
	.passthrough();

function firstObjectUrl(urls: Record<string, string>): string | null {
	for (const value of Object.values(urls)) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

async function collectRuntimeErrorClusters(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	const entries = await downloadWorkflowLogEntries(env, owner, repo, runId);
	const clusters = new Map<string, { count: number; samples: string[]; files: Set<string> }>();
	for (const [fileName, bytes] of entries) {
		for (const line of decodeBytes(bytes).split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || !/(error|exception|failed|panic)/i.test(trimmed)) {
				continue;
			}
			const fingerprint = buildErrorFingerprint(trimmed);
			const existing = clusters.get(fingerprint) ?? { count: 0, samples: [], files: new Set<string>() };
			existing.count += 1;
			existing.files.add(fileName);
			if (existing.samples.length < 3) {
				existing.samples.push(trimmed);
			}
			clusters.set(fingerprint, existing);
		}
	}
	return Array.from(clusters.entries())
		.map(([fingerprint, value]) => ({
			fingerprint,
			count: value.count,
			files: Array.from(value.files).sort(),
			samples: value.samples,
		}))
		.sort((left, right) => Number(right.count) - Number(left.count))
		.slice(0, limit);
}

async function readGuiCaptureDiagnosticFiles(env: AppEnv, runId: number): Promise<Record<string, unknown>> {
	const repoKey = getSelfRepoKey(env);
	const [owner, repo] = repoKey.split('/');
	const artifacts = await listWorkflowArtifacts(env, owner, repo, runId);
	for (const artifact of artifacts) {
		const artifactId = typeof artifact.id === 'number' ? artifact.id : Number(artifact.id);
		if (!Number.isFinite(artifactId) || artifactId <= 0) {
			continue;
		}
		const entries = await downloadWorkflowArtifactEntries(env, owner, repo, artifactId);
		const consoleEntry = entries.get('logs/console.json');
		const pageErrorsEntry = entries.get('logs/page-errors.json');
		const networkErrorsEntry = entries.get('logs/network-errors.json');
		if (consoleEntry || pageErrorsEntry || networkErrorsEntry) {
			return {
				console: consoleEntry ? JSON.parse(decodeBytes(consoleEntry)) : [],
				page_errors: pageErrorsEntry ? JSON.parse(decodeBytes(pageErrorsEntry)) : [],
				network_errors: networkErrorsEntry ? JSON.parse(decodeBytes(networkErrorsEntry)) : [],
			};
		}
	}
	return {
		console: [],
		page_errors: [],
		network_errors: [],
	};
}

async function resolveApiTargetUrl(
	env: AppEnv,
	previewToken: string | undefined,
	appUrl: string | undefined,
	requestPath: string | undefined,
): Promise<string> {
	if (previewToken) {
		const preview = await decodeToken<PreviewTokenPayload>(env, previewToken, 'preview');
		const baseUrl = firstObjectUrl(preview.urls);
		if (!baseUrl) {
			throw new Error('preview token does not include a target URL');
		}
		return new URL(requestPath?.trim() || '/', baseUrl).toString();
	}
	if (appUrl?.trim()) {
		return requestPath?.trim() ? new URL(requestPath.trim(), appUrl.trim()).toString() : appUrl.trim();
	}
	throw new Error('preview_token or app_url is required');
}

async function fetchPreviewHealth(url: string, healthcheckPath?: string | null): Promise<Record<string, unknown>> {
	const targetUrl = healthcheckPath ? new URL(healthcheckPath, url).toString() : url;
	const response = await fetch(targetUrl, { method: 'GET', redirect: 'follow' });
	return {
		url: targetUrl,
		status: response.status,
		ok: response.ok,
	};
}

export function registerFullstackTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'verify_list_suites',
		{
			description: 'Resolve project capability metadata and list verification suites/profiles for an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, ref ?? getDefaultBaseBranch(env));
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: ref ?? getDefaultBaseBranch(env),
							capabilities,
							suites: capabilities.verify_profiles,
						},
						readAnnotations,
					),
				);
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
						verification: {
							status: 'running',
							profile: profile.id,
							suite: profile.label,
							updated_at: nowIso(),
						},
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
				return toolText(
					ok(
						{
							...summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.verify, result),
							profile,
							steps,
						},
						{
							...writeAnnotations,
							job_id: job_id ?? null,
						},
					),
				);
			} catch (error) {
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'failed',
					nextActor: 'system',
					lastError: error instanceof Error ? error.message : String(error),
					workerManifest: {
						verification: {
							status: 'failed',
							profile: profile_id ?? null,
							updated_at: nowIso(),
						},
					},
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
				return toolText(
					ok(
						{
							repo: repoKey,
							run_id: resolvedRunId,
							...normalizeLogEntries(logs, query, tail_lines, file_name, limit),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'verify_get_logs_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'verify_compare_runs',
		{
			description: 'Compare two workflow runs using their summary artifacts and step outcomes.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				left_run_id: z.number().int().positive(),
				right_run_id: z.number().int().positive(),
			},
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
				return toolText(
					ok(
						{
							repo: repoKey,
							left: {
								run_id: left_run_id,
								status: getSummaryOverallStatus(left.summary),
								steps: leftSteps,
							},
							right: {
								run_id: right_run_id,
								status: getSummaryOverallStatus(right.summary),
								steps: rightSteps,
							},
							diff: {
								resolved_failures: Array.from(leftFailed).filter((name) => !rightFailed.has(name)),
								new_failures: Array.from(rightFailed).filter((name) => !leftFailed.has(name)),
							},
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'verify_compare_runs_failed'), error, readAnnotations));
			}
		},
	);

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
				if (
					!capabilities.web_preview.enabled &&
					!capabilities.web_preview.url_template &&
					capabilities.web_preview.create_commands?.length === 0
				) {
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
						request: {
							kind: 'preview_create',
							commands: capabilities.web_preview.create_commands,
							service: service ?? null,
						},
					});
				}
				const urls = derivePreviewUrls(capabilities, owner, repo, effectiveRef, workflowResult?.summary ?? null, service);
				const previewId = await buildStablePreviewId(repoKey, effectiveRef);
				const expiresAt = toIsoTimestamp(
					Date.now() + 60_000 * (ttl_minutes ?? capabilities.web_preview.ttl_minutes),
				);
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
					workflow:
						workflowResult?.run_id && workflowResult?.conclusion
							? {
									owner,
									repo,
									run_id: workflowResult.run_id,
									workflow_id: capabilities.workflow_ids.preview,
							  }
							: undefined,
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
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: effectiveRef,
							preview: payload,
							preview_token: await encodeToken(env, payload),
							workflow: workflowResult
								? summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.preview, workflowResult)
								: null,
						},
						{
							...writeAnnotations,
							job_id: job_id ?? null,
						},
					),
				);
			} catch (error) {
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'failed',
					nextActor: 'system',
					lastError: error instanceof Error ? error.message : String(error),
					workerManifest: {
						preview: {
							status: 'failed',
							updated_at: nowIso(),
						},
					},
				});
				return toolText(fail(errorCodeFor(error, 'preview_env_create_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'preview_env_get',
		{
			description: 'Decode preview state and optionally probe the preview URLs for health.',
			inputSchema: {
				preview_token: z.string(),
				probe_health: z.boolean().default(false),
			},
			annotations: readAnnotations,
		},
		async ({ preview_token, probe_health }) => {
			try {
				const preview = await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview');
				const health = probe_health
					? await Promise.all(
							Object.entries(preview.urls).map(async ([service, url]) => ({
								service,
								...(await fetchPreviewHealth(url, preview.healthcheck_path ?? null)),
							})),
						)
					: [];
				return toolText(
					ok(
						{
							preview,
							health,
						},
						readAnnotations,
					),
				);
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
						request: {
							kind: 'preview_destroy',
							commands: capabilities.web_preview.destroy_commands,
							preview_id: preview.preview_id,
						},
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
				return toolText(
					ok(
						{
							preview: destroyed,
							preview_token: await encodeToken(env, destroyed),
							workflow: workflowResult
								? summarizeRun(preview.repo, preview.ref, capabilities.workflow_ids.preview, workflowResult)
								: null,
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'preview_env_destroy_failed'), error, writeAnnotations));
			}
		},
	);

	const browserActionSchema = z.object({
		action: z.enum([
			'goto',
			'click',
			'type',
			'select',
			'press',
			'wait_for',
			'assert_text',
			'assert_visible',
			'assert_url',
			'snapshot',
		]),
		selector: z.string().optional(),
		value: z.string().optional(),
		url: z.string().optional(),
		expected_text: z.string().optional(),
		timeout_ms: z.number().int().positive().max(60000).optional(),
	});

	server.registerTool(
		'browser_session_start',
		{
			description: 'Create a browser session token that can target a preview URL, an explicit URL, or inline HTML for later scenario execution.',
			inputSchema: {
				preview_token: z.string().optional(),
				app_url: z.string().url().optional(),
				file_name: z.string().optional(),
				file_text: z.string().optional(),
				viewport: z.enum(['desktop', 'tablet', 'mobile']).default('desktop'),
				locale: z.string().default('en-US'),
				color_scheme: z.enum(['light', 'dark']).default('light'),
				job_id: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ preview_token, app_url, file_name, file_text, viewport, locale, color_scheme, job_id }) => {
			try {
				let target: BrowserSessionTokenPayload['target'];
				let resolvedUrl: string;
				if (preview_token) {
					const preview = await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview');
					const url = firstObjectUrl(preview.urls);
					if (!url) {
						throw new Error('preview token does not include a target URL');
					}
					target = { type: 'preview', value: preview.preview_id };
					resolvedUrl = url;
				} else if (app_url?.trim()) {
					target = { type: 'url', value: app_url.trim() };
					resolvedUrl = app_url.trim();
				} else if (file_name?.trim() && typeof file_text === 'string') {
					target = { type: 'static_file', value: file_name.trim() };
					resolvedUrl = `inline-html:${file_name.trim()}`;
				} else {
					throw new Error('preview_token, app_url, or file_name + file_text is required');
				}
				const sessionId = await buildStableBrowserSessionId(`${resolvedUrl}:${viewport}:${locale}:${color_scheme}`);
				const payload: BrowserSessionTokenPayload = {
					type: 'browser_session',
					session_id: sessionId,
					target,
					resolved_url: resolvedUrl,
					viewport,
					locale,
					color_scheme,
					file_name: file_name?.trim() || null,
					file_text: target?.type === 'static_file' ? file_text ?? null : null,
					created_at: nowIso(),
					expires_at: toIsoTimestamp(Date.now() + 30 * 60_000),
				};
				if (job_id) {
					const job = await getJobRecord(env, job_id);
					await updateJobState(env, {
						jobId: job_id,
						repoKey: job?.repo ?? getSelfRepoKey(env),
						status: 'working',
						nextActor: 'system',
						workerManifest: {
							browser: {
								status: 'idle',
								session_id: sessionId,
								target: resolvedUrl,
								updated_at: nowIso(),
							},
						},
					});
				}
				return toolText(ok({ session: payload, session_token: await encodeToken(env, payload) }, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'browser_session_start_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'browser_action_batch',
		{
			description: 'Execute a batch of browser actions through the existing gui capture workflow and return a result token with diagnostics.',
			inputSchema: {
				session_token: z.string(),
				actions: z.array(browserActionSchema).min(1),
				job_id: z.string().optional(),
				stop_on_failure: z.boolean().default(true),
				wait_timeout_seconds: z.number().int().positive().max(240).default(120),
				include_image_base64: z.boolean().default(false),
				file_name: z.string().optional(),
				file_text: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ session_token, actions, job_id, stop_on_failure, wait_timeout_seconds, include_image_base64, file_name, file_text }) => {
			try {
				const session = await decodeToken<BrowserSessionTokenPayload>(env, session_token, 'browser_session');
				const mappedSteps = actions.map((action, index) => ({
					id: `browser-${index + 1}`,
					name: `${action.action}-${index + 1}`,
					action: action.action === 'goto' ? 'open' : action.action === 'snapshot' ? 'screenshot' : action.action,
					selector: action.selector,
					value: action.value,
					url: action.url ?? (action.action === 'goto' ? action.value : undefined),
					expected_text: action.expected_text,
					expected_value: action.action === 'assert_url' ? action.value ?? action.url : undefined,
					timeout_ms: action.timeout_ms,
				}));
				const viewport =
					session.viewport === 'mobile'
						? { width: 430, height: 932 }
						: session.viewport === 'tablet'
							? { width: 1024, height: 1366 }
							: { width: 1440, height: 900 };
				const result = await runGuiCaptureWorkflow(env, {
					app_url:
						session.target.type === 'preview' || session.target.type === 'url'
							? session.resolved_url
							: undefined,
					file_name:
						file_name ??
						(session.target.type === 'static_file' ? (session.file_name ?? session.target.value) : undefined),
					file_text: file_text ?? session.file_text ?? undefined,
					scenario: {
						name: `browser-session-${session.session_id}`,
						viewport,
						stop_on_failure,
						steps: mappedSteps,
					},
					report: {
						include_console_logs: true,
						include_network_errors: true,
						include_step_images: true,
					},
					include_image_base64,
					wait_timeout_seconds,
				});
				const summary = (result.summary as Record<string, unknown> | undefined) ?? null;
				const diagnostics = browserDiagnosticsFromSummary(summary);
				const selfRepoKey = getSelfRepoKey(env);
				const [workflowOwner, workflowRepo] = selfRepoKey.split('/');
				const resultPayload: BrowserResultTokenPayload = {
					type: 'browser_result',
					session_id: session.session_id,
					run_id: typeof result.run_id === 'number' ? result.run_id : null,
					run_html_url: typeof result.run_html_url === 'string' ? result.run_html_url : null,
					summary: summary ?? {},
					diagnostics,
					created_at: nowIso(),
					expires_at: toIsoTimestamp(Date.now() + 24 * 60 * 60_000),
					workflow: {
						owner: workflowOwner,
						repo: workflowRepo,
						workflow_id: GUI_CAPTURE_WORKFLOW_ID,
					},
				};
				if (job_id) {
					const job = await getJobRecord(env, job_id);
					await updateJobState(env, {
						jobId: job_id,
						repoKey: job?.repo ?? selfRepoKey,
						status:
							getSummaryOverallStatus(summary) === 'fail' || result.conclusion !== 'success' ? 'failed' : 'working',
						nextActor: 'system',
						workerManifest: {
							browser: {
								status:
									getSummaryOverallStatus(summary) === 'fail' || result.conclusion !== 'success' ? 'failed' : 'passed',
								session_id: session.session_id,
								target: session.resolved_url,
								artifacts: Array.isArray(result.artifact_files)
									? result.artifact_files.filter((item): item is string => typeof item === 'string')
									: [],
								updated_at: nowIso(),
							},
						},
					});
				}
				return toolText(
					ok(
						{
							...result,
							session,
							diagnostics,
							browser_result_token: await encodeToken(env, resultPayload),
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'browser_action_batch_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'browser_collect_diagnostics',
		{
			description: 'Return browser console, page error, and failed request details for a previous browser_action_batch result.',
			inputSchema: {
				browser_result_token: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ browser_result_token }) => {
			try {
				const payload = await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result');
				const logs =
					payload.run_id && payload.workflow?.workflow_id === GUI_CAPTURE_WORKFLOW_ID
						? await readGuiCaptureDiagnosticFiles(env, payload.run_id)
						: { console: [], page_errors: [], network_errors: [] };
				return toolText(ok({ result: payload, logs }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'browser_collect_diagnostics_failed'), error, readAnnotations));
			}
		},
	);

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
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const commands =
					capabilities.desktop.build_commands.length > 0
						? capabilities.desktop.build_commands
						: capabilities.verify_profiles
								.filter((profile) => profile.kind === 'desktop_build')
								.flatMap((profile) => profile.commands);
				if (commands.length === 0) {
					throw new Error('desktop build commands are not configured');
				}
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
							runtime:
								capabilities.desktop_shell === 'electron' || capabilities.desktop_shell === 'tauri'
									? capabilities.desktop_shell
									: null,
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
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const commands =
					capabilities.desktop.smoke_commands.length > 0
						? capabilities.desktop.smoke_commands
						: capabilities.verify_profiles
								.filter((profile) => profile.kind === 'desktop_smoke')
								.flatMap((profile) => profile.commands);
				if (commands.length === 0) {
					throw new Error('desktop smoke commands are not configured');
				}
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
							runtime:
								capabilities.desktop_shell === 'electron' || capabilities.desktop_shell === 'tauri'
									? capabilities.desktop_shell
									: null,
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

	server.registerTool(
		'api_contract_list',
		{
			description: 'List API contract files discovered from project capabilities or repository heuristics.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: effectiveRef,
							configured_sources: capabilities.api_contract_sources,
							contracts: findContractCandidates(tree, capabilities.api_contract_sources),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'api_contract_get',
		{
			description: 'Read a single API contract file from the repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				path: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, path, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: effectiveRef,
							path,
							text: await readRepoTextFile(env, owner, repo, path, effectiveRef),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'api_request_run',
		{
			description: 'Make a direct API request against a preview URL or explicit app URL and return a concise response summary.',
			inputSchema: {
				preview_token: z.string().optional(),
				app_url: z.string().url().optional(),
				path: z.string().optional(),
				method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
				headers: z.record(z.string(), z.string()).default({}),
				body_text: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ preview_token, app_url, path, method, headers, body_text }) => {
			try {
				const url = await resolveApiTargetUrl(env, preview_token, app_url, path);
				const response = await fetch(url, {
					method,
					headers: {
						...headers,
					},
					body: body_text,
				});
				const responseText = await response.text();
				return toolText(
					ok(
						{
							url,
							method,
							status: response.status,
							ok: response.ok,
							content_type: response.headers.get('content-type'),
							body_excerpt: responseText.slice(0, 4000),
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_request_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'api_contract_validate',
		{
			description: 'Perform lightweight validation on discovered API contract files.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				const contracts = findContractCandidates(tree, capabilities.api_contract_sources);
				const validations = [];
				for (const contract of contracts.slice(0, 20)) {
					const path = String(contract.path ?? '');
					if (!path || String(contract.type ?? '') !== 'blob') {
						continue;
					}
					const text = await readRepoTextFile(env, owner, repo, path, effectiveRef);
					validations.push(normalizeContractValidation(path, text));
				}
				return toolText(ok({ repo: `${owner}/${repo}`, ref: effectiveRef, validations }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_validate_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'db_schema_inspect',
		{
			description: 'Inspect repository schema and migration paths using project capability metadata.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				const inspectPaths = new Set<string>();
				for (const entry of tree) {
					const entryPath = String(entry.path ?? '');
					if (!entryPath) continue;
					if (
						capabilities.db.inspect_paths.some(
							(prefix) => entryPath === prefix || entryPath.startsWith(`${prefix}/`),
						)
					) {
						inspectPaths.add(entryPath);
					}
				}
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: effectiveRef,
							db_mode: capabilities.db_mode,
							inspect_paths: Array.from(inspectPaths).sort(),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_schema_inspect_failed'), error, readAnnotations));
			}
		},
	);

	const dbMutationSchema = {
		owner: z.string(),
		repo: z.string(),
		ref: z.string().optional(),
		job_id: z.string().optional(),
		wait_timeout_seconds: z.number().int().positive().max(900).default(300),
	};

	server.registerTool(
		'db_migration_apply',
		{
			description: 'Dispatch configured database migration commands through the standard execution workflow.',
			inputSchema: dbMutationSchema,
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.migration_commands.length === 0) {
					throw new Error('db migration commands are not configured');
				}
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'db_migration',
						commands: capabilities.db.migration_commands,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
					workerManifest: {
						runtime: {
							status: result.conclusion === 'success' ? 'ready' : 'failed',
							updated_at: nowIso(),
						},
					},
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_migration_apply_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_seed_run',
		{
			description: 'Dispatch configured database seed commands through the standard execution workflow.',
			inputSchema: dbMutationSchema,
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.seed_commands.length === 0) {
					throw new Error('db seed commands are not configured');
				}
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'db_seed',
						commands: capabilities.db.seed_commands,
					},
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_seed_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_reset_prepare',
		{
			description: 'Issue a short-lived signed confirm token for db_reset on an allowlisted repository/ref.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				ttl_minutes: z.number().int().positive().max(30).default(10),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, ttl_minutes }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.reset_commands.length === 0) {
					throw new Error('db reset commands are not configured');
				}
				const issued = await buildConfirmToken(env, {
					action: 'db_reset',
					repo: repoKey,
					ref: effectiveRef,
					ttl_minutes,
				});
				return toolText(
					ok(
						{
							repo: repoKey,
							ref: effectiveRef,
							confirm_token: issued.token,
							confirm: issued.payload,
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_reset_prepare_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_reset',
		{
			description: 'Run destructive DB reset commands only when the confirm token was minted by db_reset_prepare for the same repo/ref.',
			inputSchema: {
				...dbMutationSchema,
				confirm_token: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, wait_timeout_seconds, confirm_token }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				await validateConfirmToken(env, {
					token: confirm_token,
					action: 'db_reset',
					repo: repoKey,
					ref: effectiveRef,
				});
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (capabilities.db.reset_commands.length === 0) {
					throw new Error('db reset commands are not configured');
				}
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'db_reset',
						commands: capabilities.db.reset_commands,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_reset_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'db_query_safe',
		{
			description: 'Run a repo-defined DB query command with OPENGPT_QUERY_TEXT passed via the workflow environment.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				job_id: z.string().optional(),
				query_text: z.string(),
				wait_timeout_seconds: z.number().int().positive().max(900).default(300),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, ref, job_id, query_text, wait_timeout_seconds }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				if (!capabilities.db.query_command) {
					throw new Error('db query command is not configured');
				}
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.db);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.db,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'db_query',
						query_command: capabilities.db.query_command,
						query_text,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
				});
				return toolText(ok(summarizeRun(repoKey, effectiveRef, capabilities.workflow_ids.db, result), writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'db_query_safe_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'runtime_log_query',
		{
			description: 'Search workflow log archives for matching lines and return tail excerpts per file.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive().optional(),
				job_id: z.string().optional(),
				query: z.string().optional(),
				tail_lines: z.number().int().positive().max(400).default(80),
				limit: z.number().int().positive().max(100).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id, job_id, query, tail_lines, limit }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id, 'runtime');
				const entries = await downloadWorkflowLogEntries(env, owner, repo, resolvedRunId);
				return toolText(
					ok(
						{
							repo: repoKey,
							run_id: resolvedRunId,
							...normalizeLogEntries(entries, query, tail_lines, undefined, limit),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'runtime_log_query_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'runtime_error_cluster',
		{
			description: 'Cluster workflow log error lines into fingerprints for faster triage.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive().optional(),
				job_id: z.string().optional(),
				limit: z.number().int().positive().max(50).default(10),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id, job_id, limit }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id, 'runtime');
				return toolText(
					ok(
						{
							repo: repoKey,
							run_id: resolvedRunId,
							clusters: await collectRuntimeErrorClusters(env, owner, repo, resolvedRunId, limit),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'runtime_error_cluster_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'incident_bundle_create',
		{
			description: 'Build a compact incident bundle from job state, workflow summaries, preview state, and browser diagnostics.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive().optional(),
				job_id: z.string().optional(),
				preview_token: z.string().optional(),
				browser_result_token: z.string().optional(),
				scope: z.enum(['job', 'all_active']).default('job'),
				include_layer_logs: z.boolean().default(false),
			},
			outputSchema: incidentBundleStructuredSchema,
			annotations: writeAnnotations,
			_meta: notificationWidgetToolMeta({
				'openai/toolInvocation/invoking': 'Collecting incident bundle',
				'openai/toolInvocation/invoked': 'Incident bundle ready',
			}),
		},
		async ({ owner, repo, run_id, job_id, preview_token, browser_result_token, scope, include_layer_logs }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				if (scope === 'all_active') {
					const jobsResult = await queueJson(env, { action: 'jobs_list' });
					if (!jobsResult.ok) {
						throw new Error(jobsResult.error ?? 'failed to list jobs');
					}
					const repoJobs = (((jobsResult.data?.jobs as unknown[]) ?? []).filter((item) => {
						const job = item as Record<string, unknown>;
						const runSummary = (job.run_summary ?? null) as Record<string, unknown> | null;
						return (
							job.repo === repoKey &&
							runSummary?.status !== 'completed' &&
							runSummary?.status !== 'failed'
						);
					}) as Array<Record<string, unknown>>);
					const runs = [];
					const layerLogs = [];
					for (const job of repoJobs) {
						const jobId = typeof job.job_id === 'string' ? job.job_id : null;
						if (!jobId) {
							continue;
						}
						runs.push({
							job_id: jobId,
							run_id: jobId,
							repo: repoKey,
							run_summary: job.run_summary ?? null,
							blocking_state: job.blocking_state ?? null,
							latest_notification: job.latest_notification ?? null,
						});
						if (include_layer_logs) {
							const feedResult = await queueJson(env, { action: 'job_event_feed', job_id: jobId, limit: 50 });
							if (feedResult.ok) {
								layerLogs.push(
									...(((feedResult.data?.logs as unknown[]) ?? []).map((entry) => ({
										job_id: jobId,
										...((entry as Record<string, unknown>) ?? {}),
									})) as Array<Record<string, unknown>>),
								);
							}
						}
					}
					return toolText(
						ok(
							{
								bundle_id: `inc_repo_${Date.now()}`,
								repo: repoKey,
								scope,
								exported_at: nowIso(),
								runs,
								layer_logs: include_layer_logs ? layerLogs : [],
								error_logs: include_layer_logs
									? layerLogs.filter((entry) => entry.level === 'error')
									: [],
							},
							writeAnnotations,
						),
					);
				}
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id, 'runtime');
				const summary = await fetchRunSummary(env, owner, repo, resolvedRunId);
				const preview = preview_token ? await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview') : null;
				const browser = browser_result_token
					? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result')
					: null;
				const eventFeed =
					include_layer_logs && job_id
						? await queueJson(env, { action: 'job_event_feed', job_id, limit: 50 })
						: null;
				const bundleId = `inc_${(
					await sha256Hex(
						JSON.stringify({
							repo: repoKey,
							run_id: resolvedRunId,
							preview_id: preview?.preview_id ?? null,
							session_id: browser?.session_id ?? null,
						}),
					)
				).slice(0, 14)}`;
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'working',
					nextActor: 'system',
					workerManifest: {
						runtime: {
							status: 'ready',
							incident_bundle_id: bundleId,
							updated_at: nowIso(),
						},
					},
				});
				return toolText(
					ok(
						{
							bundle_id: bundleId,
							repo: repoKey,
							run_id: resolvedRunId,
							summary: summary.summary,
							artifacts: summary.artifacts,
							preview,
							browser,
							scope,
							layer_logs: include_layer_logs ? (eventFeed?.data?.logs ?? []) : [],
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'incident_bundle_create_failed'), error, writeAnnotations));
			}
		},
	);

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
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.release);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.release,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'deploy_promote',
						deploy_target,
						reason: reason ?? null,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
				});
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
				if (effectiveRef !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, effectiveRef);
				}
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				ensureWorkflowAllowed(env, repoKey, capabilities.workflow_ids.release);
				const result = await dispatchStandardWorkflow(env, {
					owner,
					repo,
					workflow_id: capabilities.workflow_ids.release,
					ref: effectiveRef,
					wait_timeout_ms: wait_timeout_seconds * 1000,
					request: {
						kind: 'deploy_rollback',
						reason: reason ?? null,
					},
				});
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: result.conclusion === 'success' ? 'working' : 'failed',
					nextActor: 'system',
					workflowRunId: result.run_id,
				});
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
				const browser = browser_result_token
					? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result')
					: null;
				const previewStatus = preview?.status ?? null;
				const browserStatus =
					getSummaryOverallStatus(browser?.summary ?? null) === 'pass'
						? 'passed'
						: getSummaryOverallStatus(browser?.summary ?? null);
				const gates = buildReleaseGates({
					verifyStatus: verify_status ?? null,
					previewStatus,
					browserStatus,
					desktopStatus: desktop_status ?? null,
				});
				return toolText(
					ok(
						{
							preview,
							browser,
							verify_status: verify_status ?? null,
							desktop_status: desktop_status ?? null,
							gates,
							healthy: gates.every((gate) => gate.ok === true),
						},
						readAnnotations,
					),
				);
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
				const browser = browser_result_token
					? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result')
					: null;
				const browserStatus =
					getSummaryOverallStatus(browser?.summary ?? null) === 'pass'
						? 'passed'
						: getSummaryOverallStatus(browser?.summary ?? null);
				const gates = buildReleaseGates({
					verifyStatus: verify_status ?? null,
					previewStatus: preview?.status ?? null,
					browserStatus,
					desktopStatus: desktop_status ?? null,
				});
				return toolText(
					ok(
						{
							release_ready: gates.every((gate) => gate.ok === true),
							gates,
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'release_verify_failed'), error, readAnnotations));
			}
		},
	);
}
