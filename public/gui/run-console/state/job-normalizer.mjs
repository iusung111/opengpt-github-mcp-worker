function hasRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
	return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback = 0) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeApproval(value) {
	if (!hasRecord(value)) {
		return null;
	}
	return {
		pending: Boolean(value.pending),
		requestId: asString(value.request_id, ''),
		status: asString(value.status, ''),
		reason: asString(value.reason, ''),
		blockedAction: asString(value.blocked_action, ''),
		requestedAt: asString(value.requested_at, ''),
	};
}

function normalizeControl(value) {
	if (!hasRecord(value)) {
		return null;
	}
	return {
		state: asString(value.state, ''),
		reason: asString(value.reason, ''),
		resumeStrategy: asString(value.resume_strategy, ''),
	};
}

function normalizeBlocking(value) {
	if (!hasRecord(value)) {
		return null;
	}
	return {
		kind: asString(value.kind, 'none'),
		reason: asString(value.reason, ''),
		blockedAction: asString(value.blocked_action, ''),
	};
}

export function normalizeJob(raw) {
	if (!hasRecord(raw)) {
		return null;
	}
	const progress = hasRecord(raw.progress) ? raw.progress : raw;
	const summary = hasRecord(progress.run_summary) ? progress.run_summary : hasRecord(raw.run_summary) ? raw.run_summary : {};
	const jobId = asString(progress.job_id || raw.job_id || summary.job_id, '');
	if (!jobId) {
		return null;
	}
	return {
		jobId,
		missionId: asString(progress.mission_id || raw.mission_id, ''),
		laneId: asString(progress.lane_id || raw.lane_id, ''),
		operationType: asString(progress.operation_type || raw.operation_type, ''),
		title: asString(summary.title, jobId),
		repo: asString(progress.repo || raw.repo, ''),
		targetPaths: Array.isArray(progress.target_paths || raw.target_paths) ? (progress.target_paths || raw.target_paths).map(String) : [],
		status: asString(summary.status, 'idle'),
		nextActor: asString(progress.next_actor || raw.next_actor, ''),
		progressPercent: asNumber(summary.progress_percent, 0),
		lastEvent: asString(summary.last_event, ''),
		updatedAt: asString(summary.updated_at || progress.updated_at || raw.updated_at, ''),
		workflowRunId: asNumber(summary.workflow_run_id, 0),
		prNumber: asNumber(summary.pr_number, 0),
		approval: normalizeApproval(progress.approval_request || raw.approval_request),
		control: normalizeControl(progress.control_state || raw.control_state),
		blocking: normalizeBlocking(progress.blocking_state || raw.blocking_state),
		latestNotification: hasRecord(progress.latest_notification || raw.latest_notification) ? (progress.latest_notification || raw.latest_notification) : null,
		browserControl: hasRecord(progress.browser_control || raw.browser_control) ? (progress.browser_control || raw.browser_control) : null,
		raw: progress,
	};
}

export function mergeJobMaps(existingJobs, rawItems) {
	const nextJobs = { ...existingJobs };
	const order = [];
	for (const item of Array.isArray(rawItems) ? rawItems : []) {
		const normalized = normalizeJob(item);
		if (!normalized) {
			continue;
		}
		nextJobs[normalized.jobId] = normalized;
		order.push(normalized.jobId);
	}
	return { jobsById: nextJobs, order };
}
