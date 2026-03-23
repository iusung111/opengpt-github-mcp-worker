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

const x = 1;
