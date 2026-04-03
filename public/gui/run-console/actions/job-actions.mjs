import { applyJobProgress, selectJob } from '../state/app-store.mjs';

export async function refreshJob(store, api, jobId = store.selectedJobId) {
	if (!jobId) {
		return null;
	}
	try {
		return applyJobProgress(store, await api.loadJobProgress(jobId));
	} catch (error) {
		store.error = error instanceof Error ? error.message : String(error);
		return null;
	}
}

export async function controlJob(store, api, action, jobId = store.selectedJobId) {
	if (!jobId) {
		return null;
	}
	store.message = `Applying ${action} to ${jobId}...`;
	const job = applyJobProgress(store, await api.controlJob(jobId, action));
	selectJob(store, jobId);
	store.message = `Job ${action} applied.`;
	return job;
}

export async function resolveApproval(store, api, resolution, jobId = store.selectedJobId) {
	const job = jobId ? store.jobsById[jobId] || null : null;
	if (!job?.approval?.requestId) {
		return null;
	}
	store.message = `Recording approval ${resolution}...`;
	const progress = await api.resolveApproval(jobId, job.approval.requestId, resolution);
	store.message = `Approval ${resolution} recorded.`;
	return applyJobProgress(store, progress);
}
