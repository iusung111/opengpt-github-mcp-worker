export type JobStatus = 'queued' | 'working' | 'review_pending' | 'rework_pending' | 'done' | 'failed';
export type NextActor = 'worker' | 'reviewer' | 'system';
export type MissionStatus = 'queued' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type MissionLaneState =
	| 'queued'
	| 'runnable'
	| 'launched'
	| 'working'
	| 'blocked'
	| 'failed'
	| 'completed'
	| 'cancelled'
	| 'detached';
export type MissionLaneRole = 'planner' | 'worker' | 'reviewer' | 'verifier' | 'observer' | 'custom';
export type MissionControlAction =
	| 'pause'
	| 'resume'
	| 'cancel'
	| 'retry_failed'
	| 'reconcile'
	| 'enable_yolo'
	| 'disable_yolo';
export type ReviewVerdict = 'approved' | 'changes_requested' | 'blocked';
export type JobControlState = 'active' | 'paused' | 'cancelled';
export type JobControlAction = 'pause' | 'resume' | 'cancel' | 'retry';
export type JobResumeStrategy = 'refresh' | 'redispatch';
export type PermissionRequestStatus = 'drafted' | 'requested' | 'approved' | 'rejected' | 'superseded' | 'expired';
export type PermissionResolution = 'approved' | 'rejected' | 'superseded';
export type JobInterruptKind =
	| 'approval_rejected'
	| 'approval_superseded'
	| 'approval_expired'
	| 'host_cancelled'
	| 'tool_timeout'
	| 'workflow_cancelled'
	| 'workflow_timed_out'
	| 'stale_reconcile';
export type RunAttentionStatus =
	| 'idle'
	| 'pending_approval'
	| 'running'
	| 'paused'
	| 'cancelled'
	| 'interrupted'
	| 'completed'
	| 'failed';
export type NotificationSourceLayer = 'gpt' | 'mcp' | 'cloudflare' | 'repo' | 'system';
export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface ReviewFinding {
	severity: 'low' | 'medium' | 'high' | 'critical';
	file: string;
	line_hint?: string;
	summary: string;
	rationale: string;
	required_fix?: string;
}
