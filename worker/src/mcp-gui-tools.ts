import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { githubRequestRaw } from './github';
import { extractZipEntries, decodeUtf8, encodeBase64, normalizeGuiCaptureInstructions } from './gui-capture';
import { ToolAnnotations } from './mcp-overview-tools';
import { AppEnv } from './types';
import {
	diagnosticLog,
	ensureRepoAllowed,
	ensureWorkflowAllowed,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	getSelfRepoKey,
	githubGet,
	githubPost,
	ok,
	toolText,
	validateWorkflowInputs,
} from './utils';

const GUI_CAPTURE_WORKFLOW_ID = 'gui-capture.yml';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function locateDispatchedRun(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
	startedAtIso: string,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const runsResponse = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
			params: {
				branch,
				event: 'workflow_dispatch',
				per_page: 10,
			},
		})) as { workflow_runs?: Array<Record<string, unknown>> };
		const run = (runsResponse.workflow_runs ?? []).find((candidate) => {
			const path = String(candidate.path ?? '');
			const createdAt = String(candidate.created_at ?? '');
			return path.endsWith(`/${GUI_CAPTURE_WORKFLOW_ID}`) && createdAt >= startedAtIso;
		});
		if (run) {
			return run;
		}
		await sleep(3000);
	}
	throw new Error('timed out waiting for gui capture workflow run to appear');
}

async function waitForRunCompletion(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${runId}`)) as Record<string, unknown>;
		if (String(run.status ?? '') === 'completed') {
			return run;
		}
		await sleep(4000);
	}
	throw new Error(`timed out waiting for workflow run ${runId} to complete`);
}

async function downloadArtifactEntries(
	env: AppEnv,
	owner: string,
	repo: string,
	artifactId: number,
): Promise<Map<string, Uint8Array>> {
	const response = await githubRequestRaw(
		env,
		'GET',
		`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`,
		{
			headers: {
				Accept: 'application/vnd.github+json',
			},
		},
	);
	const bytes = await response.arrayBuffer();
	return extractZipEntries(bytes);
}

export function registerGuiTools(server: McpServer, env: AppEnv, writeAnnotations: ToolAnnotations): void {
	server.registerTool(
		'gui_capture_run',
		{
			description:
				'Run the deployed /gui/ app in a remote GitHub Actions browser session, upload inline dataset text, and return the analysis summary plus optional image bytes.',
			inputSchema: {
				file_name: z.string(),
				file_text: z.string(),
				app_url: z.string().url().optional(),
				ref: z.string().optional(),
				analysis: z
					.object({
						target_column: z.string().optional(),
						aggregate: z.enum(['count', 'sum', 'average']).optional(),
						sort: z.enum(['value_desc', 'value_asc', 'label_asc', 'label_desc']).optional(),
						missing: z.enum(['exclude', 'bucket']).optional(),
						chart_type: z.enum(['auto', 'bar', 'histogram']).optional(),
						filter_text: z.string().optional(),
					})
					.optional(),
				include_image_base64: z.boolean().default(false),
				wait_timeout_seconds: z.number().int().positive().max(240).default(120),
			},
			annotations: writeAnnotations,
		},
		async ({ file_name, file_text, app_url, ref, analysis, include_image_base64, wait_timeout_seconds }) => {
			const startedAtIso = new Date().toISOString();
			try {
				const repoKey = getSelfRepoKey(env);
				ensureRepoAllowed(env, repoKey);
				ensureWorkflowAllowed(env, repoKey, GUI_CAPTURE_WORKFLOW_ID);
				const [owner, repo] = repoKey.split('/');
				const instructions = normalizeGuiCaptureInstructions(env, {
					file_name,
					file_text,
					app_url,
					analysis,
				});
				const workflowRef = ref?.trim() || getDefaultBaseBranch(env);
				const inputs: Record<string, unknown> = {
					request_kind: 'gui_capture',
					instructions_json: instructions,
				};
				validateWorkflowInputs(inputs);

				await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${GUI_CAPTURE_WORKFLOW_ID}/dispatches`, {
					ref: workflowRef,
					inputs,
				});

				const run = await locateDispatchedRun(env, owner, repo, workflowRef, startedAtIso, wait_timeout_seconds * 1000);
				const runId = Number(run.id);
				const completedRun = await waitForRunCompletion(env, owner, repo, runId, wait_timeout_seconds * 1000);
				const conclusion = String(completedRun.conclusion ?? '');

				const artifactsResponse = (await githubGet(
					env,
					`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
				)) as {
					total_count?: number;
					artifacts?: Array<Record<string, unknown>>;
				};
				const artifact = (artifactsResponse.artifacts ?? []).find(
					(item) => String(item.name ?? '') === `gui-capture-${runId}`,
				);
				if (!artifact) {
					throw new Error(`gui capture artifact not found for run ${runId}`);
				}
				const entries = await downloadArtifactEntries(env, owner, repo, Number(artifact.id));
				const summaryEntry = entries.get('summary.json');
				if (!summaryEntry) {
					throw new Error(`summary.json not found in artifact for run ${runId}`);
				}
				const summary = JSON.parse(decodeUtf8(summaryEntry)) as Record<string, unknown>;
				const imageEntry = entries.get('capture.jpg');

				diagnosticLog('gui_capture_run_complete', {
					run_id: runId,
					conclusion,
					include_image_base64,
				});

				if (conclusion !== 'success') {
					return toolText(
						fail('gui_capture_run_failed', `workflow run ${runId} concluded with ${conclusion}`, {
							run_id: runId,
							run_html_url: completedRun.html_url ?? null,
							summary,
						}),
					);
				}

				return toolText(
					ok(
						{
							repo: repoKey,
							workflow_id: GUI_CAPTURE_WORKFLOW_ID,
							ref: workflowRef,
							run_id: runId,
							run_html_url: completedRun.html_url ?? null,
							conclusion,
							summary,
							image_file_name: imageEntry ? 'capture.jpg' : null,
							image_base64: include_image_base64 && imageEntry ? encodeBase64(imageEntry) : null,
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'gui_capture_run_failed'), error, writeAnnotations));
			}
		},
	);
}
