function hasRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
	return Array.isArray(value) ? value : [];
}

function coerceRunStatus(value) {
	return ['idle', 'pending_approval', 'running', 'completed', 'failed'].includes(value) ? value : 'idle';
}

function coerceSeverity(value) {
	if (value === 'warning') return 'warn';
	if (value === 'error') return 'error';
	return 'info';
}

function coerceLevel(value) {
	if (value === 'warning') return 'warn';
	if (value === 'warn') return 'warn';
	if (value === 'error') return 'error';
	return 'info';
}

function coerceNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampProgress(value) {
	const numeric = coerceNumber(value);
	if (numeric == null) return 0;
	return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeBlockingState(value) {
	if (!hasRecord(value)) return null;
	return {
		kind: typeof value.kind === 'string' ? value.kind : 'none',
		reason: typeof value.reason === 'string' ? value.reason : '',
		blockedAction: typeof value.blocked_action === 'string' ? value.blocked_action : '',
		resumeHint: typeof value.resume_hint === 'string' ? value.resume_hint : '',
	};
}

function normalizeLinkedRefs(value) {
	return hasRecord(value) ? value : {};
}

function normalizeNotification(item, fallback = {}) {
	if (!hasRecord(item)) return null;
	const runId =
		typeof item.run_id === 'string'
			? item.run_id
			: typeof fallback.runId === 'string'
				? fallback.runId
				: typeof item.job_id === 'string'
					? item.job_id
					: 'system';
	const jobId =
		typeof item.job_id === 'string'
			? item.job_id
			: typeof fallback.jobId === 'string'
				? fallback.jobId
				: runId;
	return {
		id: typeof item.id === 'string' ? item.id : `${runId}:${item.status || 'system'}:${item.created_at || 'now'}`,
		runId,
		jobId,
		type: typeof item.status === 'string' ? coerceRunStatus(item.status) : 'system',
		title: typeof item.title === 'string' && item.title ? item.title : 'Notification',
		body: typeof item.body === 'string' ? item.body : '',
		sourceLayer:
			typeof item.source_layer === 'string' && ['gpt', 'mcp', 'cloudflare', 'repo', 'system'].includes(item.source_layer)
				? item.source_layer
				: 'system',
		severity: coerceSeverity(item.severity),
		createdAt: typeof item.created_at === 'string' ? item.created_at : '',
		linkedRefs: normalizeLinkedRefs(item.linked_refs),
		dedupeKey: typeof item.dedupe_key === 'string' ? item.dedupe_key : '',
		raw: item,
	};
}

function normalizeLogEntry(entry, fallback = {}) {
	if (!hasRecord(entry)) return null;
	const runId =
		typeof entry.run_id === 'string'
			? entry.run_id
			: typeof fallback.runId === 'string'
				? fallback.runId
				: typeof entry.job_id === 'string'
					? entry.job_id
					: 'system';
	const jobId =
		typeof entry.job_id === 'string'
			? entry.job_id
			: typeof fallback.jobId === 'string'
				? fallback.jobId
				: runId;
	return {
		id: typeof entry.id === 'string' ? entry.id : `${runId}:${entry.source_layer || 'system'}:${entry.created_at || 'now'}`,
		runId,
		jobId,
		source:
			typeof entry.source_layer === 'string' && ['gpt', 'mcp', 'cloudflare', 'repo', 'system'].includes(entry.source_layer)
				? entry.source_layer
				: 'system',
		level: coerceLevel(entry.level),
		message: typeof entry.message === 'string' ? entry.message : '',
		ts: typeof entry.created_at === 'string' ? entry.created_at : '',
		raw: entry,
	};
}

function normalizeRunRecord(job, fallback = {}) {
	if (!hasRecord(job)) return null;
	const summary = hasRecord(job.run_summary) ? job.run_summary : {};
	const latestNotification = normalizeNotification(job.latest_notification, {
		jobId: typeof job.job_id === 'string' ? job.job_id : fallback.jobId,
		runId: typeof summary.run_id === 'string' ? summary.run_id : fallback.runId,
	});
	const runId =
		typeof summary.run_id === 'string'
			? summary.run_id
			: typeof job.job_id === 'string'
				? job.job_id
				: typeof fallback.runId === 'string'
					? fallback.runId
					: 'run';
	const jobId =
		typeof job.job_id === 'string'
			? job.job_id
			: typeof summary.job_id === 'string'
				? summary.job_id
				: typeof fallback.jobId === 'string'
					? fallback.jobId
					: runId;
	const title =
		typeof summary.title === 'string' && summary.title
			? summary.title
			: latestNotification && latestNotification.title
				? latestNotification.title
				: jobId;
	const summaryText =
		typeof summary.last_event === 'string' && summary.last_event
			? summary.last_event
			: latestNotification && latestNotification.body
				? latestNotification.body
				: 'No run summary available.';
	return {
		runId,
		jobId,
		repo: typeof job.repo === 'string' ? job.repo : typeof fallback.repo === 'string' ? fallback.repo : '',
		title,
		summary: summaryText,
		status: coerceRunStatus(summary.status || latestNotification?.type),
		progress: clampProgress(summary.progress_percent),
		lastEvent: typeof summary.last_event === 'string' ? summary.last_event : '',
		approvalReason: typeof summary.approval_reason === 'string' ? summary.approval_reason : null,
		updatedAt:
			typeof summary.updated_at === 'string'
				? summary.updated_at
				: latestNotification && latestNotification.createdAt
					? latestNotification.createdAt
					: '',
		workflowRunId: coerceNumber(summary.workflow_run_id ?? job.workflow_run_id),
		prNumber: coerceNumber(summary.pr_number ?? job.pr_number),
		nextActor:
			typeof job.next_actor === 'string' && ['worker', 'reviewer', 'system'].includes(job.next_actor)
				? job.next_actor
				: undefined,
		blockingState: normalizeBlockingState(job.blocking_state),
		logs: [],
		raw: job,
	};
}

function normalizeSeedRunRecord(options = {}) {
	const summary = hasRecord(options.cachedRunSummary) ? options.cachedRunSummary : {};
	if (!Object.keys(summary).length) return null;
	const blocker = normalizeBlockingState(options.cachedBlockingState);
	const runId =
		typeof summary.run_id === 'string'
			? summary.run_id
			: typeof options.selectedJobId === 'string' && options.selectedJobId
				? options.selectedJobId
				: 'run';
	const jobId =
		typeof summary.job_id === 'string'
			? summary.job_id
			: typeof options.selectedJobId === 'string' && options.selectedJobId
				? options.selectedJobId
				: runId;
	return {
		runId,
		jobId,
		repo: typeof options.cachedRepoKey === 'string' ? options.cachedRepoKey : '',
		title: typeof summary.title === 'string' && summary.title ? summary.title : jobId,
		summary: typeof summary.last_event === 'string' && summary.last_event ? summary.last_event : 'No run summary available.',
		status: coerceRunStatus(summary.status),
		progress: clampProgress(summary.progress_percent),
		lastEvent: typeof summary.last_event === 'string' ? summary.last_event : '',
		approvalReason: typeof summary.approval_reason === 'string' ? summary.approval_reason : null,
		updatedAt: typeof summary.updated_at === 'string' ? summary.updated_at : '',
		workflowRunId: coerceNumber(summary.workflow_run_id),
		prNumber: coerceNumber(summary.pr_number),
		nextActor: undefined,
		blockingState: blocker,
		logs: [],
		raw: summary,
	};
}

function normalizeCounts(value, notifications) {
	if (hasRecord(value)) {
		return {
			idle: Number(value.idle || 0),
			pending_approval: Number(value.pending_approval || 0),
			running: Number(value.running || 0),
			completed: Number(value.completed || 0),
			failed: Number(value.failed || 0),
		};
	}
	const counts = {
		idle: 0,
		pending_approval: 0,
		running: 0,
		completed: 0,
		failed: 0,
	};
	for (const item of notifications) {
		if (!item || item.type === 'system') continue;
		counts[item.type] += 1;
	}
	return counts;
}

function normalizeHostStatus(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.self_host_status') return null;
	return {
		selfRepoKey: typeof value.self_repo_key === 'string' ? value.self_repo_key : '',
		github: hasRecord(value.github) ? value.github : {},
		workspace: hasRecord(value.workspace) ? value.workspace : null,
		live: hasRecord(value.live) ? value.live : null,
		mirror: hasRecord(value.mirror) ? value.mirror : null,
		deployStrategy: hasRecord(value.deploy_strategy) ? value.deploy_strategy : {},
		currentDeploy: hasRecord(value.current_deploy) ? value.current_deploy : {},
		workflowAllowlist: hasRecord(value.workflow_allowlist) ? value.workflow_allowlist : {},
		readObservability: hasRecord(value.read_observability) ? value.read_observability : {},
		selfDeployWorkflow: typeof value.self_deploy_workflow === 'string' ? value.self_deploy_workflow : '',
		recentRuns: toArray(value.recent_self_deploy_runs),
		warnings: toArray(value.warnings).map((item) => String(item)),
		raw: value,
	};
}

function normalizeRepoBundle(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.incident_bundle') return null;
	return {
		bundleId: typeof value.bundle_id === 'string' ? value.bundle_id : '',
		repo: typeof value.repo === 'string' ? value.repo : '',
		scope: typeof value.scope === 'string' ? value.scope : 'job',
		summary: hasRecord(value.summary) ? value.summary : null,
		artifacts: toArray(value.artifacts),
		preview: hasRecord(value.preview) ? value.preview : null,
		browser: hasRecord(value.browser) ? value.browser : null,
		runs: toArray(value.runs),
		layerLogs: toArray(value.layer_logs),
		errorLogs: toArray(value.error_logs),
		raw: value,
	};
}

function normalizePermissionBundle(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.permission_bundle') return null;
	return {
		status: typeof value.status === 'string' ? value.status : '',
		bundle: hasRecord(value.bundle) ? value.bundle : {},
		notification: normalizeNotification(value.notification),
		raw: value,
	};
}

function attachLogsToRuns(runs, logs) {
	const byRunId = new Map();
	for (const run of runs) {
		byRunId.set(run.runId, run);
	}
	for (const log of logs) {
		const run = byRunId.get(log.runId) || byRunId.get(log.jobId);
		if (run) {
			run.logs.push(log);
		}
	}
}

export function normalizeNotificationToolState(structuredContent, meta, options = {}) {
	const widgetMeta =
		hasRecord(meta) && hasRecord(meta['opengpt/widget']) && hasRecord(meta['opengpt/widget'].data)
			? meta['opengpt/widget'].data
			: null;
	const source = hasRecord(structuredContent) ? structuredContent : widgetMeta;
	const model = {
		kind: hasRecord(source) && typeof source.kind === 'string' ? source.kind : null,
		runs: [],
		notifications: [],
		logs: [],
		counts: null,
		hostStatus: normalizeHostStatus(source),
		permissionBundle: normalizePermissionBundle(source),
		repoBundle: normalizeRepoBundle(source),
		meta: hasRecord(meta) ? meta : null,
		raw: source,
	};

	if (!hasRecord(source)) {
		return model;
	}

	if (source.kind === 'opengpt.notification_contract.jobs_list') {
		model.runs = toArray(source.jobs)
			.map((job) => normalizeRunRecord(job))
			.filter(Boolean);
		model.notifications = model.runs
			.map((run) => normalizeNotification(run.raw.latest_notification, { jobId: run.jobId, runId: run.runId }))
			.filter(Boolean);
		model.counts = normalizeCounts(source.notification_counts, model.notifications);
	}

	if (source.kind === 'opengpt.notification_contract.job_progress') {
		const progress = hasRecord(source.progress) ? source.progress : {};
		const run = normalizeRunRecord(
			{
				job_id: progress.job_id,
				repo: progress.repo,
				next_actor: progress.next_actor,
				run_summary: source.run_summary || progress.run_summary,
				blocking_state: source.blocking_state || progress.blocking_state,
				latest_notification: source.latest_notification || progress.latest_notification,
			},
			{ repo: progress.repo, jobId: progress.job_id },
		);
		model.runs = run ? [run] : [];
		model.notifications = [normalizeNotification(source.latest_notification || progress.latest_notification, { jobId: progress.job_id, runId: run?.runId })].filter(Boolean);
		model.counts = normalizeCounts(source.notification_counts || progress.notification_counts, model.notifications);
	}

	if (source.kind === 'opengpt.notification_contract.job_event_feed') {
		model.notifications = toArray(source.items)
			.map((item) => normalizeNotification(item, { jobId: options.selectedJobId }))
			.filter(Boolean);
		model.logs = toArray(source.logs)
			.map((entry) => normalizeLogEntry(entry, { jobId: options.selectedJobId }))
			.filter(Boolean);
		model.counts = normalizeCounts(source.counts, model.notifications);
	}

	if (source.kind === 'opengpt.notification_contract.incident_bundle') {
		model.runs = toArray(source.runs)
			.map((job) => normalizeRunRecord(job))
			.filter(Boolean);
		model.logs = [
			...toArray(source.layer_logs).map((entry) => normalizeLogEntry(entry)).filter(Boolean),
			...toArray(source.error_logs)
				.map((entry, index) =>
					normalizeLogEntry(
						hasRecord(entry)
							? entry
							: {
									id: `error-${index}`,
									level: 'error',
									message: String(entry),
									source_layer: 'system',
							  },
					),
				)
				.filter(Boolean),
		];
		model.notifications = model.runs
			.map((run) => normalizeNotification(run.raw.latest_notification, { jobId: run.jobId, runId: run.runId }))
			.filter(Boolean);
		model.counts = normalizeCounts(source.notification_counts, model.notifications);
	}

	if (source.kind === 'opengpt.notification_contract.permission_bundle') {
		model.notifications = [normalizeNotification(source.notification, { jobId: options.selectedJobId })].filter(Boolean);
		model.counts = normalizeCounts(source.notification_counts, model.notifications);
	}

	if (!model.runs.length) {
		const seedRun = normalizeSeedRunRecord(options);
		if (seedRun) model.runs = [seedRun];
	}

	if (!model.notifications.length && model.runs.length) {
		const fallbackRun = model.runs[0];
		if (fallbackRun.blockingState && fallbackRun.blockingState.kind === 'approval') {
			model.notifications = [
				{
					id: `${fallbackRun.runId}:approval`,
					runId: fallbackRun.runId,
					jobId: fallbackRun.jobId,
					type: 'pending_approval',
					title: 'Approval pending',
					body: fallbackRun.blockingState.reason || fallbackRun.summary,
					sourceLayer: 'system',
					severity: 'warn',
					createdAt: fallbackRun.updatedAt || '',
					linkedRefs: {},
					dedupeKey: `${fallbackRun.runId}:approval`,
					raw: fallbackRun.raw,
				},
			];
		}
	}

	if (!model.counts) {
		model.counts = normalizeCounts(null, model.notifications);
	}

	attachLogsToRuns(model.runs, model.logs);
	return model;
}
