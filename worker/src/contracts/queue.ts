import type {
	JobControlAction,
	JobControlState,
	JobResumeStrategy,
	JobStatus,
	NextActor,
	NotificationSourceLayer,
	PermissionResolution,
	ReviewFinding,
	ReviewVerdict,
	RunAttentionStatus,
} from './common';
import type { JobProgressSnapshot, JobRecord } from './job';

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
		| 'job_control'
		| 'job_update_status'
		| 'job_append_note'
		| 'permission_request_resolve'
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
	control_action?: JobControlAction;
	note?: string;
	reason?: string;
	resume_strategy?: JobResumeStrategy;
	expected_state?: JobControlState | RunAttentionStatus | null;
	request_id?: string;
	resolution?: PermissionResolution;
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

export type QueueProjection = { progress: JobProgressSnapshot };
