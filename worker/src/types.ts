import { DurableObject } from 'cloudflare:workers';

export type JobStatus = 'queued' | 'working' | 'review_pending' | 'rework_pending' | 'done' | 'failed';
export type NextActor = 'worker' | 'reviewer' | 'system';
export type ReviewVerdict = 'approved' | 'changes_requested' | 'blocked';
export type RunAttentionStatus = 'idle' | 'pending_approval' | 'running' | 'completed' | 'failed';
export type NotificationSourceLayer = 'gpt' | 'mcp' | 'cloudflare' | 'repo' | 'system';
export type NotificationSeverity = 'info' | 'warning' | 'error';

export type AppEnv = Env & {
	JOB_QUEUE: DurableObjectNamespace<import('./index').JobQueueDurableObject>;
	FILE_UPLOADS: DurableObjectNamespace<import('./index').UploadSessionDurableObject>;
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
	MIRROR_GITHUB_APP_ID?: string;
	MIRROR_GITHUB_APP_INSTALLATION_ID?: string;
	MIRROR_GITHUB_APP_PRIVATE_KEY_PEM?: string;
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
	SELF_DEPLOY_ENV?: string;
	SELF_RELEASE_COMMIT_SHA?: string;
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

export interface JobWorkflowRunRecord {
	name?: string;
	status?: string;
	conclusion?: string | null;
	html_url?: string | null;
	run_id?: number | null;
	updated_at?: string;
}

export interface JobExecutionManifest {
	dispatch_request?: DispatchRequestRecord | null;
	last_workflow_run?: JobWorkflowRunRecord | null;
	profile?: string | null;
	run_id?: string | null;
	artifacts?: string[];
	updated_at?: string;
}

export interface JobVerificationStepRecord {
	name: string;
	status: 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'partial';
	duration_ms?: number | null;
	artifact_ids?: string[];
	log_excerpt?: string | null;
}

export interface JobVerificationManifest {
	status?: 'queued' | 'running' | 'passed' | 'failed' | 'partial' | null;
	profile?: string | null;
	suite?: string | null;
	run_id?: string | null;
	steps?: JobVerificationStepRecord[];
	artifacts?: string[];
	updated_at?: string;
}

export interface JobPreviewManifest {
	status?: 'idle' | 'creating' | 'ready' | 'destroying' | 'destroyed' | 'failed' | null;
	preview_id?: string | null;
	urls?: Record<string, string>;
	expires_at?: string | null;
	updated_at?: string;
}

export interface JobBrowserManifest {
	status?: 'idle' | 'running' | 'passed' | 'failed' | null;
	session_id?: string | null;
	target?: string | null;
	artifacts?: string[];
	updated_at?: string;
}

export interface JobDesktopManifest {
	status?: 'idle' | 'building' | 'packaged' | 'smoke_running' | 'passed' | 'failed' | null;
	runtime?: 'electron' | 'tauri' | null;
	package_targets?: string[];
	artifacts?: string[];
	updated_at?: string;
}

export interface JobRuntimeManifest {
	status?: 'idle' | 'collecting' | 'ready' | 'failed' | null;
	log_query?: string | null;
	incident_bundle_id?: string | null;
	updated_at?: string;
}

export interface JobApprovalManifest {
	pending?: boolean;
	reason?: string | null;
	blocked_action?: string | null;
	requested_at?: string;
	cleared_at?: string | null;
}

export interface JobAttentionManifest {
	approval?: JobApprovalManifest;
}

export interface JobWorkerManifest {
	schema_version?: 1;
	execution?: JobExecutionManifest;
	verification?: JobVerificationManifest;
	preview?: JobPreviewManifest;
	browser?: JobBrowserManifest;
	desktop?: JobDesktopManifest;
	runtime?: JobRuntimeManifest;
	attention?: JobAttentionManifest;
	dispatch_request?: DispatchRequestRecord | null;
	last_workflow_run?: JobWorkflowRunRecord | null;
	[key: string]: unknown;
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
	worker_manifest: JobWorkerManifest;
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

export interface RunSummary {
	run_id: string;
	job_id: string;
	title: string;
	status: RunAttentionStatus;
	progress_percent: number;
	last_event: string | null;
	approval_reason: string | null;
	updated_at: string;
	workflow_run_id: number | null;
	pr_number: number | null;
	preview_id: string | null;
}

export interface NotificationItem {
	id: string;
	job_id: string;
	run_id: string;
	status: RunAttentionStatus;
	title: string;
	body: string;
	source_layer: NotificationSourceLayer;
	severity: NotificationSeverity;
	created_at: string;
	linked_refs: Record<string, unknown>;
	dedupe_key: string;
}

export interface LayerLogEntry {
	id: string;
	job_id: string;
	run_id: string;
	source_layer: NotificationSourceLayer;
	level: 'info' | 'warning' | 'error';
	message: string;
	created_at: string;
	workflow_run_id: number | null;
}

export interface BlockingState {
	kind: 'none' | 'approval' | 'review' | 'failure';
	reason: string | null;
	blocked_action: string | null;
	resume_hint: string | null;
}

export interface NotificationCounts {
	idle: number;
	pending_approval: number;
	running: number;
	completed: number;
	failed: number;
}

export interface JobEventFeed {
	items: NotificationItem[];
	logs: LayerLogEntry[];
	counts: NotificationCounts;
}

export interface SelfHostHealthSnapshot {
	url: string | null;
	healthz: Record<string, unknown> | null;
}

export interface SelfHostRecentDeployRun {
	id: number | null;
	name: string | null;
	status: string | null;
	conclusion: string | null;
	html_url: string | null;
	created_at: string | null;
	head_branch: string | null;
	event: string | null;
}

export interface SelfHostStatusSnapshot {
	self_repo_key: string;
	github: {
		html_url: string | null;
		default_branch: string | null;
		pushed_at: string | null;
		open_issues_count: number | null;
	};
	workspace: Record<string, unknown> | null;
	live: SelfHostHealthSnapshot;
	mirror: SelfHostHealthSnapshot;
	deploy_strategy: {
		default_target: 'mirror' | 'live';
		require_mirror_for_live: boolean;
		mirror_distinct_from_live: boolean;
	};
	current_deploy: {
		environment: 'mirror' | 'live' | 'unknown';
		current_url: string | null;
		release_commit_sha: string | null;
	};
	workflow_allowlist: {
		global: string[];
		self_repo: string[];
		by_repo: Record<string, string[]>;
	};
	read_observability: Record<string, unknown>;
	self_deploy_workflow: string;
	recent_self_deploy_runs: SelfHostRecentDeployRun[];
	warnings: string[];
}

export interface QueueEnvelope {
	action:
		| 'job_create'
		| 'job_upsert'
		| 'job_get'
		| 'job_progress'
		| 'job_event_feed'
		| 'jobs_list'
		| 'audit_list'
		| 'audit_write'
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
	blocked_action?: string;
	attention_status?: RunAttentionStatus;
	source_layer?: NotificationSourceLayer;
	since?: string;
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
	run_summary: RunSummary;
	blocking_state: BlockingState;
	latest_notification: NotificationItem | null;
	notification_counts: NotificationCounts;
	last_transition_at: string;
	last_reconciled_at: string | null;
	last_webhook_event_at: string | null;
	updated_at: string;
}

export type UploadSessionState = 'open' | 'committing' | 'committed' | 'aborted' | 'expired';

export interface UploadSessionRecord {
	upload_id: string;
	owner: string;
	repo: string;
	branch: string;
	path: string;
	message: string;
	expected_blob_sha?: string | null;
	content_kind?: 'text' | 'binary' | null;
	mime_type?: string | null;
	total_bytes?: number | null;
	recommended_chunk_bytes: number;
	base_ref_sha: string;
	existing_blob_sha?: string | null;
	state: UploadSessionState;
	next_chunk_index: number;
	next_byte_offset: number;
	received_bytes: number;
	chunk_count: number;
	created_at: string;
	expires_at: string;
	committed_at?: string | null;
}
