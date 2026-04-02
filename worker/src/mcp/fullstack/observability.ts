import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { decodeToken, type BrowserResultTokenPayload, type PreviewTokenPayload } from '../../state-tokens';
import { notificationWidgetToolMeta } from '../../mcp-widget-resources';
import { downloadWorkflowLogEntries } from '../../workflow-execution';
import {
	errorCodeFor,
	fail,
	nowIso,
	ok,
	queueJson,
	sha256Hex,
	toolText,
} from '../../utils';
import { fetchRunSummary, normalizeLogEntries } from '../../fullstack/logic';
import { resolveRunIdFromInput, updateJobState } from '../../fullstack/job-state';
import { collectRuntimeErrorClusters, incidentBundleStructuredSchema } from './shared';

export function registerFullstackObservabilityTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
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
				return toolText(ok({ repo: repoKey, run_id: resolvedRunId, ...normalizeLogEntries(entries, query, tail_lines, undefined, limit) }, readAnnotations));
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
				return toolText(ok({ repo: repoKey, run_id: resolvedRunId, clusters: await collectRuntimeErrorClusters(env, owner, repo, resolvedRunId, limit) }, readAnnotations));
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
					if (!jobsResult.ok) throw new Error(jobsResult.error ?? 'failed to list jobs');
					const repoJobs = (((jobsResult.data?.jobs as unknown[]) ?? []).filter((item) => {
						const job = item as Record<string, unknown>;
						const runSummary = (job.run_summary ?? null) as Record<string, unknown> | null;
						return job.repo === repoKey && runSummary?.status !== 'completed' && runSummary?.status !== 'failed';
					})) as Array<Record<string, unknown>>;
					const runs = [];
					const layerLogs = [];
					for (const job of repoJobs) {
						const activeJobId = typeof job.job_id === 'string' ? job.job_id : null;
						if (!activeJobId) continue;
						runs.push({
							job_id: activeJobId,
							run_id: activeJobId,
							repo: repoKey,
							run_summary: job.run_summary ?? null,
							blocking_state: job.blocking_state ?? null,
							latest_notification: job.latest_notification ?? null,
						});
						if (include_layer_logs) {
							const feedResult = await queueJson(env, { action: 'job_event_feed', job_id: activeJobId, limit: 50 });
							if (feedResult.ok) {
								layerLogs.push(...(((feedResult.data?.logs as unknown[]) ?? []).map((entry) => ({ job_id: activeJobId, ...((entry as Record<string, unknown>) ?? {}) })) as Array<Record<string, unknown>>));
							}
						}
					}
					return toolText(ok({
						bundle_id: `inc_repo_${Date.now()}`,
						repo: repoKey,
						scope,
						exported_at: nowIso(),
						runs,
						layer_logs: include_layer_logs ? layerLogs : [],
						error_logs: include_layer_logs ? layerLogs.filter((entry) => entry.level === 'error') : [],
					}, writeAnnotations));
				}
				const resolvedRunId = await resolveRunIdFromInput(env, job_id, run_id, 'runtime');
				const summary = await fetchRunSummary(env, owner, repo, resolvedRunId);
				const preview = preview_token ? await decodeToken<PreviewTokenPayload>(env, preview_token, 'preview') : null;
				const browser = browser_result_token ? await decodeToken<BrowserResultTokenPayload>(env, browser_result_token, 'browser_result') : null;
				const eventFeed = include_layer_logs && job_id ? await queueJson(env, { action: 'job_event_feed', job_id, limit: 50 }) : null;
				const bundleId = `inc_${(await sha256Hex(JSON.stringify({ repo: repoKey, run_id: resolvedRunId, preview_id: preview?.preview_id ?? null, session_id: browser?.session_id ?? null }))).slice(0, 14)}`;
				await updateJobState(env, {
					jobId: job_id,
					repoKey,
					status: 'working',
					nextActor: 'system',
					workerManifest: { runtime: { status: 'ready', incident_bundle_id: bundleId, updated_at: nowIso() } },
				});
				return toolText(ok({
					bundle_id: bundleId,
					repo: repoKey,
					run_id: resolvedRunId,
					summary: summary.summary,
					artifacts: summary.artifacts,
					preview,
					browser,
					scope,
					layer_logs: include_layer_logs ? (eventFeed?.data?.logs ?? []) : [],
				}, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'incident_bundle_create_failed'), error, writeAnnotations));
			}
		},
	);
}
