import { GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY, normalizeBrowserRemoteControl } from '../browser-remote-control';

export function createBrowserActions(helpers: any) {
	const getBrowserRemoteControlState = async () => {
		return normalizeBrowserRemoteControl(await helpers.getStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY));
	};

	const persistBrowserRemoteControlState = async (value: unknown) => {
		const normalized = normalizeBrowserRemoteControl(value);
		if (!normalized) {
			await helpers.deleteStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY);
			return null;
		}
		await helpers.putStorageValue(GLOBAL_BROWSER_REMOTE_CONTROL_STORAGE_KEY, normalized);
		return normalized;
	};

	return {
		getBrowserRemoteControlState,
		persistBrowserRemoteControlState,
	};
}
