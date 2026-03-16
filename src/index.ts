import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { githubAuthConfigured, githubDelete, githubGet, githubPost, githubPut } from './github';

type JobStatus = 'queued' | 'working' | 'review_pending' | 'rework_pending' | 'done' | 'failed';
type NextActor = 'worker' | 'reviewer' | 'system';
type ReviewVerdict = 'approved' | 'changes_requested' | 'blocked';

type AppEnv = Env & {
	WEBHOOK_SECRET?: string;
	GITHUB_APP_PRIVATE_KEY_PEM?: string;
	GITHUB_ALLOWED_REPOS?: string;
	GITHUB_ALLOWED_WORKFLOWS?: string;
	AGENT_BRANCH_PREFIX?: string;
	DEFAULT_BASE_BRANCH?: string;
	DEFAULT_AUTO_IMPROVE_MAX_CYCLES?: string;
	REQUIRE_WEBHOOK_SECRET?: string;
	GITHUB_API_URL?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	WORKING_STALE_AFTER_MS?: string;
	REVIEW_STALE_AFTER_MS?: string;
	DISPATCH_DEDUPE_WINDOW_MS?: string;
	AUDIT_RETENTION_COUNT?: string;
	DELIVERY_RETENTION_COUNT?: string;
};

interface ReviewFinding {
	severity: 'low' | 'medium' | 'high' | 'critical';
	file: string;
	line_hint?: string;
	rationale: string;
}

interface WorkspaceRecord {
	repo_key: string;
	workspace_path: string;
	repo_slug: string;
	display_name: string;
	aliases: string[];
	created_at: string;
	updated_at: string;
}

interface DispatchRequestRecord {
	owner: string;
	repo: string;
	workflow_id: string;
	ref: string;
	inputs: Record<string, unknown>;
	fingerprint?: string;
	dispatched_at: string;
}

interface JobRecord {
	job_id: string;
	repo: string;
	base_branch: string;
	work_branch?: string;
	pr_number?: number;
	workflow_run_id?: number;
	operation_type?: string;
	target_paths: string[];
	status: JobStatus;
	next_actor: NextActor;
	auto_improve_enabled: boolean;
	auto_improve_max_cycles: number;
	auto_improve_cycle: number;
	worker_manifest: Record<string, unknown>;
	review_verdict?: ReviewVerdict;
	review_findings: ReviewFinding[];
	last_error?: string;
	stale_reason?: string;
	notes: string[];
	created_at: string;
	last_transition_at: string;
	last_reconciled_at?: string;
	last_webhook_event_at?: string;
	updated_at: string;
}

interface ToolResultEnvelope {
	ok: boolean;
	data?: Record<string, unknown> | null;
	error?: string | null;
	code?: string | null;
	meta?: Record<string, unknown> | null;
}

interface QueueEnvelope {
	action:
		| 'job_create'
		| 'job_upsert'
		| 'job_get'
		| 'job_progress'
		| 'jobs_list'
		| 'audit_list'
		| 'job_update_status'
		| 'job_append_note'
		| 'job_submit_review'
		| 'workspace_register'
		| 'workspace_get'
		| 'workspace_find_similar'
		| 'workspace_list'
		| 'github_event';
	job?: Partial<JobRecord> & { job_id?: string };
	job_id?: string;
	status?: JobStatus;
	next_actor?: NextActor;
	note?: string;
	review_verdict?: ReviewVerdict;
	findings?: ReviewFinding[];
	next_action?: string;
	event?: string;
	payload?: Record<string, unknown>;
	workspace?: Partial<WorkspaceRecord> & { repo_key?: string };
	repo_key?: string;
	query?: string;
	delivery_id?: string;
	event_type?: string;
	limit?: number;
}

interface AuditRecord {
	event_type: string;
	payload: Record<string, unknown>;
	created_at: string;
}

interface DeliveryRecord {
	delivery_id: string;
	created_at: string;
}

interface JobProgressSnapshot {
	job_id: string;
	repo: string;
	status: JobStatus;
	next_actor: NextActor;
	work_branch: string | null;
	pr_number: number | null;
	workflow_run_id: number | null;
	stale_reason: string | null;
	latest_note: string | null;
	recent_notes: string[];
	recent_audits: AuditRecord[];
	last_transition_at: string;
	last_reconciled_at: string | null;
	last_webhook_event_at: string | null;
	updated_at: string;
}

const encoder = new TextEncoder();
const QUEUE_FETCH_TIMEOUT_MS = 8_000;

function nowIso(): string {
	return new Date().toISOString();
}

function diagnosticLog(event: string, payload: Record<string, unknown>): void {
	console.log(
		JSON.stringify({
			ts: nowIso(),
			event,
			...payload,
		}),
	);
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

function errorStatus(error: unknown): number {
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

function errorCodeFor(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('workflow not allowlisted')) {
		return 'workflow_not_allowlisted';
	}
	if (message.includes('GitHub App credentials are not fully configured')) {
		return 'github_auth_not_configured';
	}
	if (message.includes('branch must start with')) {
		return 'invalid_branch';
	}
	if (message.includes('unsafe path:')) {
		return 'unsafe_path';
	}
	if (message.includes('unsafe workspace path:')) {
		return 'unsafe_workspace_path';
	}
	if (message.includes('repository not allowlisted')) {
		return 'repo_not_allowlisted';
	}
	if (message.includes('branch has open pull request')) {
		return 'branch_has_open_pr';
	}
	if (message.includes('branch has active queue job')) {
		return 'branch_has_active_job';
	}
	if (message.includes('direct write to') && message.includes('forbidden')) {
		return 'default_branch_forbidden';
	}
	return fallback;
}

function toolText(result: ToolResultEnvelope): { content: [{ type: 'text'; text: string }] } {
	return {
		content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
	};
}

function ok(
	data: Record<string, unknown> | null,
	meta?: Record<string, unknown>,
): ToolResultEnvelope {
	return { ok: true, data, error: null, code: null, meta: meta ?? null };
}

function fail(code: string, error: unknown, meta?: Record<string, unknown>): ToolResultEnvelope {
	return {
		ok: false,
		data: null,
		error: error instanceof Error ? error.message : String(error),
		code,
		meta: meta ?? null,
	};
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function getAllowedRepos(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_REPOS);
}

function getAllowedWorkflows(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_WORKFLOWS);
}

function getBranchPrefix(env: AppEnv): string {
	return env.AGENT_BRANCH_PREFIX?.trim() || 'agent/';
}

function getDefaultBaseBranch(env: AppEnv): string {
	return env.DEFAULT_BASE_BRANCH?.trim() || 'main';
}

