import type { JobBrowserManifest } from './browser-control';
import type {
	JobControlState,
	JobInterruptKind,
	JobResumeStrategy,
	PermissionRequestStatus,
} from './common';

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
	request_id?: string | null;
	status?: PermissionRequestStatus | null;
	reason?: string | null;
	blocked_action?: string | null;
	bundle?: Record<string, unknown> | null;
	note?: string | null;
	requested_at?: string;
	resolved_at?: string | null;
	cleared_at?: string | null;
}

export interface JobAttentionManifest {
	approval?: JobApprovalManifest;
}

export interface JobInterruptRecord {
	kind: JobInterruptKind;
	source: string;
	message?: string | null;
	recorded_at: string;
}

export interface JobControlManifest {
	state?: JobControlState | null;
	reason?: string | null;
	requested_by?: string | null;
	requested_at?: string;
	resolved_at?: string | null;
	resume_strategy?: JobResumeStrategy | null;
	last_interrupt?: JobInterruptRecord | null;
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
	control?: JobControlManifest;
	dispatch_request?: DispatchRequestRecord | null;
	last_workflow_run?: JobWorkflowRunRecord | null;
	[key: string]: unknown;
}
