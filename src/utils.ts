import { AppEnv, QueueEnvelope, ToolResultEnvelope } from './types';
import { githubGet as ghGet, githubPost as ghPost, githubPut as ghPut, githubDelete as ghDelete } from './github';

export const githubGet = ghGet;
export const githubPost = ghPost;
export const githubPut = ghPut;
export const githubDelete = ghDelete;
export const encoder = new TextEncoder();
export const QUEUE_FETCH_TIMEOUT_MS = 8_000;

export function nowIso(): string {
	return new Date().toISOString();
}

export function diagnosticLog(event: string, payload: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: nowIso(), event, ...payload }));
}

export function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

export function errorStatus(error: unknown): number {
	const message = error instanceof Error ? error.message : String(error);
	if (
		message.includes('unsafe ') ||
		message.includes('not allowlisted') ||
		message.includes('invalid ') ||
		message.includes('must start with') ||
		message.includes('forbidden') ||
		message.includes('already exists')
	) {
		return 400;
	}
	return 500;
}

export function errorCodeFor(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('Merge conflict')) return 'pr_merge_conflict';
	if (message.includes('Pull Request is not mergeable')) return 'pr_not_mergeable';
	if (message.includes('repository not allowlisted')) return 'repo_not_allowlisted';
	if (message.includes('workflow not allowlisted')) return 'workflow_not_allowlisted';
	if (message.includes('unsafe path')) return 'unsafe_path';
	if (message.includes('direct write to') && message.includes('forbidden')) return 'default_branch_forbidden';
	return fallback;
}

export function toolText(result: ToolResultEnvelope): { content: [{ type: 'text'; text: string }] } {
	return {
		content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
	};
}

export function ok(data: Record<string, unknown> | null, meta?: Record<string, unknown>): ToolResultEnvelope {
	return { ok: true, data, error: null, code: null, meta: meta ?? null };
}

export function fail(code: string, error: unknown, meta?: Record<string, unknown>): ToolResultEnvelope {
	return {
		ok: false,
		data: null,
		error: error instanceof Error ? error.message : String(error),
		code,
		meta: meta ?? null,
	};
}

export function parseCsv(value: string | undefined): string[] {
	return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function getAllowedRepos(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_REPOS);
}

export function repoAllowed(env: AppEnv, repo: string): boolean {
	const allowed = getAllowedRepos(env);
	return allowed.length === 0 || allowed.includes(repo);
}

export function getAllowedWorkflows(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_WORKFLOWS);
}

export function getBranchPrefix(env: AppEnv): string {
	return env.AGENT_BRANCH_PREFIX?.trim() || 'agent/';
}

export function getDefaultBaseBranch(env: AppEnv): string {
	return env.DEFAULT_BASE_BRANCH?.trim() || 'main';
}

export function getDefaultAutoImproveMaxCycles(env: AppEnv): number {
	return parseInt(env.DEFAULT_AUTO_IMPROVE_MAX_CYCLES || '3', 10);
}

export function getSelfRepoKey(env: AppEnv): string {
	return env.SELF_REPO_KEY?.trim() || 'iusung111/opengpt-github-mcp-worker';
}

export function getSelfDeployWorkflow(env: AppEnv): string {
	return env.SELF_DEPLOY_WORKFLOW?.trim() || 'cloudflare-self-deploy.yml';
}

export function getSelfLiveUrl(env: AppEnv): string | null {
	const value = env.SELF_LIVE_URL?.trim();
	return value ? value.replace(/\/$/, '') : null;
}

export function getSelfMirrorUrl(env: AppEnv): string | null {
	const value = env.SELF_MIRROR_URL?.trim();
	if (value) {
		return value.replace(/\/$/, '');
	}
	return getSelfLiveUrl(env);
}

export function getSelfCurrentUrl(env: AppEnv): string | null {
	const value = env.SELF_CURRENT_URL?.trim();
	return value ? value.replace(/\/$/, '') : null;
}

export function getSelfDefaultDeployTarget(env: AppEnv): 'mirror' | 'live' {
	return env.SELF_DEFAULT_DEPLOY_TARGET?.trim() === 'live' ? 'live' : 'mirror';
}

export function selfRequiresMirrorForLive(env: AppEnv): boolean {
	return env.SELF_REQUIRE_MIRROR_FOR_LIVE?.trim() !== 'false';
}

export function ensureRepoAllowed(env: AppEnv, repo: string): void {
	const allowed = getAllowedRepos(env);
	if (allowed.length > 0 && !allowed.includes(repo)) {
		throw new Error(`repository not allowlisted: ${repo}`);
	}
}

