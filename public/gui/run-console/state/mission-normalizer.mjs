function hasRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
	return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback = 0) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCounts(value) {
	const source = hasRecord(value) ? value : {};
	return {
		queued: asNumber(source.queued, 0),
		runnable: asNumber(source.runnable, 0),
		launched: asNumber(source.launched, 0),
		working: asNumber(source.working, 0),
		blocked: asNumber(source.blocked, 0),
		failed: asNumber(source.failed, 0),
		completed: asNumber(source.completed, 0),
		cancelled: asNumber(source.cancelled, 0),
		detached: asNumber(source.detached, 0),
	};
}

function normalizeLane(value) {
	if (!hasRecord(value)) {
		return null;
	}
	const child = hasRecord(value.child_progress) ? value.child_progress : null;
	const childSummary = hasRecord(child?.run_summary) ? child.run_summary : {};
	return {
		laneId: asString(value.lane_id, ''),
		title: asString(value.title, ''),
		role: asString(value.role, 'worker'),
		status: asString(value.status, 'queued'),
		dependsOnLaneIds: Array.isArray(value.depends_on_lane_ids) ? value.depends_on_lane_ids.map(String) : [],
		attempt: asNumber(value.attempt, 0),
		currentJobId: asString(value.current_job_id, ''),
		launchedJobIds: Array.isArray(value.launched_job_ids) ? value.launched_job_ids.map(String) : [],
		blockedReason: asString(value.blocked_reason, ''),
		lastError: asString(value.last_error, ''),
		lastEvent: asString(value.last_event, ''),
		updatedAt: asString(value.updated_at, ''),
		childProgress: child,
		childTitle: asString(childSummary.title, ''),
		childStatus: asString(childSummary.status, ''),
	};
}

export function normalizeMission(raw) {
	if (!hasRecord(raw)) {
		return null;
	}
	const progress = hasRecord(raw.progress) ? raw.progress : raw;
	const missionId = asString(progress.mission_id || raw.mission_id, '');
	if (!missionId) {
		return null;
	}
	return {
		missionId,
		repo: asString(progress.repo || raw.repo, ''),
		baseBranch: asString(progress.base_branch || raw.base_branch, ''),
		title: asString(progress.title || raw.title, missionId),
		status: asString(progress.status || raw.status, 'queued'),
		maxParallelism: asNumber(progress.max_parallelism || raw.max_parallelism, 3),
		yoloMode: Boolean(progress.yolo_mode || raw.yolo_mode),
		counts: normalizeCounts(progress.counts || raw.counts),
		lanes: (Array.isArray(progress.lanes) ? progress.lanes : []).map(normalizeLane).filter(Boolean),
		detachedJobIds: Array.isArray(progress.detached_job_ids) ? progress.detached_job_ids.map(String) : [],
		latestNotification: hasRecord(progress.latest_notification) ? progress.latest_notification : null,
		updatedAt: asString(progress.updated_at || raw.updated_at, ''),
		lastSchedulerAt: asString(progress.last_scheduler_at || raw.last_scheduler_at, ''),
		lastReconciledAt: asString(progress.last_reconciled_at || raw.last_reconciled_at, ''),
		raw: progress,
	};
}

export function mergeMissionMaps(existingMissions, rawItems) {
	const nextMissions = { ...existingMissions };
	const order = [];
	for (const item of Array.isArray(rawItems) ? rawItems : []) {
		const normalized = normalizeMission(item);
		if (!normalized) {
			continue;
		}
		nextMissions[normalized.missionId] = normalized;
		order.push(normalized.missionId);
	}
	return { missionsById: nextMissions, order };
}
