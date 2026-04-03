import { applyDashboard, applyMissionProgress, selectMission } from '../state/app-store.mjs';
import { yoloAllEnabled } from '../state/attention-center.mjs';

export async function refreshDashboard(store, api) {
	store.loading = true;
	store.error = '';
	try {
		applyDashboard(store, await api.loadDashboard());
	} catch (error) {
		store.error = error instanceof Error ? error.message : String(error);
	} finally {
		store.loading = false;
	}
}

export async function refreshMission(store, api, missionId = store.selectedMissionId) {
	if (!missionId) {
		return null;
	}
	try {
		return applyMissionProgress(store, await api.loadMissionProgress(missionId));
	} catch (error) {
		store.error = error instanceof Error ? error.message : String(error);
		return null;
	}
}

export async function controlMission(store, api, action, missionId = store.selectedMissionId) {
	if (!missionId) {
		return null;
	}
	store.message = `Applying ${action} to mission ${missionId}...`;
	const mission = applyMissionProgress(store, await api.controlMission(missionId, action));
	selectMission(store, missionId);
	store.message = `Mission ${action} applied.`;
	return mission;
}

export async function toggleYoloAll(store, api) {
	const enable = !yoloAllEnabled(store);
	const action = enable ? 'enable_yolo' : 'disable_yolo';
	const missionIds = store.missionOrder.slice();
	if (!missionIds.length) {
		return [];
	}
	store.message = `${enable ? 'Enabling' : 'Disabling'} YOLO for all missions...`;
	const results = [];
	for (const missionId of missionIds) {
		const progress = await api.controlMission(missionId, action);
		const mission = applyMissionProgress(store, progress);
		if (mission) {
			results.push(mission);
		}
	}
	selectMission(store, store.selectedMissionId || missionIds[0]);
	store.message = `${enable ? 'Enabled' : 'Disabled'} YOLO for ${missionIds.length} mission${missionIds.length === 1 ? '' : 's'}.`;
	return results;
}
