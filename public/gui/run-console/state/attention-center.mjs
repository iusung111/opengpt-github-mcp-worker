const ACTIONABLE_JOB_STATUSES = new Set(['pending_approval', 'failed', 'interrupted', 'paused', 'running']);
const ACTIONABLE_MISSION_STATUSES = new Set(['blocked', 'failed', 'working', 'detached']);

function asTime(value) {
	const time = new Date(value || '').getTime();
	return Number.isFinite(time) ? time : 0;
}

function hiddenSmokeJob(job) {
	if (!job || !/^smoke-[A-Za-z0-9._-]+$/i.test(job.jobId || '')) {
		return false;
	}
	return Array.isArray(job.targetPaths) && job.targetPaths.length > 0
		? job.targetPaths.every((path) => /^notes\/smoke-[A-Za-z0-9._-]+\.txt$/i.test(String(path)))
		: false;
}

function hiddenGuiApprovalJob(job) {
	const title = String(job?.title || '').toLowerCase();
	const operationType = String(job?.operationType || '').toLowerCase();
	return title.startsWith('gui_approval_test') || operationType.startsWith('gui_approval_test');
}

export function isHiddenConsoleJob(job) {
	return hiddenSmokeJob(job) || hiddenGuiApprovalJob(job);
}

export function visibleLegacyJobs(store) {
	return (store?.jobOrder || [])
		.map((jobId) => store.jobsById[jobId])
		.filter(Boolean)
		.filter((job) => !job.missionId && !isHiddenConsoleJob(job));
}

export function yoloAllEnabled(store) {
	const missions = (store?.missionOrder || []).map((missionId) => store.missionsById[missionId]).filter(Boolean);
	return missions.length > 0 && missions.every((mission) => mission.yoloMode);
}

export function buildAttentionItems(store) {
	const missionItems = (store?.missionOrder || [])
		.map((missionId) => store.missionsById[missionId])
		.filter(Boolean)
		.filter((mission) => ACTIONABLE_MISSION_STATUSES.has(mission.status) || mission.latestNotification)
		.map((mission) => ({
			id: `mission:${mission.missionId}`,
			kind: 'mission',
			title: mission.title || mission.missionId,
			body:
				mission.latestNotification?.body ||
				`Mission ${mission.status}. blocked ${mission.counts.blocked}, failed ${mission.counts.failed}.`,
			status: mission.status,
			updatedAt: mission.latestNotification?.created_at || mission.updatedAt,
			missionId: mission.missionId,
			jobId: '',
		}));

	const jobItems = (store?.jobOrder || [])
		.map((jobId) => store.jobsById[jobId])
		.filter(Boolean)
		.filter((job) => !isHiddenConsoleJob(job))
		.filter((job) => ACTIONABLE_JOB_STATUSES.has(job.status) || job.approval?.pending)
		.map((job) => ({
			id: `job:${job.jobId}`,
			kind: 'job',
			title: job.title || job.jobId,
			body: job.approval?.reason || job.lastEvent || `${job.status} for ${job.repo || job.jobId}`,
			status: job.status,
			updatedAt: job.updatedAt,
			missionId: job.missionId || '',
			jobId: job.jobId,
		}));

	return [...missionItems, ...jobItems].sort((left, right) => asTime(right.updatedAt) - asTime(left.updatedAt));
}
