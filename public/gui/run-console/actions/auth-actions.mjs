import {
	STANDALONE_AUTH_STATE_STORAGE_KEY,
	currentRoute,
	readStoredToken,
	updateRoute,
	writeStoredToken,
} from '../config.mjs';

function readPendingStandaloneAuth() {
	try {
		const raw = window.sessionStorage.getItem(STANDALONE_AUTH_STATE_STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function writePendingStandaloneAuth(value) {
	window.sessionStorage.setItem(STANDALONE_AUTH_STATE_STORAGE_KEY, JSON.stringify(value));
}

function clearPendingStandaloneAuth() {
	window.sessionStorage.removeItem(STANDALONE_AUTH_STATE_STORAGE_KEY);
}

function randomBase64Url(bytes) {
	const value = new Uint8Array(bytes);
	window.crypto.getRandomValues(value);
	return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(value) {
	const encoded = new TextEncoder().encode(value);
	const digest = await window.crypto.subtle.digest('SHA-256', encoded);
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizeStoredRoute(route) {
	return {
		missionId: route && typeof route.missionId === 'string' ? route.missionId : '',
		jobId: route && typeof route.jobId === 'string' ? route.jobId : '',
		tab: route && typeof route.tab === 'string' && route.tab ? route.tab : 'overview',
	};
}

function cleanupLoginQuery(route = null) {
	const url = new URL(window.location.href);
	const nextRoute = normalizeStoredRoute(route || currentRoute());
	if (nextRoute.missionId) {
		url.searchParams.set('mission', nextRoute.missionId);
	} else {
		url.searchParams.delete('mission');
	}
	if (nextRoute.jobId) {
		url.searchParams.set('job', nextRoute.jobId);
	} else {
		url.searchParams.delete('job');
	}
	url.searchParams.set('tab', nextRoute.tab);
	url.searchParams.delete('code');
	url.searchParams.delete('state');
	url.searchParams.delete('error');
	url.searchParams.delete('error_description');
	window.history.replaceState({}, '', url);
}

export async function refreshStandaloneAuthConfig(store, api) {
	store.auth.loading = true;
	try {
		const auth = await api.loadStandaloneAuthConfig();
		store.auth = {
			ready: true,
			enabled: auth?.enabled === true,
			loading: false,
			error: '',
			missing: Array.isArray(auth?.missing) ? auth?.missing.filter((item) => typeof item === 'string') : [],
			clientId: typeof auth?.client_id === 'string' ? auth?.client_id : null,
			audience: typeof auth?.audience === 'string' ? auth?.audience : null,
			scope: typeof auth?.scope === 'string' && auth.scope.trim() ? auth?.scope : 'openid profile email',
			redirectUri: typeof auth?.redirect_uri === 'string' ? auth?.redirect_uri : null,
			authorizationUrl: typeof auth?.authorization_url === 'string' ? auth?.authorization_url : null,
			tokenUrl: typeof auth?.token_url === 'string' ? auth?.token_url : null,
		};
	} catch (error) {
		store.auth.loading = false;
		store.auth.ready = false;
		store.auth.enabled = false;
		store.auth.error = error instanceof Error ? error.message : String(error);
	}
}

export async function refreshStandaloneSession(store, api) {
	store.standaloneToken = readStoredToken();
	if (!store.standaloneToken && store.auth.enabled) {
		store.session.ready = false;
		store.session.email = null;
		store.session.authType = null;
		store.session.error = 'GUI operator auth requires Cloudflare Access or a bearer token';
		return false;
	}
	try {
		const session = await api.loadStandaloneSession();
		store.session.ready = true;
		store.session.email = typeof session?.email === 'string' ? session.email : null;
		store.session.authType = typeof session?.auth_type === 'string' ? session.auth_type : null;
		store.session.error = '';
		store.error = '';
		return true;
	} catch (error) {
		store.session.ready = false;
		store.session.email = null;
		store.session.authType = null;
		store.session.error = error instanceof Error ? error.message : String(error);
		return false;
	}
}

export async function completeStandaloneBrowserLogin(store) {
	const url = new URL(window.location.href);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const authError = url.searchParams.get('error');
	if (!code && !authError) {
		return false;
	}
	if (authError) {
		clearPendingStandaloneAuth();
		cleanupLoginQuery();
		store.session.error = authError;
		return true;
	}
	const pending = readPendingStandaloneAuth();
	const resumeRoute = normalizeStoredRoute(pending?.route);
	if (!pending || pending.state !== state || !store.auth.tokenUrl || !store.auth.clientId) {
		clearPendingStandaloneAuth();
		cleanupLoginQuery(resumeRoute);
		store.session.error = 'The browser login flow could not be resumed.';
		return true;
	}
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: store.auth.clientId,
		code,
		code_verifier: pending.codeVerifier,
		redirect_uri: pending.redirectUri,
	});
	const response = await fetch(store.auth.tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || !payload || typeof payload.access_token !== 'string') {
		clearPendingStandaloneAuth();
		cleanupLoginQuery(resumeRoute);
		store.session.error = payload?.error_description || payload?.error || `token exchange failed (${response.status})`;
		return true;
	}
	store.standaloneToken = writeStoredToken(payload.access_token);
	clearPendingStandaloneAuth();
	cleanupLoginQuery(resumeRoute);
	updateRoute(resumeRoute);
	store.message = 'Signed in for the standalone web control API.';
	store.session.error = '';
	return true;
}

export async function beginStandaloneBrowserLogin(store) {
	if (!store.auth.enabled || !store.auth.authorizationUrl || !store.auth.redirectUri || !store.auth.clientId) {
		store.session.error = store.auth.error || 'Browser login is unavailable for this GUI.';
		return;
	}
	const codeVerifier = randomBase64Url(48);
	const loginState = randomBase64Url(24);
	const codeChallenge = await sha256Base64Url(codeVerifier);
	writePendingStandaloneAuth({
		state: loginState,
		codeVerifier,
		redirectUri: store.auth.redirectUri,
		route: normalizeStoredRoute(currentRoute()),
	});
	const authorizeUrl = new URL(store.auth.authorizationUrl);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('client_id', store.auth.clientId);
	authorizeUrl.searchParams.set('redirect_uri', store.auth.redirectUri);
	authorizeUrl.searchParams.set('scope', store.auth.scope || 'openid profile email');
	if (store.auth.audience) {
		authorizeUrl.searchParams.set('audience', store.auth.audience);
	}
	authorizeUrl.searchParams.set('state', loginState);
	authorizeUrl.searchParams.set('code_challenge', codeChallenge);
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');
	window.location.assign(authorizeUrl.toString());
}

export function saveStandaloneToken(store, value) {
	store.standaloneToken = writeStoredToken(value ?? store.standaloneToken);
}

export function clearStandaloneToken(store) {
	store.standaloneToken = writeStoredToken('');
	store.session.ready = false;
	store.session.email = null;
	store.session.authType = null;
	store.session.error = 'Stored bearer token cleared.';
}
