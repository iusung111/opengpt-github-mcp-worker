import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { githubRequestRaw } from './github';
import { extractZipEntries, decodeUtf8, encodeBase64, normalizeGuiCaptureInstructions } from './gui-capture';
import { ToolAnnotations } from './mcp/contracts';
import { AppEnv } from './contracts';
import { ensureRepoAllowed, ensureWorkflowAllowed, errorCodeFor, fail, getDefaultBaseBranch, getSelfRepoKey, githubGet, githubPost, ok, toolText, validateWorkflowInputs } from './utils';

export const GUI_CAPTURE_WORKFLOW_ID = 'gui-capture.yml';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GUI_CAPTURE_POLL_INTERVAL_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function waitForRun(
	env: AppEnv,
	owner: string,
	repo: string,
	ref: string,
	startedAt: string,
	timeoutMs: number,
	requestId?: string,
) {
	const deadline = Date.now() + timeoutMs;
	const candidateRunIds = new Set<number>();
	const mismatchedRunIds = new Set<number>();
	while (Date.now() < deadline) {
		const runs = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
			params: { branch: ref, event: 'workflow_dispatch', per_page: 10 },
		})) as { workflow_runs?: Array<Record<string, unknown>> };
		for (const item of runs.workflow_runs ?? []) {
			if (
				String(item.path ?? '').endsWith(`/${GUI_CAPTURE_WORKFLOW_ID}`) &&
				String(item.created_at ?? '') >= startedAt
			) {
				const runId = Number(item.id);
				if (Number.isFinite(runId) && runId > 0 && !mismatchedRunIds.has(runId)) {
					candidateRunIds.add(runId);
				}
			}
		}
		for (const runId of Array.from(candidateRunIds).sort((left, right) => left - right)) {
			const run = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${runId}`)) as Record<string, unknown>;
			if (String(run.status ?? '') === 'completed') {
				let artifact = null;
				if (requestId) {
					try {
						artifact = await readArtifact(env, owner, repo, runId);
						const requestFromSummary =
							typeof artifact.summary.request_id === 'string'
								? artifact.summary.request_id
								: isRecord(artifact.summary.request) && typeof artifact.summary.request.request_id === 'string'
									? artifact.summary.request.request_id
									: '';
						if (requestFromSummary && requestFromSummary !== requestId) {
							mismatchedRunIds.add(runId);
							candidateRunIds.delete(runId);
							continue;
						}
						if (!requestFromSummary && candidateRunIds.size > 1) {
							continue;
						}
					} catch {
						if (candidateRunIds.size > 1) {
							continue;
						}
					}
				}
				return { runId, run, artifact };
			}
		}
		await sleep(GUI_CAPTURE_POLL_INTERVAL_MS);
	}
	throw new Error('timed out waiting for gui capture workflow run');
}

async function readArtifact(env: AppEnv, owner: string, repo: string, runId: number) {
	const list = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`)) as { artifacts?: Array<Record<string, unknown>> };
	const artifact = (list.artifacts ?? []).find((x) => String(x.name ?? '') === `gui-capture-${runId}`);
	if (!artifact) throw new Error(`gui capture artifact not found for run ${runId}`);
	const response = await githubRequestRaw(env, 'GET', `/repos/${owner}/${repo}/actions/artifacts/${Number(artifact.id)}/zip`, { headers: { Accept: 'application/vnd.github+json' } });
	const entries = await extractZipEntries(await response.arrayBuffer());
	const summaryEntry = entries.get('summary.json');
	if (!summaryEntry) throw new Error(`summary.json not found in artifact for run ${runId}`);
	const files = Array.from(entries.keys()).sort();
	const image = entries.get('capture-final.jpg') ?? entries.get('capture.jpg') ?? null;
	return {
		summary: JSON.parse(decodeUtf8(summaryEntry)) as Record<string, unknown>,
		report_file_name: entries.has('report.md') ? 'report.md' : null,
		artifact_files: files,
		step_image_files: files.filter((x) => x.startsWith('screenshots/')),
		image_file_name: image ? (entries.has('capture-final.jpg') ? 'capture-final.jpg' : 'capture.jpg') : null,
		image_base64: image ? encodeBase64(image) : null,
	};
}

