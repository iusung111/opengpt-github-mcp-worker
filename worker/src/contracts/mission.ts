import type {
	LayerLogEntry,
	NotificationItem,
	JobProgressSnapshot,
} from './job';
import type {
	MissionControlAction,
	MissionLaneRole,
	MissionLaneState,
	MissionStatus,
} from './common';

export interface MissionLaneRecord {
	lane_id: string;
	title: string;
	role: MissionLaneRole;
	status: MissionLaneState;
	depends_on_lane_ids: string[];
	attempt: number;
	current_job_id?: string | null;
	launched_job_ids: string[];
	spawn_token?: string | null;
	last_error?: string | null;
	blocked_reason?: string | null;
	last_event?: string | null;
	summary?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	updated_at: string;
}

export interface MissionRecord {
	mission_id: string;
	repo: string;
	base_branch: string;
	title: string;
	operation_type?: string;
	target_paths: string[];
	status: MissionStatus;
	max_parallelism: number;
	yolo_mode: boolean;
	lanes: MissionLaneRecord[];
	detached_job_ids: string[];
	notes: string[];
	created_at: string;
	updated_at: string;
	last_scheduler_at?: string | null;
	last_reconciled_at?: string | null;
}

export interface MissionLaneCounts {
	queued: number;
	runnable: number;
	launched: number;
	working: number;
	blocked: number;
	failed: number;
	completed: number;
	cancelled: number;
	detached: number;
}

export interface MissionLaneProgressSnapshot {
	lane_id: string;
	title: string;
	role: MissionLaneRole;
	status: MissionLaneState;
	depends_on_lane_ids: string[];
	attempt: number;
	current_job_id: string | null;
	launched_job_ids: string[];
	last_error: string | null;
	blocked_reason: string | null;
	last_event: string | null;
	summary: string | null;
	updated_at: string;
	child_progress: JobProgressSnapshot | null;
}

export interface MissionProgressSnapshot {
	mission_id: string;
	repo: string;
	base_branch: string;
	title: string;
	status: MissionStatus;
	max_parallelism: number;
	yolo_mode: boolean;
	counts: MissionLaneCounts;
	lanes: MissionLaneProgressSnapshot[];
	detached_job_ids: string[];
	latest_notification: NotificationItem | null;
	last_scheduler_at: string | null;
	last_reconciled_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface MissionEventFeed {
	mission_id: string;
	items: NotificationItem[];
	logs: LayerLogEntry[];
	counts: MissionLaneCounts;
}

export interface MissionControlResult {
	mission_id: string;
	action: MissionControlAction;
	progress: MissionProgressSnapshot;
}
