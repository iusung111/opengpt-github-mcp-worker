import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { GUI_CAPTURE_WORKFLOW_ID, runGuiCaptureWorkflow } from '../../mcp-gui-tools';
import {
	buildStableBrowserSessionId,
	decodeToken,
	encodeToken,
	type BrowserResultTokenPayload,
	type BrowserSessionTokenPayload,
	type PreviewTokenPayload,
} from '../../state-tokens';
import { errorCodeFor, fail, getSelfRepoKey, nowIso, ok, toolText } from '../../utils';
import { getJobRecord, updateJobState } from '../../fullstack/job-state';
import { browserDiagnosticsFromSummary, getSummaryOverallStatus } from '../../fullstack/logic';
import { browserActionSchema, firstObjectUrl, readGuiCaptureDiagnosticFiles, toIsoTimestamp } from './shared';

export function registerFullstackBrowserTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
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
					file_text: target.type === 'static_file' ? file_text ?? null : null,
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
							browser: { status: 'idle', session_id: sessionId, target: resolvedUrl, updated_at: nowIso() },
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
					app_url: session.target.type === 'preview' || session.target.type === 'url' ? session.resolved_url : undefined,
					file_name: file_name ?? (session.target.type === 'static_file' ? (session.file_name ?? session.target.value) : undefined),
					file_text: file_text ?? session.file_text ?? undefined,
					scenario: { name: `browser-session-${session.session_id}`, viewport, stop_on_failure, steps: mappedSteps },
					report: { include_console_logs: true, include_network_errors: true, include_step_images: true },
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
					workflow: { owner: workflowOwner, repo: workflowRepo, workflow_id: GUI_CAPTURE_WORKFLOW_ID },
				};
				if (job_id) {
					const job = await getJobRecord(env, job_id);
					await updateJobState(env, {
						jobId: job_id,
						repoKey: job?.repo ?? selfRepoKey,
						status: getSummaryOverallStatus(summary) === 'fail' || result.conclusion !== 'success' ? 'failed' : 'working',
						nextActor: 'system',
						workerManifest: {
							browser: {
								status: getSummaryOverallStatus(summary) === 'fail' || result.conclusion !== 'success' ? 'failed' : 'passed',
								session_id: session.session_id,
								target: session.resolved_url,
								artifacts: Array.isArray(result.artifact_files) ? result.artifact_files.filter((item): item is string => typeof item === 'string') : [],
								updated_at: nowIso(),
							},
						},
					});
				}
				return toolText(ok({ ...result, session, diagnostics, browser_result_token: await encodeToken(env, resultPayload) }, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'browser_action_batch_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'browser_collect_diagnostics',
		{
			description: 'Return browser console, page error, and failed request details for a previous browser_action_batch result.',
			inputSchema: { browser_result_token: z.string() },
			annotations: readAnnotations,
		},
		async ({ browser_result_token }) => {
			try {
				const payload = await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result');
				const logs = payload.run_id && payload.workflow?.workflow_id === GUI_CAPTURE_WORKFLOW_ID
					? await readGuiCaptureDiagnosticFiles(env, payload.run_id)
					: { console: [], page_errors: [], network_errors: [] };
				return toolText(ok({ result: payload, logs }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'browser_collect_diagnostics_failed'), error, readAnnotations));
			}
		},
	);
}