function getDefaultAutoImproveMaxCycles(env: AppEnv): number {
	const parsed = Number.parseInt(env.DEFAULT_AUTO_IMPROVE_MAX_CYCLES ?? '1', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function parseDurationMs(value: string | undefined, fallbackMs: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function getWorkingStaleAfterMs(env: AppEnv): number {
	return parseDurationMs(env.WORKING_STALE_AFTER_MS, 10 * 60 * 1000);
}

function getReviewStaleAfterMs(env: AppEnv): number {
	return parseDurationMs(env.REVIEW_STALE_AFTER_MS, 30 * 60 * 1000);
}

function getDispatchDedupeWindowMs(env: AppEnv): number {
	return parseDurationMs(env.DISPATCH_DEDUPE_WINDOW_MS, 30 * 1000);
}

function getAuditRetentionCount(env: AppEnv): number {
	return parseDurationMs(env.AUDIT_RETENTION_COUNT, 500);
}

function getDeliveryRetentionCount(env: AppEnv): number {
	return parseDurationMs(env.DELIVERY_RETENTION_COUNT, 500);
}

function repoAllowed(env: AppEnv, repo: string): boolean {
	const allowed = getAllowedRepos(env);
	return allowed.length === 0 || allowed.includes(repo);
}

function ensureRepoAllowed(env: AppEnv, repo: string): void {
	if (!repoAllowed(env, repo)) {
		throw new Error(`repository not allowlisted: ${repo}`);
	}
}

function ensureSafePath(path: string): void {
	if (!path || path.startsWith('/') || path.includes('..')) {
		throw new Error(`unsafe path: ${path}`);
	}
}

function ensureAbsoluteWorkspacePath(path: string): void {
	if (!path || !path.startsWith('/') || path.includes('..')) {
		throw new Error(`unsafe workspace path: ${path}`);
	}
}

function ensureBranchAllowed(env: AppEnv, branch: string): void {
	if (!branch.startsWith(getBranchPrefix(env))) {
		throw new Error(`branch must start with ${getBranchPrefix(env)}`);
	}
}

function ensureNotDefaultBranch(env: AppEnv, branch: string): void {
	if (branch === getDefaultBaseBranch(env)) {
		throw new Error(`direct write to ${branch} is forbidden`);
	}
}

function ensureWorkflowAllowed(env: AppEnv, workflowId: string): void {
	const allowed = getAllowedWorkflows(env);
	if (allowed.length > 0 && !allowed.includes(workflowId)) {
		throw new Error(`workflow not allowlisted: ${workflowId}`);
	}
}

function encodeGitHubPath(path: string): string {
	return path
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/');
}

function encodeGitHubRef(ref: string): string {
	return ref
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/');
}

function decodeBase64Text(value: string): string | null {
	try {
		const binary = atob(value.replace(/\n/g, ''));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

function validateWorkflowInputs(inputs: Record<string, unknown>): void {
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
	]);
	for (const key of Object.keys(inputs)) {
		if (!allowedKeys.has(key)) {
			throw new Error(`workflow input not allowed: ${key}`);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLatestWorkflowRunId(
	env: AppEnv,
	owner: string,
	repo: string,
	workflowId: string,
	ref: string,
	dispatchedAtIso: string,
	maxAttempts = 5,
	delayMs = 1000,
): Promise<
	| {
			id: number;
			created_at?: string;
			head_branch?: string;
			name?: string;
			status?: string;
			conclusion?: string;
			html_url?: string;
	  }
	| undefined
> {
	const dispatchedAt = Date.parse(dispatchedAtIso);
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const data = (await githubGet(
			env,
			`/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`,
			{ params: { branch: ref, event: 'workflow_dispatch', per_page: 10 } },
		)) as {
			workflow_runs?: Array<{
				id?: number;
				created_at?: string;
				head_branch?: string;
				name?: string;
				status?: string;
				conclusion?: string;
				html_url?: string;
			}>;
		};
		const run = (data.workflow_runs ?? []).find((item) => {
			if (!item.id || !item.created_at) {
				return false;
			}
			return Date.parse(item.created_at) >= dispatchedAt - 15_000;
		});
		if (run?.id) {
			return {
				id: run.id,
				created_at: run.created_at,
				head_branch: run.head_branch,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
			};
		}
		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}
	return undefined;
}

function jobStorageKey(jobId: string): string {
	return `job:${jobId}`;
}

function auditStorageKey(id: string): string {
	return `audit:${id}`;
}

function deliveryStorageKey(deliveryId: string): string {
	return `delivery:${deliveryId}`;
}

function workspaceStorageKey(repoKey: string): string {
	return `workspace:${repoKey.toLowerCase()}`;
}

function parseIsoMs(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function isOlderThan(value: string | undefined, thresholdMs: number): boolean {
	const parsed = parseIsoMs(value);
	return parsed !== null && Date.now() - parsed >= thresholdMs;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function stableStringify(value: unknown): string {
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

function normalizeHelpQuery(query: string | undefined): string {
	return (query ?? '').trim().toLowerCase();
}

function buildHelpPayload(query: string | undefined): Record<string, unknown> {
	const normalized = normalizeHelpQuery(query);
	const templates = {
		real_change: {
			label: 'Real change with PR',
			prompt: [
				'iusung111/OpenGPT에서 다음 변경 진행:',
				'- job_id: change-001',
				'- 목표: <구체적인 수정 내용>',
				'- 변경 파일: <path들>',
				'- dry_run: false',
				'- 완료 기준: 가능한 범위의 검증 후 PR 생성',
			].join('\n'),
		},
		main_ready: {
			label: 'Main-ready change',
			prompt: [
				'iusung111/OpenGPT에서 다음 변경을 진행하고 main 반영 기준으로 마무리해줘:',
				'- job_id: main-ready-001',
				'- 목표: <구체적인 수정 내용>',
				'- 변경 파일: <path들>',
				'- dry_run: false',
				'- 완료 기준: 검증 완료, branch push, PR 생성, 그리고 main 반영에 필요한 마지막 액션 정리까지',
			].join('\n'),
		},
		dry_run: {
			label: 'Dry run only',
			prompt: [
				'iusung111/OpenGPT에서 다음 작업을 dry-run으로 검증해줘:',
				'- job_id: dryrun-001',
				'- 목표: <무엇을 바꿀지>',
				'- 변경 파일: <path들>',
				'- dry_run: true',
				'- 완료 기준: workflow success와 queue 상태 전이 확인',
			].join('\n'),
		},
		review: {
			label: 'Review follow-up',
			prompt: [
				'iusung111/OpenGPT에서 job_id <값>의 현재 상태를 확인하고,',
				'PR / workflow / queue 기준으로 다음 액션을 정리해줘.',
			].join('\n'),
		},
		branch_cleanup: {
			label: 'Branch cleanup',
			prompt: 'iusung111/OpenGPT에서 정리 가능한 agent 브랜치를 확인하고, 있으면 cleanup 흐름으로 정리해줘.',
		},
	};
	const workflows = [
		{
			id: 'real_change',
			label: '코드 수정과 PR 생성',
			when_to_use: '실제 파일 변경과 PR 생성까지 원할 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=false + 완료 기준',
			recommended_template: templates.real_change,
		},
		{
			id: 'main_ready',
			label: 'main 반영 직전까지 준비',
			when_to_use: 'main 기준으로 마무리하고 싶지만 merge 자체는 별도일 수 있을 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=false + main 반영 기준 완료 기준',
			recommended_template: templates.main_ready,
		},
		{
			id: 'dry_run',
			label: 'dry-run 검증',
			when_to_use: '위험하거나 모호한 변경을 먼저 검증하고 싶을 때',
			request_pattern: 'repo + 목표 + 변경 파일 + dry_run=true',
			recommended_template: templates.dry_run,
		},
		{
			id: 'review_followup',
			label: '리뷰 후속 액션 정리',
			when_to_use: '이미 있는 job, PR, workflow 상태를 기준으로 다음 액션이 필요할 때',
			request_pattern: 'job_id 또는 repo 문맥 + 상태 확인 요청',
			recommended_template: templates.review,
		},
		{
			id: 'branch_cleanup',
			label: 'agent 브랜치 정리',
			when_to_use: '열린 PR과 active job이 없는 agent 브랜치를 정리할 때',
			request_pattern: 'repo + 브랜치 정리 요청',
			recommended_template: templates.branch_cleanup,
		},
	];

	const commonFields = [
		{ field: 'job_id', required: false, guidance: '없으면 자동 생성 가능하지만, 이어서 추적하려면 넣는 편이 좋습니다.' },
		{ field: '목표', required: true, guidance: '바꾸고 싶은 동작이나 결과를 짧게 적습니다.' },
		{ field: '변경 파일', required: false, guidance: '예상 파일을 적으면 범위를 좁히기 쉽습니다.' },
		{ field: 'dry_run', required: false, guidance: 'true면 검증만, false면 실제 변경과 PR 준비 흐름입니다.' },
		{ field: '완료 기준', required: false, guidance: 'PR 생성, workflow 성공, main 반영 직전까지 등 종료 조건을 적습니다.' },
	];

	const basePayload = {
		summary: 'GitHub repo 작업, dry-run 검증, PR 준비, branch cleanup, 진행 상태 확인을 도와줄 수 있습니다.',
		intent: normalized || 'general',
		how_to_ask: {
			required_minimum: ['repo', '목표'],
			recommended_fields: commonFields,
			notes: [
				'실제 변경이면 dry_run=false가 자연스럽습니다.',
				'main 반영 요청은 merge-ready 상태까지 준비하는 의미로 해석합니다.',
			],
		},
		progress_tracking: {
			read_tools: ['repo_work_context', 'job_progress', 'audit_list'],
			write_tools: ['job_append_note'],
			pattern: '긴 읽기나 조사 중에는 짧은 메모를 남기고 progress 스냅샷을 다시 읽습니다.',
		},
		workflows,
		next_actions: [
			'원하는 repo와 목표를 말해주면 바로 적절한 workflow로 이어갈 수 있습니다.',
			'모호하면 먼저 dry-run으로 검증해볼 수 있습니다.',
		],
	};

	if (!normalized) {
		return {
			...basePayload,
			recommended_workflow: 'real_change',
			examples: [templates.real_change, templates.main_ready, templates.dry_run, templates.branch_cleanup],
		};
	}

	if (normalized.includes('main')) {
		return {
			...basePayload,
			summary: 'main 반영 요청은 실제 변경으로 해석하고, 검증과 PR 준비까지 마무리한 뒤 남은 merge 액션을 알려줍니다.',
			recommended_workflow: 'main_ready',
			recommended_template: templates.main_ready,
			next_actions: [
				'dry_run=false로 요청하면 가장 자연스럽습니다.',
				'merge 자체가 수행되지 않았으면 main이 이미 바뀌었다고 말하지 않습니다.',
			],
		};
	}

	if (normalized.includes('dry') || normalized.includes('검증')) {
		return {
			...basePayload,
			summary: '위험하거나 모호한 작업은 dry-run 검증으로 먼저 확인할 수 있습니다.',
			recommended_workflow: 'dry_run',
			recommended_template: templates.dry_run,
		};
	}

	if (normalized.includes('리뷰') || normalized.includes('review')) {
		return {
			...basePayload,
			summary: '기존 job, PR, workflow를 기준으로 리뷰 후속 액션을 정리할 수 있습니다.',
			recommended_workflow: 'review_followup',
			recommended_template: templates.review,
		};
	}

	if (normalized.includes('브랜치') || normalized.includes('cleanup') || normalized.includes('삭제')) {
		return {
			...basePayload,
			summary: '브랜치 삭제는 workflow 편집이 아니라 branch cleanup 흐름으로 처리합니다.',
			recommended_workflow: 'branch_cleanup',
			recommended_template: templates.branch_cleanup,
			recommended_tools: ['branch_cleanup_candidates', 'branch_cleanup_execute'],
		};
	}

	if (normalized.includes('진행') || normalized.includes('상태') || normalized.includes('progress')) {
		return {
			...basePayload,
			summary: '작업 도중 진행 상태는 짧은 메모와 progress 스냅샷으로 확인할 수 있습니다.',
			recommended_tools: ['job_append_note', 'job_progress', 'audit_list'],
			recommended_workflow: 'progress_tracking',
			next_actions: [
				'이미 job_id가 있으면 job_progress로 바로 현재 상태를 읽을 수 있습니다.',
				'중간 메모가 필요하면 job_append_note를 함께 사용합니다.',
			],
		};
	}

	return {
		...basePayload,
		summary: '원하는 작업 내용을 repo, 목표, 변경 파일, dry_run 여부, 완료 기준과 함께 말하면 가장 안정적으로 진행할 수 있습니다.',
		recommended_workflow: 'real_change',
		recommended_template: templates.real_change,
		related_workflows: ['main_ready', 'dry_run', 'review_followup'],
	};
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

function normalizeLookup(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

async function sha256HmacHex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function verifyWebhookSignature(secret: string, payload: string, signatureHeader: string | null): Promise<boolean> {
	if (!secret) {
		return true;
	}
	if (!signatureHeader?.startsWith('sha256=')) {
		return false;
	}
	const expected = `sha256=${await sha256HmacHex(secret, payload)}`;
	return expected === signatureHeader;
}

export class JobQueueDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	private async enforceAuditRetention(): Promise<void> {
		const limit = getAuditRetentionCount(this.env);
		const records = await this.ctx.storage.list({ prefix: 'audit:' });
		const overflow = records.size - limit;
		if (overflow <= 0) {
			return;
		}
		const keysToDelete: string[] = [];
		let index = 0;
		for (const key of records.keys()) {
			if (index >= overflow) {
				break;
			}
			keysToDelete.push(key);
			index += 1;
		}
		if (keysToDelete.length > 0) {
			await this.ctx.storage.delete(keysToDelete);
		}
	}

	private async enforceDeliveryRetention(): Promise<void> {
		const limit = getDeliveryRetentionCount(this.env);
		const records = await this.ctx.storage.list<DeliveryRecord>({ prefix: 'delivery:' });
		const deliveries = Array.from(records.entries())
			.map(([key, record]) => ({ key, created_at: record.created_at }))
			.sort((left, right) => left.created_at.localeCompare(right.created_at));
		const overflow = deliveries.length - limit;
		if (overflow <= 0) {
			return;
		}
		await this.ctx.storage.delete(deliveries.slice(0, overflow).map((item) => item.key));
	}

	private async writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
		await this.ctx.storage.put(auditStorageKey(`${Date.now()}-${crypto.randomUUID()}`), {
			event_type: eventType,
			payload,
			created_at: nowIso(),
		});
		await this.enforceAuditRetention();
	}

	private async getJob(jobId: string): Promise<JobRecord | null> {
		return ((await this.ctx.storage.get(jobStorageKey(jobId))) as JobRecord | undefined) ?? null;
	}

	private async getWorkspace(repoKey: string): Promise<WorkspaceRecord | null> {
		return ((await this.ctx.storage.get(workspaceStorageKey(repoKey))) as WorkspaceRecord | undefined) ?? null;
	}

	private async listAuditRecords(eventType?: string, jobId?: string, limit = 20): Promise<AuditRecord[]> {
		const audits: AuditRecord[] = [];
		const records = await this.ctx.storage.list<AuditRecord>({ prefix: 'audit:' });
		for (const [, record] of records) {
			if (eventType && record.event_type !== eventType) {
				continue;
			}
			if (jobId && record.payload.job_id !== jobId) {
				continue;
			}
			audits.push(record);
		}
		return audits.reverse().slice(0, Math.max(1, Math.min(limit, 100)));
	}

	private buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot {
		return {
			job_id: job.job_id,
			repo: job.repo,
			status: job.status,
			next_actor: job.next_actor,
			work_branch: job.work_branch ?? null,
			pr_number: job.pr_number ?? null,
			workflow_run_id: job.workflow_run_id ?? null,
			stale_reason: job.stale_reason ?? null,
			latest_note: job.notes.at(-1) ?? null,
			recent_notes: job.notes.slice(-5),
			recent_audits: recentAudits,
			last_transition_at: job.last_transition_at,
			last_reconciled_at: job.last_reconciled_at ?? null,
			last_webhook_event_at: job.last_webhook_event_at ?? null,
			updated_at: job.updated_at,
		};
	}

	private async findJob(
		matcher: (job: JobRecord) => boolean,
		options: { reconcile?: boolean } = {},
	): Promise<JobRecord | null> {
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		for (const [, value] of records) {
			if (!matcher(value)) {
				continue;
			}
			return options.reconcile === false ? value : this.reconcileJob(value);
		}
		return null;
	}

	private transitionJob(job: JobRecord, status: JobStatus, nextActor: NextActor): void {
		if (job.status !== status || job.next_actor !== nextActor) {
			job.status = status;
			job.next_actor = nextActor;
			job.last_transition_at = nowIso();
		} else {
			job.status = status;
			job.next_actor = nextActor;
		}
	}

	private pushJobNote(job: JobRecord, note: string): void {
		if (!job.notes.includes(note)) {
			job.notes.push(note);
		}
	}

	private async markJobStale(job: JobRecord, reason: string, note: string): Promise<boolean> {
		if (job.stale_reason === reason) {
			return false;
		}
		job.stale_reason = reason;
		this.pushJobNote(job, note);
		job.updated_at = nowIso();
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_reconcile_stale', this.buildJobAudit(job, { reason }));
		return true;
	}

	private buildJobAudit(job: JobRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			job_id: job.job_id,
			repo: job.repo,
			status: job.status,
			next_actor: job.next_actor,
			work_branch: job.work_branch ?? null,
			workflow_run_id: job.workflow_run_id ?? null,
			auto_improve_cycle: job.auto_improve_cycle,
			stale_reason: job.stale_reason ?? null,
			...extra,
		};
	}

	private async tryRegisterDelivery(deliveryId?: string): Promise<boolean> {
		if (!deliveryId) {
			return true;
		}
		const key = deliveryStorageKey(deliveryId);
		const existing = await this.ctx.storage.get<DeliveryRecord>(key);
		if (existing) {
			return false;
		}
		await this.ctx.storage.put(key, { delivery_id: deliveryId, created_at: nowIso() });
		await this.enforceDeliveryRetention();
		return true;
	}

	private getDispatchRequest(job: JobRecord): DispatchRequestRecord | null {
		const raw = (job.worker_manifest.dispatch_request ?? null) as Partial<DispatchRequestRecord> | null;
		if (!raw?.owner || !raw.repo || !raw.workflow_id || !raw.ref || !raw.dispatched_at) {
			return null;
		}
		return {
			owner: raw.owner,
			repo: raw.repo,
			workflow_id: raw.workflow_id,
			ref: raw.ref,
			inputs: raw.inputs ?? {},
			fingerprint: raw.fingerprint,
			dispatched_at: raw.dispatched_at,
		};
	}

	private async shouldDeduplicateDispatch(
		job: JobRecord,
		owner: string,
		repo: string,
		workflowId: string,
		ref: string,
		inputs: Record<string, unknown>,
	): Promise<boolean> {
		if (job.status !== 'working') {
			return false;
		}
		const dispatchRequest = this.getDispatchRequest(job);
		if (!dispatchRequest || !dispatchRequest.fingerprint) {
			return false;
		}
		const workflow = (job.worker_manifest.last_workflow_run ?? null) as
			| {
					status?: string;
			  }
			| null;
		if (workflow?.status === 'completed') {
			return false;
		}
		if (parseIsoMs(dispatchRequest.dispatched_at) === null) {
			return false;
		}
		if (isOlderThan(dispatchRequest.dispatched_at, getDispatchDedupeWindowMs(this.env))) {
			return false;
		}
		const requestedFingerprint = await buildDispatchFingerprint(
			owner,
			repo,
			workflowId,
			ref,
			inputs,
			job.auto_improve_cycle,
		);
		return dispatchRequest.fingerprint === requestedFingerprint;
	}

	private async autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean> {
		const dispatchRequest = this.getDispatchRequest(job);
		if (!dispatchRequest || !githubAuthConfigured(this.env)) {
			return false;
		}
		const fingerprint = await buildDispatchFingerprint(
			dispatchRequest.owner,
			dispatchRequest.repo,
			dispatchRequest.workflow_id,
			dispatchRequest.ref,
			dispatchRequest.inputs,
			job.auto_improve_cycle,
		);
		await githubPost(
			this.env,
			`/repos/${dispatchRequest.owner}/${dispatchRequest.repo}/actions/workflows/${dispatchRequest.workflow_id}/dispatches`,
			{
				ref: dispatchRequest.ref,
				inputs: dispatchRequest.inputs,
			},
		);
		this.transitionJob(job, 'working', 'system');
		job.workflow_run_id = undefined;
		job.last_error = undefined;
		job.stale_reason = undefined;
		this.pushJobNote(job, `auto redispatch triggered: ${reason}`);
		job.worker_manifest = {
			...job.worker_manifest,
			dispatch_request: {
				...dispatchRequest,
				fingerprint,
				dispatched_at: nowIso(),
			},
			last_workflow_run: {
				status: 'queued',
				conclusion: null,
				html_url: null,
			},
		};
		return true;
	}

	private async reconcileJob(job: JobRecord): Promise<JobRecord> {
		job.last_reconciled_at = nowIso();
		if (job.status === 'working' && !job.workflow_run_id && isOlderThan(job.updated_at, getWorkingStaleAfterMs(this.env))) {
			const staleChanged = job.stale_reason !== 'working_timeout';
			job.stale_reason = 'working_timeout';
			if (githubAuthConfigured(this.env) && repoAllowed(this.env, job.repo)) {
				const dispatchRequest = this.getDispatchRequest(job);
				if (dispatchRequest && job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
					job.auto_improve_cycle += 1;
					const redispatched = await this.autoRedispatchJob(job, 'working job stale without workflow run');
					if (!redispatched) {
						this.transitionJob(job, 'rework_pending', 'worker');
					}
				} else {
					this.transitionJob(job, 'rework_pending', 'worker');
				}
			} else {
				this.transitionJob(job, 'rework_pending', 'worker');
			}
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
			if (staleChanged) {
				await this.markJobStale(
					job,
					'working_timeout',
					'working job exceeded stale threshold without a linked workflow run',
				);
			}
			return job;
		}
		if (!githubAuthConfigured(this.env) || !repoAllowed(this.env, job.repo)) {
			if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		if (job.status !== 'working' && job.status !== 'review_pending') {
			return job;
		}
		const dispatchRequest = (job.worker_manifest.dispatch_request ?? null) as
			| {
					owner?: string;
					repo?: string;
					workflow_id?: string;
					ref?: string;
					dispatched_at?: string;
			  }
			| null;
		if (!job.workflow_run_id && dispatchRequest?.owner && dispatchRequest?.repo && dispatchRequest.workflow_id && dispatchRequest.ref && dispatchRequest.dispatched_at) {
			try {
				const discoveredRun = await findLatestWorkflowRunId(
					this.env,
					dispatchRequest.owner,
					dispatchRequest.repo,
					dispatchRequest.workflow_id,
					dispatchRequest.ref,
					dispatchRequest.dispatched_at,
					1,
					0,
				);
				if (discoveredRun?.id) {
					job.workflow_run_id = discoveredRun.id;
				}
			} catch {
				return job;
			}
		}
		if (!job.workflow_run_id) {
			if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
				await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		let run:
			| {
					name?: string;
					status?: string;
					conclusion?: string;
					html_url?: string;
			  }
			| undefined;
		try {
			run = (await githubGet(
				this.env,
				`/repos/${job.repo}/actions/runs/${job.workflow_run_id}`,
			)) as {
				name?: string;
				status?: string;
				conclusion?: string;
				html_url?: string;
			};
		} catch {
			return job;
		}
		if (!run) {
			return job;
		}
		job.worker_manifest = {
			...job.worker_manifest,
			last_workflow_run: {
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
			},
		};
		if (run.status === 'completed') {
			if (run.conclusion === 'success') {
				this.transitionJob(job, 'review_pending', 'reviewer');
			} else if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
				job.auto_improve_cycle += 1;
				const redispatched = await this.autoRedispatchJob(job, 'workflow reconciliation failure');
				if (!redispatched) {
					this.transitionJob(job, 'rework_pending', 'worker');
				}
			} else {
				this.transitionJob(job, 'failed', 'system');
				job.last_error = `${run.name ?? 'workflow'} concluded with ${run.conclusion ?? 'unknown'}`;
			}
			job.stale_reason = undefined;
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		}
		if (job.status === 'review_pending' && isOlderThan(job.updated_at, getReviewStaleAfterMs(this.env))) {
			await this.markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
		}
		return job;
	}

	private async listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]> {
		const jobs: JobRecord[] = [];
		const records = await this.ctx.storage.list<JobRecord>({ prefix: 'job:' });
		for (const [, value] of records) {
			const reconciled = await this.reconcileJob(value);
			if (status && reconciled.status !== status) {
				continue;
			}
			if (nextActor && reconciled.next_actor !== nextActor) {
				continue;
			}
			jobs.push(reconciled);
		}
		return jobs.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
	}

	private async listWorkspaces(): Promise<WorkspaceRecord[]> {
		const workspaces: WorkspaceRecord[] = [];
		const records = await this.ctx.storage.list<WorkspaceRecord>({ prefix: 'workspace:' });
		for (const [, value] of records) {
			workspaces.push(value);
		}
		return workspaces.sort((left, right) => left.repo_key.localeCompare(right.repo_key));
	}

	private async findByRepoAndBranch(repo: string, workBranch?: string): Promise<JobRecord | null> {
		if (!workBranch) {
			return null;
		}
		return this.findJob((job) => {
				if (job.repo !== repo || !job.work_branch) {
					return false;
				}
				return (
					job.work_branch === workBranch ||
					workBranch.startsWith(`${job.work_branch}-`)
				);
			});
	}

	private async findByRepoAndRun(repo: string, runId?: number): Promise<JobRecord | null> {
		if (!runId) {
			return null;
		}
		return this.findJob((job) => job.repo === repo && job.workflow_run_id === runId);
	}

	private normalizeJob(input: Partial<JobRecord> & { job_id: string }): JobRecord {
		const timestamp = nowIso();
		return {
			job_id: input.job_id,
			repo: input.repo ?? '',
			base_branch: input.base_branch ?? 'main',
			work_branch: input.work_branch,
			pr_number: input.pr_number,
			workflow_run_id: input.workflow_run_id,
			operation_type: input.operation_type,
			target_paths: input.target_paths ?? [],
			status: input.status ?? 'queued',
			next_actor: input.next_actor ?? 'worker',
			auto_improve_enabled: input.auto_improve_enabled ?? false,
			auto_improve_max_cycles: input.auto_improve_max_cycles ?? 1,
			auto_improve_cycle: input.auto_improve_cycle ?? 0,
			worker_manifest: input.worker_manifest ?? {},
			review_verdict: input.review_verdict,
			review_findings: input.review_findings ?? [],
			last_error: input.last_error,
			stale_reason: input.stale_reason,
			notes: input.notes ?? [],
			created_at: input.created_at ?? timestamp,
			last_transition_at: input.last_transition_at ?? input.created_at ?? timestamp,
			last_reconciled_at: input.last_reconciled_at,
			last_webhook_event_at: input.last_webhook_event_at,
			updated_at: timestamp,
		};
	}

	private normalizeWorkspace(input: Partial<WorkspaceRecord> & { repo_key: string }): WorkspaceRecord {
		const timestamp = nowIso();
		const repoKey = input.repo_key.trim();
		const repoSlug = repoKey.split('/').pop() ?? repoKey;
		const workspacePath = input.workspace_path?.trim() || `/home/uieseong/workspace/github/${repoSlug}`;
		ensureAbsoluteWorkspacePath(workspacePath);
		const aliases = Array.from(
			new Set(
				(input.aliases ?? [])
					.map((item) => item.trim())
					.filter(Boolean)
					.concat([repoKey, repoSlug]),
			),
		);
		return {
			repo_key: repoKey,
			workspace_path: workspacePath,
			repo_slug: repoSlug,
			display_name: input.display_name?.trim() || repoSlug,
			aliases,
			created_at: input.created_at ?? timestamp,
			updated_at: timestamp,
		};
	}

	private async createJob(input: Partial<JobRecord> & { job_id: string }): Promise<ToolResultEnvelope> {
		const existing = await this.getJob(input.job_id);
		if (existing) {
			return fail('job_exists', 'job_id already exists');
		}
		const job = this.normalizeJob(input);
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_create', this.buildJobAudit(job));
		return ok({ job });
	}

	private async registerWorkspace(input: Partial<WorkspaceRecord> & { repo_key: string }): Promise<ToolResultEnvelope> {
		const existing = await this.getWorkspace(input.repo_key);
		const workspace = this.normalizeWorkspace({ ...existing, ...input, repo_key: input.repo_key });
		await this.ctx.storage.put(workspaceStorageKey(workspace.repo_key), workspace);
		await this.writeAudit('workspace_register', {
			repo_key: workspace.repo_key,
			workspace_path: workspace.workspace_path,
		});
		return ok({ workspace });
	}

	private async findSimilarWorkspaces(query?: string, repoKey?: string): Promise<ToolResultEnvelope> {
		const workspaces = await this.listWorkspaces();
		const target = normalizeLookup(query || repoKey || '');
		const repoSlug = normalizeLookup((repoKey || '').split('/').pop() ?? '');
		const matches = workspaces
			.map((workspace) => {
				const candidates = [
					workspace.repo_key,
					workspace.repo_slug,
					workspace.display_name,
					workspace.workspace_path,
					...workspace.aliases,
				].map(normalizeLookup);
				let score = 0;
				if (repoKey && candidates.includes(normalizeLookup(repoKey))) {
					score = 100;
				} else if (repoSlug && candidates.includes(repoSlug)) {
					score = 90;
				} else if (target && candidates.some((item) => item === target)) {
					score = 80;
				} else if (target && candidates.some((item) => item.includes(target) || target.includes(item))) {
					score = 60;
				}
				return { workspace, score };
			})
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score);
		return ok({
			matches: matches.map((item) => ({
				score: item.score,
				repo_key: item.workspace.repo_key,
				workspace_path: item.workspace.workspace_path,
				display_name: item.workspace.display_name,
				aliases: item.workspace.aliases,
			})),
		});
	}

	private async upsertJob(input: Partial<JobRecord> & { job_id: string }): Promise<JobRecord> {
		const existing = await this.getJob(input.job_id);
		const job = this.normalizeJob({ ...existing, ...input, job_id: input.job_id });
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_upsert', this.buildJobAudit(job));
		return job;
	}

	private async updateJobStatus(body: QueueEnvelope): Promise<ToolResultEnvelope> {
		if (!body.job_id || !body.status || !body.next_actor) {
			return fail('invalid_request', 'job_id, status, and next_actor are required');
		}
		const job = await this.getJob(body.job_id);
		if (!job) {
			return fail('not_found', 'job not found');
		}
		this.transitionJob(job, body.status, body.next_actor);
		if (body.job?.work_branch !== undefined) {
			job.work_branch = body.job.work_branch;
		}
		if (body.job?.workflow_run_id !== undefined) {
			job.workflow_run_id = body.job.workflow_run_id;
		}
		if (body.job?.pr_number !== undefined) {
			job.pr_number = body.job.pr_number;
		}
		if (body.job?.last_error !== undefined) {
			job.last_error = body.job.last_error;
		}
		if (body.job?.worker_manifest !== undefined) {
			job.worker_manifest = {
				...job.worker_manifest,
				...(body.job.worker_manifest as Record<string, unknown>),
			};
		}
		job.updated_at = nowIso();
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_update_status', this.buildJobAudit(job));
		return ok({ job });
	}

	private async appendJobNote(body: QueueEnvelope): Promise<ToolResultEnvelope> {
		if (!body.job_id || !body.note) {
			return fail('invalid_request', 'job_id and note are required');
		}
		const job = await this.getJob(body.job_id);
		if (!job) {
			return fail('not_found', 'job not found');
		}
		this.pushJobNote(job, body.note);
		job.updated_at = nowIso();
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_append_note', this.buildJobAudit(job, { note: body.note }));
		return ok({ job });
	}

	private async getJobProgress(jobId: string): Promise<ToolResultEnvelope> {
		const job = await this.getJob(jobId);
		if (!job) {
			return fail('not_found', 'job not found');
		}
		const hydratedJob = await this.reconcileJob(job);
		const audits = await this.listAuditRecords(undefined, jobId, 5);
		return ok({ progress: this.buildJobProgressSnapshot(hydratedJob, audits) });
	}

	private async submitReview(body: QueueEnvelope): Promise<ToolResultEnvelope> {
		if (!body.job_id || !body.review_verdict || !body.next_action) {
			return fail('invalid_request', 'job_id, review_verdict, and next_action are required');
		}
		const job = await this.getJob(body.job_id);
		if (!job) {
			return fail('not_found', 'job not found');
		}
		if (job.status !== 'review_pending' || job.next_actor !== 'reviewer') {
			return fail('invalid_state', 'job is not waiting for reviewer input');
		}
		job.review_verdict = body.review_verdict;
		job.review_findings = body.findings ?? [];
		job.stale_reason = undefined;
		this.pushJobNote(job, `review next_action: ${body.next_action}`);
		if (body.review_verdict === 'approved') {
			this.transitionJob(job, 'done', 'system');
		} else if (body.review_verdict === 'blocked') {
			this.transitionJob(job, 'failed', 'system');
			job.last_error = `review blocked: ${body.next_action}`;
		} else {
			if (job.auto_improve_cycle >= job.auto_improve_max_cycles) {
				this.transitionJob(job, 'failed', 'system');
				job.last_error = `review changes requested but auto improve limit reached: ${body.next_action}`;
			} else {
				job.auto_improve_cycle += 1;
				const redispatched = await this.autoRedispatchJob(job, `review changes requested: ${body.next_action}`);
				if (!redispatched) {
					this.transitionJob(job, 'rework_pending', 'worker');
				}
			}
		}
		job.updated_at = nowIso();
		await this.ctx.storage.put(jobStorageKey(job.job_id), job);
		await this.writeAudit('job_submit_review', this.buildJobAudit(job, { review_verdict: job.review_verdict }));
		return ok({ job });
	}

	private async applyGithubEvent(
		event: string,
		payload: Record<string, unknown>,
		deliveryId?: string,
	): Promise<Record<string, unknown>> {
		const repository = payload.repository as { full_name?: string } | undefined;
		const repo = repository?.full_name;
		if (!repo) {
			return { matched: false };
		}
		const registered = await this.tryRegisterDelivery(deliveryId);
		if (!registered) {
			return { matched: false, duplicate: true, delivery_id: deliveryId ?? null };
		}

		if (event === 'pull_request') {
			const pullRequest = payload.pull_request as { number?: number; head?: { ref?: string } } | undefined;
			const job = await this.findByRepoAndBranch(repo, pullRequest?.head?.ref);
			if (!job) {
				return { matched: false };
			}
			job.pr_number = pullRequest?.number;
			job.work_branch = pullRequest?.head?.ref;
			job.last_webhook_event_at = nowIso();
			if (job.workflow_run_id && githubAuthConfigured(this.env)) {
				const run = (await githubGet(
					this.env,
					`/repos/${repo}/actions/runs/${job.workflow_run_id}`,
				)) as {
					name?: string;
					status?: string;
					conclusion?: string;
					html_url?: string;
				};
				job.worker_manifest = {
					...job.worker_manifest,
					last_workflow_run: {
						name: run.name,
						status: run.status,
						conclusion: run.conclusion,
						html_url: run.html_url,
					},
				};
				if (run.status === 'completed') {
					if (run.conclusion === 'success') {
						this.transitionJob(job, 'review_pending', 'reviewer');
					} else if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
						job.auto_improve_cycle += 1;
						const redispatched = await this.autoRedispatchJob(job, 'pull_request reconciliation failure');
						if (!redispatched) {
							this.transitionJob(job, 'rework_pending', 'worker');
						}
					} else {
						this.transitionJob(job, 'failed', 'system');
						job.last_error = `${run.name ?? 'workflow'} concluded with ${run.conclusion ?? 'unknown'}`;
					}
				}
			}
			this.pushJobNote(job, `pull_request event: ${String(payload.action ?? 'unknown')}`);
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
			await this.writeAudit('pull_request', this.buildJobAudit(job, { pr_number: job.pr_number, delivery_id: deliveryId ?? null }));
			return { matched: true, job_id: job.job_id, pr_number: job.pr_number, work_branch: job.work_branch };
		}

		if (event === 'workflow_run') {
			const run = payload.workflow_run as
				| {
						id?: number;
						head_branch?: string;
						name?: string;
						status?: string;
						conclusion?: string;
						html_url?: string;
				  }
				| undefined;
			let job = await this.findByRepoAndRun(repo, run?.id);
			if (!job) {
				job = await this.findByRepoAndBranch(repo, run?.head_branch);
			}
			if (!job) {
				return { matched: false };
			}
			job.workflow_run_id = run?.id;
			job.last_webhook_event_at = nowIso();
			if (run?.head_branch && run.head_branch !== getDefaultBaseBranch(this.env)) {
				job.work_branch = run.head_branch;
			}
			job.worker_manifest = {
				...job.worker_manifest,
				last_workflow_run: {
					name: run?.name,
					status: run?.status,
					conclusion: run?.conclusion,
					html_url: run?.html_url,
				},
			};
				if (payload.action === 'completed') {
					if (run?.conclusion === 'success') {
						this.transitionJob(job, 'review_pending', 'reviewer');
					} else {
						job.last_error = `${run?.name ?? 'workflow'} concluded with ${run?.conclusion ?? 'unknown'}`;
						if (job.auto_improve_enabled && job.auto_improve_cycle < job.auto_improve_max_cycles) {
							job.auto_improve_cycle += 1;
							const redispatched = await this.autoRedispatchJob(job, 'workflow webhook failure');
							if (!redispatched) {
								this.transitionJob(job, 'rework_pending', 'worker');
								this.pushJobNote(job, 'auto improvement cycle queued after workflow failure');
							}
						} else {
							this.transitionJob(job, 'failed', 'system');
						}
						job.stale_reason = undefined;
					}
				}
			job.updated_at = nowIso();
			await this.ctx.storage.put(jobStorageKey(job.job_id), job);
			await this.writeAudit(
				'workflow_run',
				this.buildJobAudit(job, {
					delivery_id: deliveryId ?? null,
					workflow_name: run?.name ?? null,
					conclusion: run?.conclusion ?? null,
				}),
			);
			return {
				matched: true,
				job_id: job.job_id,
				workflow_run_id: job.workflow_run_id,
				status: job.status,
				next_actor: job.next_actor,
			};
		}

		return { matched: false };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/queue') {
			try {
				const body = (await request.json()) as QueueEnvelope;
				if (body.action === 'job_create' && body.job?.job_id) {
					return jsonResponse(await this.createJob(body.job as Partial<JobRecord> & { job_id: string }));
				}
				if (body.action === 'workspace_register' && body.workspace?.repo_key) {
					return jsonResponse(
						await this.registerWorkspace(body.workspace as Partial<WorkspaceRecord> & { repo_key: string }),
					);
				}
				if (body.action === 'workspace_get' && body.repo_key) {
					const workspace = await this.getWorkspace(body.repo_key);
					return jsonResponse(workspace ? ok({ workspace }) : fail('not_found', 'workspace not found'));
				}
				if (body.action === 'workspace_find_similar') {
					return jsonResponse(await this.findSimilarWorkspaces(body.query, body.repo_key));
				}
				if (body.action === 'workspace_list') {
					const workspaces = await this.listWorkspaces();
					return jsonResponse(ok({ workspaces }));
				}
				if (body.action === 'job_upsert' && body.job?.job_id) {
					const job = await this.upsertJob(body.job as Partial<JobRecord> & { job_id: string });
					return jsonResponse(ok({ job }));
				}
				if (body.action === 'job_get' && body.job_id) {
					const job = await this.getJob(body.job_id);
					const hydratedJob = job ? await this.reconcileJob(job) : null;
					return jsonResponse(hydratedJob ? ok({ job: hydratedJob }) : fail('not_found', 'job not found'));
				}
				if (body.action === 'job_progress' && body.job_id) {
					return jsonResponse(await this.getJobProgress(body.job_id));
				}
				if (body.action === 'jobs_list') {
					const jobs = await this.listJobs(body.status, body.next_actor);
					return jsonResponse(ok({ jobs }));
				}
				if (body.action === 'audit_list') {
					const audits = await this.listAuditRecords(body.event_type, body.job_id, body.limit);
					return jsonResponse(ok({ audits }));
				}
				if (body.action === 'job_update_status') {
					return jsonResponse(await this.updateJobStatus(body));
				}
				if (body.action === 'job_append_note') {
					return jsonResponse(await this.appendJobNote(body));
				}
				if (body.action === 'job_submit_review') {
					return jsonResponse(await this.submitReview(body));
				}
				if (body.action === 'github_event' && body.event && body.payload) {
					const outcome = await this.applyGithubEvent(body.event, body.payload, body.delivery_id);
					return jsonResponse(ok({ outcome }));
				}
				return jsonResponse(fail('invalid_request', 'unsupported queue action'), 400);
			} catch (error) {
				diagnosticLog('queue_action_failed', {
					path: url.pathname,
					error: error instanceof Error ? error.message : String(error),
				});
				return jsonResponse(fail('queue_action_failed', error), errorStatus(error));
			}
		}

		return jsonResponse(fail('not_found', 'not found'), 404);
	}
}

async function queueFetch(env: AppEnv, payload: QueueEnvelope): Promise<Response> {
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

async function queueJson(env: AppEnv, payload: QueueEnvelope): Promise<ToolResultEnvelope> {
	const response = await queueFetch(env, payload);
	return (await response.json()) as ToolResultEnvelope;
}

async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
	const rawBody = await request.text();
	const signature = request.headers.get('X-Hub-Signature-256');
	const deliveryId = request.headers.get('X-GitHub-Delivery');
	const secret = env.WEBHOOK_SECRET ?? '';
	if (String(env.REQUIRE_WEBHOOK_SECRET) === 'true' && !secret) {
		return jsonResponse(fail('missing_webhook_secret', 'webhook secret required'), 500);
	}
	const verified = await verifyWebhookSignature(secret, rawBody, signature);
	if (!verified) {
		return jsonResponse(fail('invalid_signature', 'invalid webhook signature'), 401);
	}
	const payload = JSON.parse(rawBody) as Record<string, unknown>;
	const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
	if (!repo || !repoAllowed(env, repo)) {
		return jsonResponse(fail('repo_not_allowlisted', 'repository not allowlisted'), 403);
	}
	const event = request.headers.get('X-GitHub-Event') ?? 'unknown';
	diagnosticLog('webhook_received', {
		event,
		repo,
		delivery_id: deliveryId ?? null,
		action: payload.action ?? null,
	});
	let queueResult: ToolResultEnvelope;
	try {
		queueResult = await queueJson(env, { action: 'github_event', event, payload, delivery_id: deliveryId ?? undefined });
	} catch (error) {
		diagnosticLog('webhook_queue_error', {
			event,
			repo,
			error: error instanceof Error ? error.message : String(error),
		});
		return jsonResponse(fail('webhook_queue_failed', error), 502);
	}
	return jsonResponse({
		ok: true,
		event,
		delivery_id: deliveryId ?? null,
		action: payload.action ?? null,
		outcome: queueResult.data?.outcome ?? { matched: false },
	});
}

async function handleQueueApi(request: Request, env: AppEnv): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'POST' && url.pathname === '/queue/job') {
		const job = (await request.json()) as Partial<JobRecord> & { job_id: string };
		return queueFetch(env, { action: 'job_upsert', job });
	}
	if (request.method === 'GET' && url.pathname.startsWith('/queue/job/')) {
		const jobId = url.pathname.split('/').pop();
		return queueFetch(env, { action: 'job_get', job_id: jobId });
	}
	if (request.method === 'GET' && url.pathname === '/queue/jobs') {
		const status = url.searchParams.get('status') as JobStatus | null;
		const nextActor = url.searchParams.get('next_actor') as NextActor | null;
		return queueFetch(env, {
			action: 'jobs_list',
			status: status ?? undefined,
			next_actor: nextActor ?? undefined,
		});
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}

function buildMcpServer(env: AppEnv): McpServer {
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.1.0',
	});

	const readAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};

	server.registerTool(
		'help',
		{
			description:
				'Explain what kinds of GitHub work this MCP server can do and return example request templates. Use this when the user asks what work is possible or how to phrase a request.',
			inputSchema: {
				query: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ query }) => toolText(ok(buildHelpPayload(query), readAnnotations)),
	);

	server.registerTool(
		'repo_work_context',
		{
			description:
				'Use the GitHub repository itself as the primary working context instead of a local folder. Returns open agent PRs, active queue jobs, and recent workflow runs so chat can continue work in stages.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				include_completed_jobs: z.boolean().default(false),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, include_completed_jobs }) => {
			const startedAt = Date.now();
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const [repoData, prsData, runsData, jobsData, workspaceData] = await Promise.all([
					githubGet(env, `/repos/${owner}/${repo}`) as Promise<Record<string, unknown>>,
					githubGet(env, `/repos/${owner}/${repo}/pulls`, {
						params: { state: 'open', per_page: 20 },
					}) as Promise<Array<Record<string, unknown>>>,
					githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
						params: { per_page: 10 },
					}) as Promise<{ workflow_runs?: Array<Record<string, unknown>> }>,
					queueJson(env, { action: 'jobs_list' }),
					queueJson(env, { action: 'workspace_get', repo_key: repoKey }),
				]);
				const branchPrefix = getBranchPrefix(env);
				const openAgentPrs = prsData
					.filter((item) => {
						const head = (item.head ?? null) as { ref?: string } | null;
						return String(head?.ref ?? '').startsWith(branchPrefix);
					})
					.map((item) => {
						const head = (item.head ?? null) as { ref?: string } | null;
						const base = (item.base ?? null) as { ref?: string } | null;
						return ({
						number: item.number,
						title: item.title,
						state: item.state,
						head_ref: head?.ref ?? null,
						base_ref: base?.ref ?? null,
						html_url: item.html_url,
						updated_at: item.updated_at,
						});
					});
				const repoJobs = ((jobsData.data?.jobs as unknown[] | undefined) ?? [])
					.filter((item) => {
						const job = item as Record<string, unknown>;
						if (job.repo !== repoKey) {
							return false;
						}
						if (include_completed_jobs) {
							return true;
						}
						return job.status !== 'done' && job.status !== 'failed';
					})
					.map((job) => ({
						job_id: (job as Record<string, unknown>).job_id,
						status: (job as Record<string, unknown>).status,
						next_actor: (job as Record<string, unknown>).next_actor,
						work_branch: (job as Record<string, unknown>).work_branch ?? null,
						pr_number: (job as Record<string, unknown>).pr_number ?? null,
						stale_reason: (job as Record<string, unknown>).stale_reason ?? null,
						last_transition_at: (job as Record<string, unknown>).last_transition_at ?? null,
						last_webhook_event_at: (job as Record<string, unknown>).last_webhook_event_at ?? null,
						updated_at: (job as Record<string, unknown>).updated_at ?? null,
					}));
				const recentRuns = (runsData.workflow_runs ?? []).slice(0, 5).map((item) => ({
					id: item.id,
					name: item.name,
					event: item.event,
					status: item.status,
					conclusion: item.conclusion,
					html_url: item.html_url,
					created_at: item.created_at,
					head_branch: item.head_branch,
				}));
				return toolText(
					ok(
						{
							repo_key: repoKey,
							use_repo_as_workspace: true,
							repo_default_branch: repoData.default_branch ?? getDefaultBaseBranch(env),
							repo_html_url: repoData.html_url ?? null,
							open_agent_prs: openAgentPrs,
							active_jobs: repoJobs,
							recent_workflow_runs: recentRuns,
							registered_workspace: workspaceData.ok ? workspaceData.data?.workspace ?? null : null,
							recommended_next_step:
								openAgentPrs.length > 0 || repoJobs.length > 0
									? 'reuse_existing_repo_context'
									: 'start_new_repo_job',
						},
						readAnnotations,
					),
				);
			} catch (error) {
				diagnosticLog('repo_work_context_error', {
					owner,
					repo,
					duration_ms: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				});
				return toolText(fail('repo_work_context_failed', error, readAnnotations));
			} finally {
				diagnosticLog('repo_work_context_complete', {
					owner,
					repo,
					include_completed_jobs,
					duration_ms: Date.now() - startedAt,
				});
			}
		},
	);

	server.registerTool(
		'workspace_resolve',
		{
			description:
				'Resolve the preferred GitHub workspace folder for a repo. Returns a registered folder if one exists, otherwise a default dedicated GitHub folder plus similar registered matches to review before creating a new folder.',
			inputSchema: {
				repo_key: z.string(),
				preferred_root: z.string().default('/home/uieseong/workspace/github'),
			},
			annotations: readAnnotations,
		},
		async ({ repo_key, preferred_root }) => {
			try {
				const existing = await queueJson(env, { action: 'workspace_get', repo_key });
				const similar = await queueJson(env, { action: 'workspace_find_similar', repo_key });
				const repoSlug = repo_key.split('/').pop() ?? repo_key;
				const defaultWorkspacePath = `${preferred_root.replace(/\/$/, '')}/${repoSlug}`;
				return toolText(
					ok(
						{
							repo_key,
							default_workspace_path: defaultWorkspacePath,
							existing_workspace: existing.ok ? existing.data?.workspace ?? null : null,
							similar_workspaces: similar.data?.matches ?? [],
							requires_confirmation:
								Boolean(existing.ok && existing.data?.workspace) ||
								((similar.data?.matches as unknown[] | undefined)?.length ?? 0) > 0,
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail('workspace_resolve_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workspace_register',
		{
			description:
				'Register or update the preferred GitHub workspace folder for a repo so future chat sessions can reuse it instead of creating a similar new folder.',
			inputSchema: {
				repo_key: z.string(),
				workspace_path: z.string(),
				display_name: z.string().optional(),
				aliases: z.array(z.string()).default([]),
			},
			annotations: writeAnnotations,
		},
		async ({ repo_key, workspace_path, display_name, aliases }) => {
			try {
				const result = await queueJson(env, {
					action: 'workspace_register',
					workspace: { repo_key, workspace_path, display_name, aliases },
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('workspace_register_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'workspace_find_similar',
		{
			description:
				'Find registered workspace folders similar to a repo or folder name before creating a new GitHub workspace folder.',
			inputSchema: {
				query: z.string().optional(),
				repo_key: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ query, repo_key }) => {
			try {
				const result = await queueJson(env, {
					action: 'workspace_find_similar',
					query,
					repo_key,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('workspace_find_similar_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workspace_list',
		{
			description: 'List registered GitHub workspace folders known to this MCP server.',
			annotations: readAnnotations,
		},
		async () => {
			const result = await queueJson(env, { action: 'workspace_list' });
			return toolText(result);
		},
	);

	server.registerTool(
		'repo_get_file',
		{
			description: 'Read a file from an allowlisted GitHub repository.',
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
				ensureRepoAllowed(env, repoKey);
				ensureSafePath(path);
				const data = (await githubGet(
					env,
					`/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`,
					{ params: ref ? { ref } : {} },
				)) as Record<string, unknown>;
				const content = typeof data.content === 'string' ? decodeBase64Text(data.content) : null;
				return toolText(ok({ ...data, decoded_text: content }, readAnnotations));
			} catch (error) {
				return toolText(fail('repo_get_file_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_list_tree',
		{
			description: 'List repository tree entries from an allowlisted GitHub repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				path: z.string().optional(),
				recursive: z.boolean().default(false),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref, path, recursive }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const treeResult = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || getDefaultBaseBranch(env))}`,
					{ params: { recursive } },
				)) as { tree?: Array<Record<string, unknown>> };
				const filteredTree = path
					? (treeResult.tree ?? []).filter((entry) => String(entry.path ?? '').startsWith(path))
					: treeResult.tree ?? [];
				return toolText(ok({ ...treeResult, tree: filteredTree }, readAnnotations));
			} catch (error) {
				return toolText(fail('repo_list_tree_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'branch_cleanup_candidates',
		{
			description:
				'List candidate agent branches that appear safe to clean up. Use this direct cleanup flow before branch deletion instead of workflow dispatch or workflow-file editing.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				per_page: z.number().int().positive().max(100).default(100),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, per_page }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const branchPrefix = getBranchPrefix(env);
				const [branchesData, jobsData] = await Promise.all([
					githubGet(env, `/repos/${owner}/${repo}/branches`, { params: { per_page } }) as Promise<
						Array<{ name?: string; protected?: boolean; commit?: { sha?: string } }>
					>,
					queueJson(env, { action: 'jobs_list' }),
				]);
				const activeJobs = (((jobsData.data?.jobs as unknown[] | undefined) ?? []).filter((item) => {
					const job = item as Record<string, unknown>;
					return (
						job.repo === repoKey &&
						job.status !== 'done' &&
						job.status !== 'failed'
					);
				}) as Array<Record<string, unknown>>);
				const candidates = await Promise.all(
					branchesData
						.filter((branch) => String(branch.name ?? '').startsWith(branchPrefix))
						.map(async (branch) => {
							const branchName = String(branch.name ?? '');
							const pulls = (await githubGet(env, `/repos/${owner}/${repo}/pulls`, {
								params: { state: 'all', head: `${owner}:${branchName}`, per_page: 20 },
							})) as Array<{ number?: number; state?: string; html_url?: string; updated_at?: string }>;
							const openPr = pulls.find((pull) => pull.state === 'open');
							const latestPr = pulls[0];
							const linkedJobs = activeJobs
								.filter((job) => {
									const workBranch = String(job.work_branch ?? '');
									return workBranch === branchName || workBranch.startsWith(`${branchName}-`);
								})
								.map((job) => ({
									job_id: job.job_id,
									status: job.status,
									next_actor: job.next_actor,
								}));
							const cleanupSafe = !openPr && linkedJobs.length === 0;
							return {
								branch_name: branchName,
								protected: Boolean(branch.protected),
								head_sha: branch.commit?.sha ?? null,
								open_pr: openPr
									? {
											number: openPr.number ?? null,
											html_url: openPr.html_url ?? null,
									  }
									: null,
								latest_pr: latestPr
									? {
											number: latestPr.number ?? null,
											state: latestPr.state ?? null,
											html_url: latestPr.html_url ?? null,
											updated_at: latestPr.updated_at ?? null,
									  }
									: null,
								active_jobs: linkedJobs,
								cleanup_safe: cleanupSafe,
								reason: cleanupSafe
									? 'no_open_pr_and_no_active_job'
									: openPr
										? 'open_pr_exists'
										: 'active_job_exists',
							};
						}),
				);
				return toolText(ok({ candidates }, readAnnotations));
			} catch (error) {
				return toolText(fail('branch_cleanup_candidates_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'branch_cleanup_execute',
		{
			description:
				'Delete an agent branch directly only when it is allowlisted, not the default branch, has no open PR, and has no active queue job. Do not route branch deletion through workflow dispatch or workflow-file editing.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch_name: z.string(),
			},
			annotations: {
				readOnlyHint: false,
				openWorldHint: false,
				destructiveHint: true,
			},
		},
		async ({ owner, repo, branch_name }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch_name);
				ensureNotDefaultBranch(env, branch_name);
				const [pulls, jobsData] = await Promise.all([
					githubGet(env, `/repos/${owner}/${repo}/pulls`, {
						params: { state: 'open', head: `${owner}:${branch_name}`, per_page: 20 },
					}) as Promise<Array<{ number?: number }>>,
					queueJson(env, { action: 'jobs_list' }),
				]);
				const activeJobs = (((jobsData.data?.jobs as unknown[] | undefined) ?? []).filter((item) => {
					const job = item as Record<string, unknown>;
					const workBranch = String(job.work_branch ?? '');
					return (
						job.repo === repoKey &&
						job.status !== 'done' &&
						job.status !== 'failed' &&
						(workBranch === branch_name || workBranch.startsWith(`${branch_name}-`))
					);
				}) as Array<Record<string, unknown>>);
				if (pulls.length > 0) {
					throw new Error(`branch has open pull request: #${pulls[0].number ?? 'unknown'}`);
				}
				if (activeJobs.length > 0) {
					throw new Error(`branch has active queue job: ${String(activeJobs[0].job_id ?? 'unknown')}`);
				}
				await githubDelete(env, `/repos/${owner}/${repo}/git/refs/heads/${encodeGitHubRef(branch_name)}`);
				return toolText(ok({ branch_name, deleted: true }, {
					readOnlyHint: false,
					openWorldHint: false,
					destructiveHint: true,
				}));
			} catch (error) {
				return toolText(
					fail(errorCodeFor(error, 'branch_cleanup_execute_failed'), error, {
						readOnlyHint: false,
						openWorldHint: false,
						destructiveHint: true,
					}),
				);
			}
		},
	);

	server.registerTool(
		'issue_get',
		{
			description: 'Fetch a GitHub issue from an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				issue_number: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, issue_number }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/issues/${issue_number}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail('issue_get_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_get',
		{
			description: 'Fetch a GitHub pull request from an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				pull_number: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, pull_number }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/pulls/${pull_number}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail('pr_get_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_get_files',
		{
			description: 'List changed files for a pull request in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				pull_number: z.number().int().positive(),
				page: z.number().int().positive().default(1),
				per_page: z.number().int().positive().max(100).default(100),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, pull_number, page, per_page }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const files = (await githubGet(env, `/repos/${owner}/${repo}/pulls/${pull_number}/files`, {
					params: { page, per_page },
				})) as unknown[];
				return toolText(ok({ files }, readAnnotations));
			} catch (error) {
				return toolText(fail('pr_get_files_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_runs_list',
		{
			description: 'List workflow runs for an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch: z.string().optional(),
				event: z.string().optional(),
				per_page: z.number().int().positive().max(100).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, branch, event, per_page }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs`, {
					params: { branch, event, per_page },
				})) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail('workflow_runs_list_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_run_get',
		{
			description: 'Fetch a single workflow run for an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${run_id}`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail('workflow_run_get_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_artifacts_list',
		{
			description: 'List artifacts for a workflow run in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				run_id: z.number().int().positive(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, run_id }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, `/repos/${owner}/${repo}/actions/runs/${run_id}/artifacts`)) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail('workflow_artifacts_list_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_create_branch',
		{
			description: 'Create an agent branch from the default base branch in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch_name: z.string(),
				base_branch: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, branch_name, base_branch }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch_name);
				const baseRef = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch || getDefaultBaseBranch(env))}`,
				)) as { object?: { sha?: string } };
				const sha = baseRef.object?.sha;
				if (!sha) {
					throw new Error('base branch sha not found');
				}
				const data = (await githubPost(env, `/repos/${owner}/${repo}/git/refs`, {
					ref: `refs/heads/${branch_name}`,
					sha,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail('repo_create_branch_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_update_file',
		{
			description: 'Update a file on an agent branch in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				content_b64: z.string(),
				expected_blob_sha: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, branch, path, message, content_b64, expected_blob_sha }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch);
				ensureNotDefaultBranch(env, branch);
				ensureSafePath(path);
				atob(content_b64);
				const payload: Record<string, unknown> = {
					message,
					content: content_b64,
					branch,
				};
				if (expected_blob_sha) {
					payload.sha = expected_blob_sha;
				}
				const data = (await githubPut(
					env,
					`/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`,
					payload,
				)) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail('repo_update_file_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_create',
		{
			description: 'Create a pull request in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				title: z.string(),
				body: z.string(),
				head: z.string(),
				base: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, title, body, head, base }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/pulls`, {
					title,
					body,
					head,
					base,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail('pr_create_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'comment_create',
		{
			description: 'Create an issue or PR comment in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				issue_number: z.number().int().positive(),
				body: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, issue_number, body }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
					body,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail('comment_create_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'workflow_dispatch',
		{
			description: 'Dispatch an allowlisted workflow in an allowlisted repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				workflow_id: z.string(),
				ref: z.string(),
				inputs: z.record(z.string(), z.unknown()).default({}),
			},
			annotations: writeAnnotations,
		},
		async ({ owner, repo, workflow_id, ref, inputs }) => {
			const startedAt = Date.now();
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				if (ref !== getDefaultBaseBranch(env)) {
					ensureBranchAllowed(env, ref);
				}
				ensureWorkflowAllowed(env, workflow_id);
				validateWorkflowInputs(inputs);
				const jobId = typeof inputs.job_id === 'string' ? inputs.job_id : undefined;
				let existingJob:
					| {
							work_branch?: string;
							status?: string;
							next_actor?: string;
							auto_improve_cycle?: number;
							worker_manifest?: Record<string, unknown>;
					  }
					| null = null;
				if (jobId) {
					const existingJobResult = await queueJson(env, {
						action: 'job_get',
						job_id: jobId,
					});
					existingJob = ((existingJobResult.data?.job ?? null) as
						| {
								work_branch?: string;
								status?: string;
								next_actor?: string;
								auto_improve_cycle?: number;
								worker_manifest?: Record<string, unknown>;
						  }
						| null);
				}
				const autoImproveCycle =
					typeof existingJob?.auto_improve_cycle === 'number' ? existingJob.auto_improve_cycle : 0;
				const fingerprint = await buildDispatchFingerprint(owner, repo, workflow_id, ref, inputs, autoImproveCycle);
				const existingDispatch = (existingJob?.worker_manifest?.dispatch_request ?? null) as
					| Partial<DispatchRequestRecord>
					| null;
				const workflowState = (existingJob?.worker_manifest?.last_workflow_run ?? null) as
					| {
							status?: string;
					  }
					| null;
				if (
					jobId &&
					existingJob?.status === 'working' &&
					existingJob?.next_actor === 'system' &&
					existingDispatch?.fingerprint === fingerprint &&
					workflowState?.status !== 'completed' &&
					!isOlderThan(existingDispatch?.dispatched_at, getDispatchDedupeWindowMs(env))
				) {
					diagnosticLog('workflow_dispatch_deduplicated', {
						owner,
						repo,
						workflow_id,
						ref,
						job_id: jobId,
						auto_improve_cycle: autoImproveCycle,
					});
					return toolText(ok({ workflow_id, ref, inputs, deduplicated: true }, writeAnnotations));
				}
				const dispatchedAtIso = nowIso();
				await githubPost(env, `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`, {
					ref,
					inputs,
				});
				if (jobId) {
					const existingWorkBranch =
						typeof existingJob?.work_branch === 'string' ? existingJob.work_branch : undefined;
					await queueJson(env, {
						action: 'job_update_status',
						job_id: jobId,
						status: 'working',
						next_actor: 'system',
						job: {
							work_branch:
								existingWorkBranch ??
								(ref === getDefaultBaseBranch(env) ? undefined : ref),
							worker_manifest: {
								dispatch_request: {
									owner,
									repo,
									workflow_id,
									ref,
									inputs,
									fingerprint,
									dispatched_at: dispatchedAtIso,
								},
								last_workflow_run: {
									status: 'queued',
									conclusion: null,
									html_url: null,
								},
							},
						},
					});
				}
				return toolText(ok({ workflow_id, ref, inputs }, writeAnnotations));
			} catch (error) {
				diagnosticLog('workflow_dispatch_error', {
					owner,
					repo,
					workflow_id,
					ref,
					duration_ms: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				});
				return toolText(fail(errorCodeFor(error, 'workflow_dispatch_failed'), error, writeAnnotations));
			} finally {
				diagnosticLog('workflow_dispatch_complete', {
					owner,
					repo,
					workflow_id,
					ref,
					duration_ms: Date.now() - startedAt,
				});
			}
		},
	);

	server.registerTool(
		'job_create',
		{
			description: 'Create a persistent queue job for worker or reviewer loops.',
			inputSchema: {
				job_id: z.string(),
				repo: z.string(),
				base_branch: z.string().default(getDefaultBaseBranch(env)),
				work_branch: z.string().optional(),
				operation_type: z.string().optional(),
				target_paths: z.array(z.string()).default([]),
				next_actor: z.enum(['worker', 'reviewer', 'system']).default('worker'),
				auto_improve_enabled: z.boolean().default(false),
				auto_improve_max_cycles: z.number().int().min(0).default(getDefaultAutoImproveMaxCycles(env)),
			},
			annotations: writeAnnotations,
		},
		async (input) => {
			try {
				ensureRepoAllowed(env, input.repo);
				if (input.work_branch) {
					ensureBranchAllowed(env, input.work_branch);
				}
				const result = await queueJson(env, {
					action: 'job_create',
					job: {
						...input,
						status: 'queued',
						next_actor: input.next_actor,
						auto_improve_cycle: 0,
						worker_manifest: {},
						review_findings: [],
						notes: [],
					},
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('job_create_failed', error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'job_get',
		{
			description: 'Get a queue job by job_id.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_get', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail('job_get_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'job_progress',
		{
			description:
				'Get a concise progress snapshot for a queue job, including current status, latest note, and recent audit events. Use this during long read or investigation phases to make progress visible.',
			inputSchema: {
				job_id: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ job_id }) => {
			try {
				const result = await queueJson(env, { action: 'job_progress', job_id });
				return toolText(result);
			} catch (error) {
				return toolText(fail('job_progress_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'jobs_list',
		{
			description: 'List queue jobs filtered by status or next actor.',
			inputSchema: {
				status: z.enum(['queued', 'working', 'review_pending', 'rework_pending', 'done', 'failed']).optional(),
				next_actor: z.enum(['worker', 'reviewer', 'system']).optional(),
			},
			annotations: readAnnotations,
		},
		async ({ status, next_actor }) => {
			try {
				const result = await queueJson(env, { action: 'jobs_list', status, next_actor });
				return toolText(result);
			} catch (error) {
				return toolText(fail('jobs_list_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'audit_list',
		{
			description: 'List recent queue audit records, optionally filtered by event type or job_id.',
			inputSchema: {
				event_type: z.string().optional(),
				job_id: z.string().optional(),
				limit: z.number().int().positive().max(100).default(20),
			},
			annotations: readAnnotations,
		},
		async ({ event_type, job_id, limit }) => {
			try {
				const result = await queueJson(env, {
					action: 'audit_list',
					event_type,
					job_id,
					limit,
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('audit_list_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'jobs_list_pending_review',
		{
			description: 'List jobs waiting for reviewer action.',
			annotations: readAnnotations,
		},
		async () => {
			try {
				const result = await queueJson(env, {
					action: 'jobs_list',
					status: 'review_pending',
					next_actor: 'reviewer',
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('jobs_list_pending_review_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'jobs_list_pending_rework',
		{
			description: 'List jobs waiting for worker rework.',
			annotations: readAnnotations,
		},
		async () => {
			try {
				const result = await queueJson(env, {
					action: 'jobs_list',
					status: 'rework_pending',
					next_actor: 'worker',
				});
				return toolText(result);
			} catch (error) {
				return toolText(fail('jobs_list_pending_rework_failed', error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'job_update_status',
		{
			description: 'Update queue job status and routing state.',
			inputSchema: {
				job_id: z.string(),
				status: z.enum(['queued', 'working', 'review_pending', 'rework_pending', 'done', 'failed']),
				next_actor: z.enum(['worker', 'reviewer', 'system']),
				work_branch: z.string().optional(),
				workflow_run_id: z.number().int().positive().optional(),
				pr_number: z.number().int().positive().optional(),
				last_error: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, status, next_actor, work_branch, workflow_run_id, pr_number, last_error }) => {
			const result = await queueJson(env, {
				action: 'job_update_status',
				job_id,
				status,
				next_actor,
				job: { work_branch, workflow_run_id, pr_number, last_error },
			});
			return toolText(result);
		},
	);

	server.registerTool(
		'job_append_note',
		{
			description: 'Append a note to a queue job. Use this to leave short milestone updates during long reads, investigation, or implementation.',
			inputSchema: {
				job_id: z.string(),
				note: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, note }) => {
			const result = await queueJson(env, {
				action: 'job_append_note',
				job_id,
				note,
			});
			return toolText(result);
		},
	);

	server.registerTool(
		'job_submit_review',
		{
			description: 'Submit a structured review verdict for a queue job.',
			inputSchema: {
				job_id: z.string(),
				review_verdict: z.enum(['approved', 'changes_requested', 'blocked']),
				findings: z.array(
					z.object({
						severity: z.enum(['low', 'medium', 'high', 'critical']),
						file: z.string(),
						line_hint: z.string().optional(),
						rationale: z.string(),
					}),
				).default([]),
				next_action: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ job_id, review_verdict, findings, next_action }) => {
			const result = await queueJson(env, {
				action: 'job_submit_review',
				job_id,
				review_verdict,
				findings,
				next_action,
			});
			return toolText(result);
		},
	);

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const appEnv = env as AppEnv;
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/healthz') {
			return jsonResponse({
				ok: true,
				service: 'opengpt-github-mcp-worker',
				runtime: 'cloudflare-workers',
				durable_object_binding: true,
				auth_configured: githubAuthConfigured(appEnv),
				allowed_repos: getAllowedRepos(appEnv),
				allowed_workflows: getAllowedWorkflows(appEnv),
				branch_prefix: getBranchPrefix(appEnv),
				require_webhook_secret: String(appEnv.REQUIRE_WEBHOOK_SECRET) === 'true',
				working_stale_after_ms: getWorkingStaleAfterMs(appEnv),
				review_stale_after_ms: getReviewStaleAfterMs(appEnv),
				dispatch_dedupe_window_ms: getDispatchDedupeWindowMs(appEnv),
				audit_retention_count: getAuditRetentionCount(appEnv),
				delivery_retention_count: getDeliveryRetentionCount(appEnv),
			});
		}

		if (request.method === 'GET' && url.pathname === '/github/app-installation') {
			if (!githubAuthConfigured(appEnv)) {
				return jsonResponse(fail('github_auth_not_configured', 'github auth not configured'), 400);
			}
			try {
				const repo = getAllowedRepos(appEnv)[0] ?? 'iusung111/OpenGPT';
				const [owner, name] = repo.split('/');
				const data = await githubGet(appEnv, `/repos/${owner}/${name}`);
				return jsonResponse(ok({ repository: data as Record<string, unknown> }));
			} catch (error) {
				return jsonResponse(fail('github_app_installation_failed', error), 502);
			}
		}

		if (url.pathname === '/webhooks/github') {
			return handleWebhook(request, appEnv);
		}

		if (url.pathname.startsWith('/queue/')) {
			return handleQueueApi(request, appEnv);
		}

		if (url.pathname === '/mcp') {
			const handler = createMcpHandler(buildMcpServer(appEnv) as never, {
				route: '/mcp',
				enableJsonResponse: true,
			});
			return handler(request, appEnv, ctx);
		}

		return jsonResponse(fail('not_found', 'not found'), 404);
	},
} satisfies ExportedHandler<AppEnv>;
