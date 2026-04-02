import type { JobBrowserRemoteControlState } from './browser-control';
import type {
	JobControlState,
	JobInterruptKind,
	JobStatus,
	NextActor,
	NotificationSeverity,
	NotificationSourceLayer,
	ReviewFinding,
	ReviewVerdict,
	RunAttentionStatus,
} from './common';
import type { AuditRecord } from './queue';
import type { JobApprovalManifest, JobControlManifest, JobWorkerManifest } from './workflow';

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

export interface RunnableDiagnostics {
	runnable: boolean;
	idle_reason: string | null;
	missing_requirements: string[];
	missing_capabilities: string[];
}

export interface RunSummary {
	run_id: string;
	job_id: string;
	title: string;
	status: RunAttentionStatus;
	runnable: boolean;
	idle_reason: string | null;
	missing_requirements: string[];
	missing_capabilities: string[];
	progress_percent: number;
	last_event: string | null;
	approval_reason: string | null;
	updated_at: string;
	workflow_run_id: number | null;
	pr_number: number | null;
	preview_id: string | null;
	control_state: JobControlState | null;
	interrupt_kind: JobInterruptKind | null;
	interrupt_message: string | null;
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
	kind: 'none' | 'approval' | 'review' | 'failure' | 'paused' | 'cancelled' | 'interrupted';
	reason: string | null;
	blocked_action: string | null;
	resume_hint: string | null;
}

export interface NotificationCounts {
	idle: number;
	pending_approval: number;
	running: number;
	paused: number;
	cancelled: number;
	interrupted: number;
	completed: number;
	failed: number;
}

export interface JobEventFeed {
	items: NotificationItem[];
	logs: LayerLogEntry[];
	counts: NotificationCounts;
}

export interface JobProgressSnapshot {
	job_id: string;
	repo: string;
	status: JobStatus;
	next_actor: NextActor;
	runnable: boolean;
	idle_reason: string | null;
	missing_requirements: string[];
	missing_capabilities: string[];
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
	control_state: JobControlManifest | null;
	approval_request: JobApprovalManifest | null;
	browser_control: JobBrowserRemoteControlState | null;
	last_transition_at: string;
	last_reconciled_at: string | null;
	last_webhook_event_at: string | null;
	updated_at: string;
}
