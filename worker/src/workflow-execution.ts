import { githubRequestRaw } from './github';
import { decodeUtf8, extractZipEntries } from './gui-capture';
import { AppEnv } from './types';
import { encodeBase64Text, githubGet, githubPost, nowIso } from './utils';

export interface WorkflowDispatchRequest {
	owner: string;
	repo: string;
	workflow_id: string;
	ref: string;
	request: Record<string, unknown>;
	wait_timeout_ms?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dispatchStandardWorkflow(
	env: AppEnv,
	input: WorkflowDispatchRequest,
): Promise<{ run_id: number | null; run_html_url: string | null; status: string; conclusion: string | null; summary: Record<string, unknown> | null; artifacts: Array<Record<string, unknown>> }> {
	const startedAt = nowIso();
	await githubPost(env, `/repos/${input.owner}/${input.repo}/actions/workflows/${input.workflow_id}/dispatches`, {
		ref: input.ref,
		inputs: {
			request_b64: encodeBase64Text(JSON.stringify(input.request)),
			request_kind: String(input.request.kind ?? 'generic'),
		},
	});

	const run = await waitForWorkflowRun(env, {
		owner: input.owner,
		repo: input.repo,
		workflow_id: input.workflow_id,
		ref: input.ref,
		started_at: startedAt,
		timeout_ms: input.wait_timeout_ms ?? 180_000,
	});
	if (!run) {
		return {
			run_id: null,
			run_html_url: null,
			status: 'queued',
			conclusion: null,
			summary: null,
			artifacts: [],
		};
	}
	const artifacts = await listWorkflowArtifacts(env, input.owner, input.repo, run.run_id);
	const summary = await readSummaryArtifact(env, input.owner, input.repo, run.run_id, artifacts);
	return {
		run_id: run.run_id,
		run_html_url: run.run_html_url,
		status: run.status,
		conclusion: run.conclusion,
		summary,
		artifacts,
	};
}

export async function waitForWorkflowRun(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		workflow_id: string;
		ref: string;
		started_at: string;
		timeout_ms: number;
	},
): Promise<{ run_id: number; status: string; conclusion: string | null; run_html_url: string | null } | null> {
	const deadline = Date.now() + input.timeout_ms;
	let runId = 0;
	while (Date.now() < deadline) {
		if (!runId) {
			const runs = (await githubGet(env, `/repos/${input.owner}/${input.repo}/actions/runs`, {
				params: { branch: input.ref, event: 'workflow_dispatch', per_page: 20 },
			})) as { workflow_runs?: Array<Record<string, unknown>> };
			const run = (runs.workflow_runs ?? []).find(
				(item) =>
					String(item.path ?? '').endsWith(`/${input.workflow_id}`) &&
					String(item.created_at ?? '') >= input.started_at,
			);
			if (run) {
				runId = Number(run.id);
			}
		}
		if (runId) {
			const run = (await githubGet(env, `/repos/${input.owner}/${input.repo}/actions/runs/${runId}`)) as Record<string, unknown>;
			const status = String(run.status ?? '');
			if (status === 'completed') {
				return {
					run_id: runId,
					status,
					conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
					run_html_url: typeof run.html_url === 'string' ? run.html_url : null,
				};
			}
		}
		await sleep(3000);
	}
	return null;
}

export async function listWorkflowArtifacts(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
): Promise<Array<Record<string, unknown>>> {
	const result = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`)) as {
		artifacts?: Array<Record<string, unknown>>;
	};
	return (result.artifacts ?? []).map((artifact) => ({
		id: artifact.id ?? null,
		name: artifact.name ?? null,
		size_in_bytes: artifact.size_in_bytes ?? null,
		expired: artifact.expired ?? null,
		archive_download_url: artifact.archive_download_url ?? null,
	}));
}

export async function downloadWorkflowArtifactEntries(
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
	return extractZipEntries(await response.arrayBuffer());
}

export async function readSummaryArtifact(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
	artifacts?: Array<Record<string, unknown>>,
): Promise<Record<string, unknown> | null> {
	const artifactList = artifacts ?? (await listWorkflowArtifacts(env, owner, repo, runId));
	for (const artifact of artifactList) {
		const artifactId = Number(artifact.id);
		if (!artifactId) {
			continue;
		}
		const entries = await downloadWorkflowArtifactEntries(env, owner, repo, artifactId);
		for (const summaryPath of ['summary.json', 'opengpt-summary.json']) {
			if (entries.has(summaryPath)) {
				return JSON.parse(decodeUtf8(entries.get(summaryPath)!)) as Record<string, unknown>;
			}
		}
	}
	return null;
}

export async function downloadWorkflowLogEntries(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
): Promise<Map<string, Uint8Array>> {
	const response = await githubRequestRaw(
		env,
		'GET',
		`/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
		{
			headers: {
				Accept: 'application/vnd.github+json',
			},
		},
	);
	return extractZipEntries(await response.arrayBuffer());
}
