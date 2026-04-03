import { config, readStoredToken } from '../config.mjs';

function unwrapToolResult(result) {
	if (result?.structuredContent) {
		return result.structuredContent;
	}
	const text = result?.content?.[0] && 'text' in result.content[0] ? result.content[0].text : '';
	const parsed = text ? JSON.parse(text) : {};
	if (!parsed.ok) {
		throw new Error(parsed.error || parsed.code || 'tool call failed');
	}
	return parsed.data || {};
}

async function readJson(response) {
	const payload = await response.json();
	if (!response.ok || !payload.ok) {
		throw new Error(payload.error || payload.code || `http ${response.status}`);
	}
	return payload.data || {};
}

function authHeaders() {
	const token = readStoredToken();
	return token ? { authorization: `Bearer ${token}` } : {};
}

export function createApiClient(options = {}) {
	const bridge = options.bridge || null;
	const bridgeMode = () => config.mode === 'widget' && bridge && bridge.isConnected();

	async function fetchJson(path, init = {}) {
		const headers = {
			...authHeaders(),
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...(init.headers || {}),
		};
		const response = await fetch(path, { ...init, headers });
		return readJson(response);
	}

	return {
		async loadDashboard() {
			if (bridgeMode()) {
				const [missions, jobs] = await Promise.all([
					bridge.callTool('mission_list', {}),
					bridge.callTool('jobs_list', {}),
				]);
				return {
					missions: unwrapToolResult(missions).missions || [],
					jobs: unwrapToolResult(jobs).jobs || [],
				};
			}
			const [missions, jobs] = await Promise.all([
				fetchJson('/gui/api/missions'),
				fetchJson('/gui/api/jobs'),
			]);
			return { missions: missions.missions || [], jobs: jobs.jobs || [] };
		},
		async loadStandaloneSession() {
			if (bridgeMode()) {
				return null;
			}
			return (await fetchJson('/gui/api/session')).session || null;
		},
		async loadStandaloneAuthConfig() {
			if (bridgeMode()) {
				return null;
			}
			return (await fetchJson('/gui/api/auth/config')).auth || null;
		},
		async loadMissionProgress(missionId) {
			if (bridgeMode()) {
				return unwrapToolResult(await bridge.callTool('mission_progress', { mission_id: missionId })).progress || null;
			}
			return (await fetchJson(`/gui/api/missions/${encodeURIComponent(missionId)}`)).progress || null;
		},
		async controlMission(missionId, action) {
			if (bridgeMode()) {
				return unwrapToolResult(await bridge.callTool('mission_control', { mission_id: missionId, action })).progress || null;
			}
			return (
				await fetchJson(`/gui/api/missions/${encodeURIComponent(missionId)}/control`, {
					method: 'POST',
					body: JSON.stringify({ action }),
				})
			).progress || null;
		},
		async loadMissionFeed(missionId) {
			if (bridgeMode()) {
				return unwrapToolResult(await bridge.callTool('mission_event_feed', { mission_id: missionId, limit: 50 }));
			}
			return fetchJson(`/gui/api/missions/${encodeURIComponent(missionId)}/feed?limit=50`);
		},
		async loadJobProgress(jobId) {
			if (bridgeMode()) {
				return unwrapToolResult(await bridge.callTool('job_progress', { job_id: jobId })).progress || null;
			}
			return (await fetchJson(`/gui/api/jobs/${encodeURIComponent(jobId)}`)).progress || null;
		},
		async controlJob(jobId, action) {
			if (bridgeMode()) {
				return unwrapToolResult(await bridge.callTool('job_control', { job_id: jobId, action })).progress || null;
			}
			return (
				await fetchJson(`/gui/api/jobs/${encodeURIComponent(jobId)}/control`, {
					method: 'POST',
					body: JSON.stringify({ action }),
				})
			).progress || null;
		},
		async resolveApproval(jobId, requestId, resolution, note = '') {
			if (bridgeMode()) {
				return unwrapToolResult(
					await bridge.callTool('permission_request_resolve', {
						job_id: jobId,
						request_id: requestId,
						resolution,
						note,
					}),
				).current_progress || null;
			}
			return (
				await fetchJson(`/gui/api/jobs/${encodeURIComponent(jobId)}/approval/resolve`, {
					method: 'POST',
					body: JSON.stringify({ request_id: requestId, resolution, note }),
				})
			).current_progress || null;
		},
		async loadBrowserControl() {
			if (bridgeMode()) {
				return null;
			}
			const payload = await fetchJson('/gui/api/browser-control');
			return payload.browser_control || null;
		},
		async queueBrowserCommand(jobId, kind, extras = {}) {
			if (bridgeMode()) {
				return null;
			}
			const payload = await fetchJson('/gui/api/browser-control/commands', {
				method: 'POST',
				body: JSON.stringify({ job_id: jobId, kind, ...extras }),
			});
			return payload.browser_control || null;
		},
	};
}
