import { mergeJobMaps, normalizeJob } from './job-normalizer.mjs';
import { mergeMissionMaps, normalizeMission } from './mission-normalizer.mjs';

export function createAppStore(route = {}) {
	return {
		missionsById: {},
		missionOrder: [],
		jobsById: {},
		jobOrder: [],
		selectedMissionId: route.missionId || '',
		selectedJobId: route.jobId || '',
		jobFeed: [],
		missionFeed: [],
		browserControl: null,
		bridge: null,
		error: '',
		message: '',
		loading: false,
		standaloneToken: '',
		session: {
			ready: false,
			email: null,
			authType: null,
			error: '',
		},
		auth: {
			ready: false,
			enabled: false,
			loading: false,
			error: '',
			missing: [],
			clientId: null,
			audience: null,
			scope: 'openid profile email',
			redirectUri: null,
			authorizationUrl: null,
			tokenUrl: null,
		},
	};
}

export function applyDashboard(store, payload) {
	const missionResult = mergeMissionMaps(store.missionsById, payload.missions || []);
	const jobResult = mergeJobMaps(store.jobsById, payload.jobs || []);
	store.missionsById = missionResult.missionsById;
	store.missionOrder = missionResult.order;
	store.jobsById = jobResult.jobsById;
	store.jobOrder = jobResult.order;
	if (!store.selectedMissionId && store.missionOrder.length) {
		store.selectedMissionId = store.missionOrder[0];
	}
	if (!store.selectedJobId) {
		const selectedMission = currentMission(store);
		const missionJob = selectedMission?.lanes.find((lane) => lane.currentJobId)?.currentJobId || '';
		store.selectedJobId = missionJob || store.jobOrder[0] || '';
	}
}

export function applyMissionProgress(store, payload) {
	const mission = normalizeMission(payload);
	if (!mission) {
		return null;
	}
	store.missionsById[mission.missionId] = mission;
	if (!store.missionOrder.includes(mission.missionId)) {
		store.missionOrder.unshift(mission.missionId);
	}
	for (const lane of mission.lanes) {
		if (lane.childProgress) {
			const child = normalizeJob(lane.childProgress);
			if (child) {
				store.jobsById[child.jobId] = child;
				if (!store.jobOrder.includes(child.jobId)) {
					store.jobOrder.unshift(child.jobId);
				}
			}
		}
	}
	return mission;
}

export function applyJobProgress(store, payload) {
	const job = normalizeJob(payload);
	if (!job) {
		return null;
	}
	store.jobsById[job.jobId] = job;
	if (!store.jobOrder.includes(job.jobId)) {
		store.jobOrder.unshift(job.jobId);
	}
	return job;
}

export function currentMission(store) {
	return store.selectedMissionId ? store.missionsById[store.selectedMissionId] || null : null;
}

export function currentJob(store) {
	return store.selectedJobId ? store.jobsById[store.selectedJobId] || null : null;
}

export function selectMission(store, missionId) {
	store.selectedMissionId = missionId || '';
	const mission = currentMission(store);
	const linkedJobId = mission?.lanes.find((lane) => lane.currentJobId)?.currentJobId || '';
	if (linkedJobId) {
		store.selectedJobId = linkedJobId;
	}
}

export function selectJob(store, jobId) {
	store.selectedJobId = jobId || '';
	const job = currentJob(store);
	if (job?.missionId) {
		store.selectedMissionId = job.missionId;
	}
}

export function legacyJobs(store) {
	return store.jobOrder
		.map((jobId) => store.jobsById[jobId])
		.filter(Boolean)
		.filter((job) => !job.missionId);
}

export function needsStandaloneAuth(store) {
	return Boolean(store && store.auth && store.auth.enabled && !store.session.ready);
}
