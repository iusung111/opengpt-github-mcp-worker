import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { githubRequestRaw } from './github';
import { extractZipEntries, decodeUtf8, encodeBase64, normalizeGuiCaptureInstructions } from './gui-capture';
import { ToolAnnotations } from './mcp-overview-tools';
import { AppEnv } from './types';
import { ensureRepoAllowed, ensureWorkflowAllowed, errorCodeFor, fail, getDefaultBaseBranch, getSelfRepoKey, githubGet, githubPost, ok, toolText, validateWorkflowInputs } from './utils';

const GUI_CAPTURE_WORKFLOW_ID = 'gui-capture.yml';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(env: AppEnv, owner: string, repo: string, ref: string, startedAt: string, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	let runId = 0;
	while (Date.now() < deadline) {
		if (!runId) {
			const runs = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs`, { params: { branch: ref, event: 'workflow_dispatch', per_page: 10 } })) as { workflow_runs?: Array<Record<string, unknown>> };
			const run = (runs.workflow_runs ?? []).find((x) => String(x.path ?? '').endsWith(`/${GUI_CAPTURE_WORKFLOW_ID}`) && String(x.created_at ?? '') >= startedAt);
			if (run) runId = Number(run.id);
		}
		if (runId) {
			const run = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${runId}`)) as Record<string, unknown>;
			if (String(run.status ?? '') === 'completed') return { runId, run };
		}
		await sleep(3000);
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
			const repoKey = getSelfRepoKey(env);
			ensureRepoAllowed(env, repoKey);
			ensureWorkflowAllowed(env, repoKey, GUI_CAPTURE_WORKFLOW_ID);
			const [owner, repo] = repoKey.split('/');
			const instructions = normalizeGuiCaptureInstructions(env, { file_name, file_text, app_url, analysis, scenario, report });
			const workflowRef = ref?.trim() || getDefaultBaseBranch(env);
			const inputs: Record<string, unknown> = { request_kind: 'gui_capture', instructions_json: instructions };
			validateWorkflowInputs(inputs);
			const startedAt = new Date().toISOString();
			await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${GUI_CAPTURE_WORKFLOW_ID}/dispatches`, { ref: workflowRef, inputs });
			const { runId, run } = await waitForRun(env, owner, repo, workflowRef, startedAt, wait_timeout_seconds * 1000);
			const conclusion = String(run.conclusion ?? '');
			const artifact = await readArtifact(env, owner, repo, runId);
			if (conclusion !== 'success') {
				return toolText(fail('gui_capture_run_failed', `workflow run ${runId} concluded with ${conclusion}`, { run_id: runId, run_html_url: run.html_url ?? null, summary: artifact.summary }));
			}
			return toolText(ok({
				repo: repoKey,
				workflow_id: GUI_CAPTURE_WORKFLOW_ID,
				ref: workflowRef,
				run_id: runId,
				run_html_url: run.html_url ?? null,
				conclusion,
				mode: instructions.mode,
				summary: artifact.summary,
				report_file_name: artifact.report_file_name,
				artifact_files: artifact.artifact_files,
				step_image_files: artifact.step_image_files,
				image_file_name: artifact.image_file_name,
				image_base64: include_image_base64 ? artifact.image_base64 : null,
			}, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'gui_capture_run_failed'), error, writeAnnotations));
		}
	});
}