export async function runGuiCaptureWorkflow(
	env: AppEnv,
	input: {
		file_name?: string;
		file_text?: string;
		app_url?: string;
		ref?: string;
		analysis?: unknown;
		scenario?: unknown;
		report?: unknown;
		include_image_base64?: boolean;
		wait_timeout_seconds?: number;
	},
): Promise<Record<string, unknown>> {
	const repoKey = getSelfRepoKey(env);
	ensureRepoAllowed(env, repoKey);
	ensureWorkflowAllowed(env, repoKey, GUI_CAPTURE_WORKFLOW_ID);
	const [owner, repo] = repoKey.split('/');
	const instructions = normalizeGuiCaptureInstructions(env, {
		file_name: input.file_name,
		file_text: input.file_text,
		app_url: input.app_url,
		analysis: input.analysis as Parameters<typeof normalizeGuiCaptureInstructions>[1]['analysis'],
		scenario: input.scenario as Parameters<typeof normalizeGuiCaptureInstructions>[1]['scenario'],
		report: input.report as Parameters<typeof normalizeGuiCaptureInstructions>[1]['report'],
	});
	const requestId = crypto.randomUUID();
	const workflowRef = input.ref?.trim() || getDefaultBaseBranch(env);
	const instructionsB64 = encodeBase64(
		new TextEncoder().encode(
			JSON.stringify({
				...instructions,
				request_id: requestId,
			}),
		),
	);
	const inputs: Record<string, unknown> = { request_kind: 'gui_capture', instructions_b64: instructionsB64 };
	validateWorkflowInputs(inputs);
	const startedAt = new Date().toISOString();
	await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${GUI_CAPTURE_WORKFLOW_ID}/dispatches`, {
		ref: workflowRef,
		inputs,
	});
	const { runId, run, artifact } = await waitForRun(
		env,
		owner,
		repo,
		workflowRef,
		startedAt,
		(input.wait_timeout_seconds ?? 120) * 1000,
		requestId,
	);
	const conclusion = String(run.conclusion ?? '');
	const resolvedArtifact = artifact ?? (await readArtifact(env, owner, repo, runId));
	return {
		repo: repoKey,
		workflow_id: GUI_CAPTURE_WORKFLOW_ID,
		ref: workflowRef,
		run_id: runId,
		run_html_url: run.html_url ?? null,
		conclusion,
		mode: instructions.mode,
		summary: resolvedArtifact.summary,
		report_file_name: resolvedArtifact.report_file_name,
		artifact_files: resolvedArtifact.artifact_files,
		step_image_files: resolvedArtifact.step_image_files,
		image_file_name: resolvedArtifact.image_file_name,
		image_base64: input.include_image_base64 ? resolvedArtifact.image_base64 : null,
	};
}

export function registerGuiTools(server: McpServer, env: AppEnv, writeAnnotations: ToolAnnotations): void {
	server.registerTool('gui_capture_run', {
		description: 'Run legacy /gui/ capture or scenario-based HTML/url GUI validation in a remote GitHub Actions browser session.',
		inputSchema: {
			file_name: z.string().optional(),
			file_text: z.string().optional(),
			app_url: z.string().url().optional(),
			ref: z.string().optional(),
			analysis: z.any().optional(),
			scenario: z.any().optional(),
			report: z.any().optional(),
			include_image_base64: z.boolean().default(false),
			wait_timeout_seconds: z.number().int().positive().max(240).default(120),
		},
		annotations: writeAnnotations,
	}, async ({ file_name, file_text, app_url, ref, analysis, scenario, report, include_image_base64, wait_timeout_seconds }) => {
		try {
			const result = await runGuiCaptureWorkflow(env, {
				file_name,
				file_text,
				app_url,
				ref,
				analysis,
				scenario,
				report,
				include_image_base64,
				wait_timeout_seconds,
			});
			if (result.conclusion !== 'success') {
				return toolText(
					fail('gui_capture_run_failed', `workflow run ${result.run_id} concluded with ${result.conclusion}`, {
						run_id: result.run_id,
						run_html_url: result.run_html_url,
						summary: result.summary,
					}),
				);
			}
			return toolText(ok(result, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'gui_capture_run_failed'), error, writeAnnotations));
		}
	});
}


