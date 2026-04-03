import { applyMissionProgress, applyDashboard, selectMission } from '../state/app-store.mjs';

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
