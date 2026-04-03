export const root = document.getElementById('notification-app');

if (!root) {
	throw new Error('notification root missing');
}

export const config = window.__OPENGPT_GUI_CONFIG__ || {
	mode: 'standalone',
	appOrigin: window.location.origin,
	assetOrigin: window.location.origin,
	chatUiUrl: 'https://chatgpt.com/',
};

export const APP_INFO = {
	name: 'opengpt-run-console',
	title: 'OpenGPT Run Console',
	version: '3.0.0',
	websiteUrl: `${config.appOrigin}/gui/`,
};

export const STANDALONE_TOKEN_STORAGE_KEY = 'opengpt.run-console.token';
export const STANDALONE_AUTH_STATE_STORAGE_KEY = 'opengpt.run-console.auth.pending';
export const DASHBOARD_POLL_MS = 15_000;
export const DETAIL_POLL_MS = 5_000;

export function readStoredToken() {
	try {
		return window.localStorage.getItem(STANDALONE_TOKEN_STORAGE_KEY) || '';
	} catch {
		return '';
	}
}

export function writeStoredToken(value) {
	try {
		const token = String(value ?? '').trim();
		if (token) {
			window.localStorage.setItem(STANDALONE_TOKEN_STORAGE_KEY, token);
			return token;
		}
		window.localStorage.removeItem(STANDALONE_TOKEN_STORAGE_KEY);
		return '';
	} catch {
		return '';
	}
}

export function currentRoute() {
	const url = new URL(window.location.href);
	return {
		missionId: url.searchParams.get('mission') || '',
		jobId: url.searchParams.get('job') || '',
		tab: url.searchParams.get('tab') || 'overview',
	};
}

export function updateRoute(route) {
	const url = new URL(window.location.href);
	if (route.missionId) {
		url.searchParams.set('mission', route.missionId);
	} else {
		url.searchParams.delete('mission');
	}
	if (route.jobId) {
		url.searchParams.set('job', route.jobId);
	} else {
		url.searchParams.delete('job');
	}
	if (route.tab) {
		url.searchParams.set('tab', route.tab);
	}
	window.history.replaceState({}, '', url);
}
