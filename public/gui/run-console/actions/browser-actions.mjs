export async function refreshBrowserControl(store, api) {
	try {
		store.browserControl = await api.loadBrowserControl();
	} catch (error) {
		store.error = error instanceof Error ? error.message : String(error);
	}
	return store.browserControl;
}

export async function queueBrowserCommand(store, api, kind, extras = {}, jobId = store.selectedJobId) {
	if (!jobId) {
		return null;
	}
	store.message = `Queueing ${kind} for ${jobId}...`;
	try {
		store.browserControl = await api.queueBrowserCommand(jobId, kind, extras);
		store.message = `${kind} queued for ${jobId}.`;
		return store.browserControl;
	} catch (error) {
		store.error = error instanceof Error ? error.message : String(error);
		return null;
	}
}