export function ensureBranchAllowed(env: AppEnv, branch: string): void {
	if (!branch.startsWith(getBranchPrefix(env))) {
		throw new Error(`branch must start with ${getBranchPrefix(env)}`);
	}
}

export function ensureNotDefaultBranch(env: AppEnv, branch: string): void {
	if (branch === getDefaultBaseBranch(env)) {
		throw new Error(`direct write to ${branch} is forbidden`);
	}
}

export function ensureWorkflowAllowed(env: AppEnv, workflowId: string): void {
	const allowed = getAllowedWorkflows(env);
	if (allowed.length > 0 && !allowed.includes(workflowId)) {
		throw new Error(`workflow not allowlisted: ${workflowId}`);
	}
}

export function validateWorkflowInputs(inputs: Record<string, unknown>): void {
	const allowedKeys = new Set([
		'job_id',
		'operation_type',
		'base_branch',
		'target_paths',
		'instructions_b64',
		'pr_title',
		'pr_body',
		'dry_run',
		'auto_improve',
		'runner_label',
		'deploy_target',
		'reason',
		'expected_commit_sha',
		'verify_mirror_first',
	]);
	for (const key of Object.keys(inputs)) {
		if (!allowedKeys.has(key)) {
			throw new Error(`workflow input not allowed: ${key}`);
		}
	}
}

export function ensureSafePath(path: string): void {
	if (!path || path.startsWith('/') || path.includes('..')) {
		throw new Error(`unsafe path: ${path}`);
	}
}

export function encodeGitHubPath(path: string): string {
	return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function encodeGitHubRef(ref: string): string {
	return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function encodeBase64Text(value: string): string {
	const bytes = encoder.encode(value);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function decodeBase64Text(value: string | undefined | null): string | null {
	if (!value) return null;
	try {
		const binary = atob(value.replace(/\n/g, ''));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function getAuditRetentionCount(env: AppEnv): number {
	return parseInt(env.AUDIT_RETENTION_COUNT || '500', 10);
}

export function getDeliveryRetentionCount(env: AppEnv): number {
	return parseInt(env.DELIVERY_RETENTION_COUNT || '500', 10);
}

export function getWorkingStaleAfterMs(env: AppEnv): number {
	return parseInt(env.WORKING_STALE_AFTER_MS || '600000', 10);
}

export function getReviewStaleAfterMs(env: AppEnv): number {
	return parseInt(env.REVIEW_STALE_AFTER_MS || '1800000', 10);
}

export function getDispatchDedupeWindowMs(env: AppEnv): number {
	return parseInt(env.DISPATCH_DEDUPE_WINDOW_MS || '30000', 10);
}

export function parseIsoMs(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isOlderThan(iso: string | undefined, thresholdMs: number): boolean {
	const parsed = parseIsoMs(iso);
	return parsed !== null && Date.now() - parsed > thresholdMs;
}

export async function buildDispatchFingerprint(
	owner: string,
	repo: string,
	workflowId: string,
	ref: string,
	inputs: Record<string, unknown>,
	autoImproveCycle: number,
): Promise<string> {
	return sha256Hex(
		stableStringify({
			owner,
			repo,
			workflow_id: workflowId,
			ref,
			inputs,
			auto_improve_cycle: autoImproveCycle,
		}),
	);
}

export async function queueFetch(env: AppEnv, payload: QueueEnvelope): Promise<Response> {
	const id = env.JOB_QUEUE.idFromName('global-job-queue');
	const stub = env.JOB_QUEUE.get(id);
	const startedAt = Date.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort('queue_timeout'), QUEUE_FETCH_TIMEOUT_MS);
	try {
		const response = await stub.fetch('https://queue.internal/queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		diagnosticLog('queue_fetch', {
			action: payload.action,
			status: response.status,
			duration_ms: Date.now() - startedAt,
		});
		return response;
	} catch (error) {
		diagnosticLog('queue_fetch_error', {
			action: payload.action,
			duration_ms: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function queueJson(env: AppEnv, payload: QueueEnvelope): Promise<ToolResultEnvelope> {
	const response = await queueFetch(env, payload);
	return (await response.json()) as ToolResultEnvelope;
}

export async function activateRepoWorkspace(env: AppEnv, repoKey: string): Promise<void> {
	try {
		await queueJson(env, { action: 'workspace_activate', repo_key: repoKey });
	} catch (error) {
		diagnosticLog('workspace_activate_error', {
			repo_key: repoKey,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
