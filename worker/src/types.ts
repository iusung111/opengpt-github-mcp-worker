import { DurableObject } from 'cloudflare:workers';

export type JobStatus = 'queued' | 'working' | 'review_pending' | 'rework_pending' | 'done' | 'failed';
export type NextActor = 'worker' | 'reviewer' | 'system';
export type ReviewVerdict = 'approved' | 'changes_requested' | 'blocked';

export type AppEnv = Env & {
	WEBHOOK_SECRET?: string;
	QUEUE_API_TOKEN?: string;
	GITHUB_APP_PRIVATE_KEY_PEM?: string;
	GITHUB_ALLOWED_REPOS?: string;
	GITHUB_ALLOWED_WORKFLOWS?: string;
	GITHUB_ALLOWED_WORKFLOWS_BY_REPO?: string;
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
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_WORKER_SCRIPT_NAME?: string;
	SELF_REPO_KEY?: string;
	SELF_DEPLOY_WORKFLOW?: string;
	SELF_LIVE_URL?: string;
	SELF_MIRROR_URL?: string;
	SELF_CURRENT_URL?: string;
	SELF_DEFAULT_DEPLOY_TARGET?: string;
	SELF_REQUIRE_MIRROR_FOR_LIVE?: string;
	MCP_REQUIRE_ACCESS_AUTH?: string;
	MCP_ALLOWED_EMAILS?: string;
	MCP_ALLOWED_EMAIL_DOMAINS?: string;
	CHATGPT_MCP_AUTH_MODE?: string;
	CHATGPT_MCP_ISSUER?: string;
	CHATGPT_MCP_AUDIENCE?: string;
	CHATGPT_MCP_JWKS_URL?: string;
	CHATGPT_MCP_JWKS_JSON?: string;
	CHATGPT_MCP_ALLOWED_EMAILS?: string;
};

export interface ReviewFinding {
	severity: 'low' | 'medium' | 'high' | 'critical';
	file: string;
	line_hint?: string;
	summary: string;
	rationale: string;
	required_fix?: string;
}

export interface WorkspaceRecord {
	repo_key: string;
	workspace_path: string;
	repo_slug: string;
	display_name: string;
	aliases: string[];
	created_at: string;
	updated_at: string;
	last_used_at?: string;
}

export interface DispatchRequestRecord {
	owner: string;
	repo: string;
	workflow_id: string;
	ref: string;
	inputs: Record<string, unknown>;
	fingerprint?: string;
	dispatched_at: string;
}

export interface JobRecord {
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

export interface ToolResultEnvelope {
	ok: boolean;
	data?: Record<string, unknown> | null;
	error?: string | null;
	code?: string | null;
	meta?: Record<string, unknown> | null;
}

export interface QueueEnvelope {
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
		| 'workspace_activate'
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

export interface AuditRecord {
	event_type: string;
	payload: Record<string, unknown>;
	created_at: string;
}

export interface DeliveryRecord {
	delivery_id: string;
	created_at: string;
}

export interface JobProgressSnapshot {
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
