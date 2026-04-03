import { buildModelContextText } from '../../bridge-core.mjs';

function hasRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function syncModelContext(bridge, store) {
	if (!bridge || !bridge.isConnected() || !bridge.supports('ui/update-model-context')) {
		return;
	}
	const job = store.selectedJobId ? store.jobsById[store.selectedJobId] || null : null;
	const mission = store.selectedMissionId ? store.missionsById[store.selectedMissionId] || null : null;
	const structuredContent = {
		kind: 'opengpt.run_console.context',
		mission_id: mission?.missionId || null,
		mission_status: mission?.status || null,
		job_id: job?.jobId || null,
		job_status: job?.status || null,
		repo: mission?.repo || job?.repo || null,
		yolo_mode: mission?.yoloMode || false,
	};
	const text =
		job && hasRecord(job.raw)
			? buildModelContextText({
				job_id: job.jobId,
				repo: job.repo,
				run_summary: hasRecord(job.raw.run_summary) ? job.raw.run_summary : job.raw.run_summary || {},
				blocking_state: job.raw.blocking_state || null,
				latest_notification: job.raw.latest_notification || null,
				permission_bundle: null,
				host: { display_mode: 'inline' },
			})
			: `Mission ${mission?.title || 'unselected'} is ${mission?.status || 'idle'}.`;
	await bridge.updateModelContext({
		structuredContent,
		content: [{ type: 'text', text }],
	});
}
