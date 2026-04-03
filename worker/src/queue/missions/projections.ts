import type {
	JobEventFeed,
	JobProgressSnapshot,
	MissionEventFeed,
	MissionLaneCounts,
	MissionLaneProgressSnapshot,
	MissionLaneRecord,
	MissionProgressSnapshot,
	MissionRecord,
	NotificationItem,
} from '../../contracts';

export function createEmptyMissionLaneCounts(): MissionLaneCounts {
	return {
		queued: 0,
		runnable: 0,
		launched: 0,
		working: 0,
		blocked: 0,
		failed: 0,
		completed: 0,
		cancelled: 0,
		detached: 0,
	};
}

export function countMissionLanes(lanes: Array<{ status: MissionLaneRecord['status'] }>): MissionLaneCounts {
	const counts = createEmptyMissionLaneCounts();
	for (const lane of lanes) {
		counts[lane.status] += 1;
	}
	return counts;
}

export function aggregateMissionStatus(mission: MissionRecord): MissionRecord['status'] {
	const counts = countMissionLanes(mission.lanes);
	if (mission.lanes.length > 0 && counts.completed === mission.lanes.length) {
		return 'completed';
	}
	if (counts.cancelled > 0 && counts.cancelled + counts.completed === mission.lanes.length) {
		return 'cancelled';
	}
	if (counts.failed > 0) {
		return 'failed';
	}
	if (counts.blocked > 0) {
		return 'blocked';
	}
	if (counts.working > 0 || counts.launched > 0 || counts.runnable > 0) {
		return 'running';
	}
	return 'queued';
}

function laneProgressSnapshot(
	lane: MissionLaneRecord,
	childProgress: JobProgressSnapshot | null,
): MissionLaneProgressSnapshot {
	return {
		lane_id: lane.lane_id,
		title: lane.title,
		role: lane.role,
		status: lane.status,
		depends_on_lane_ids: lane.depends_on_lane_ids,
		attempt: lane.attempt,
		current_job_id: lane.current_job_id ?? null,
		launched_job_ids: lane.launched_job_ids,
		last_error: lane.last_error ?? null,
		blocked_reason: lane.blocked_reason ?? null,
		last_event: lane.last_event ?? null,
		summary: lane.summary ?? null,
		updated_at: lane.updated_at,
		child_progress: childProgress,
	};
}

export function buildMissionProgressSnapshot(
	mission: MissionRecord,
	childProgressByJobId: Map<string, JobProgressSnapshot>,
	latestNotification: NotificationItem | null,
): MissionProgressSnapshot {
	const lanes = mission.lanes.map((lane) =>
		laneProgressSnapshot(lane, lane.current_job_id ? childProgressByJobId.get(lane.current_job_id) ?? null : null),
	);
	return {
		mission_id: mission.mission_id,
		repo: mission.repo,
		base_branch: mission.base_branch,
		title: mission.title,
		status: mission.status,
		max_parallelism: mission.max_parallelism,
		yolo_mode: mission.yolo_mode,
		counts: countMissionLanes(mission.lanes),
		lanes,
		detached_job_ids: mission.detached_job_ids,
		latest_notification: latestNotification,
		last_scheduler_at: mission.last_scheduler_at ?? null,
		last_reconciled_at: mission.last_reconciled_at ?? null,
		created_at: mission.created_at,
		updated_at: mission.updated_at,
	};
}

function normalizeFeedItems(feeds: JobEventFeed[]): { items: JobEventFeed['items']; logs: JobEventFeed['logs'] } {
	const items = feeds.flatMap((feed) => feed.items);
	const logs = feeds.flatMap((feed) => feed.logs);
	items.sort((left, right) => right.created_at.localeCompare(left.created_at));
	logs.sort((left, right) => right.created_at.localeCompare(left.created_at));
	return { items, logs };
}

export function buildMissionEventFeed(
	mission: MissionRecord,
	laneFeeds: Array<{ lane_id: string; feed: JobEventFeed }>,
): MissionEventFeed {
	const normalized = normalizeFeedItems(laneFeeds.map((entry) => entry.feed));
	return {
		mission_id: mission.mission_id,
		items: normalized.items.slice(0, 200),
		logs: normalized.logs.slice(0, 200),
		counts: countMissionLanes(mission.lanes),
	};
}
