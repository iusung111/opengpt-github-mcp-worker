import { applyHostContextToDocument, createMcpUiBridge, extractToolResultEnvelope, hasRecord } from '../bridge-core.mjs';
import { queueBrowserCommand, refreshBrowserControl } from './actions/browser-actions.mjs';
import {
	beginStandaloneBrowserLogin,
	clearStandaloneToken,
	completeStandaloneBrowserLogin,
	refreshStandaloneAuthConfig,
	refreshStandaloneSession,
	saveStandaloneToken,
} from './actions/auth-actions.mjs';
import { controlJob, refreshJob, resolveApproval } from './actions/job-actions.mjs';
import { controlMission, refreshDashboard, refreshMission, toggleYoloAll } from './actions/mission-actions.mjs';
import { APP_INFO, config, currentRoute, readStoredToken, root, updateRoute } from './config.mjs';
import {
	applyJobList,
	applyJobProgress,
	applyMissionList,
	applyMissionProgress,
	createAppStore,
	currentJob,
	currentMission,
	legacyJobs,
	selectJob,
	selectMission,
} from './state/app-store.mjs';
import { renderChildDetail } from './render/child-detail.mjs';
import { renderDashboard } from './render/dashboard.mjs';
import { renderMissionBoard } from './render/mission-board.mjs';
import { createApiClient } from './services/api-client.mjs';
import { syncModelContext } from './services/model-context.mjs';
import { createPollingController } from './services/polling.mjs';

const store = createAppStore(currentRoute());

function applyStructuredContent(structuredContent) {
	if (!hasRecord(structuredContent) || typeof structuredContent.kind !== 'string') {
		return;
	}
	switch (structuredContent.kind) {
		case 'opengpt.notification_contract.mission_list':
			applyMissionList(store, structuredContent);
			break;
		case 'opengpt.notification_contract.jobs_list':
			applyJobList(store, structuredContent);
			break;
		case 'opengpt.notification_contract.mission_progress':
			applyMissionProgress(store, structuredContent);
			break;
		case 'opengpt.notification_contract.job_progress':
			applyJobProgress(store, structuredContent);
			break;
		case 'opengpt.notification_contract.mission_event_feed':
			store.missionFeed = Array.isArray(structuredContent.items) ? structuredContent.items : [];
			break;
		case 'opengpt.notification_contract.job_event_feed':
			store.jobFeed = Array.isArray(structuredContent.items) ? structuredContent.items : [];
			break;
		case 'opengpt.notification_contract.permission_bundle':
			if (hasRecord(structuredContent.current_progress)) {
				applyJobProgress(store, structuredContent.current_progress);
			}
			break;
		default:
			break;
	}
}

const bridge =
	config.mode === 'widget'
		? createMcpUiBridge({
				appInfo: APP_INFO,
				onHostContextChanged: (hostContext) => applyHostContextToDocument(hostContext),
				onToolResult: (result) => {
					const envelope = extractToolResultEnvelope(result);
					if (envelope?.structuredContent) {
						applyStructuredContent(envelope.structuredContent);
						render();
					}
				},
				onToolCancelled: (_params, sessionId) => {
					store.message = sessionId ? `Tool request ${sessionId} was cancelled by the host.` : 'The host cancelled the current tool execution.';
					render();
				},
				onRequestTeardown: () => {
					polling.stop();
					store.error = 'The host requested widget teardown. Reopen the widget to continue.';
					render();
				},
		  })
		: null;

store.bridge = bridge;
store.standaloneToken = readStoredToken();
const api = createApiClient({ bridge });

function render() {
	root.innerHTML = `<div class="workspace-shell has-selection">
		${renderDashboard(store, legacyJobs(store))}
		${renderMissionBoard(store, currentMission(store))}
		${renderChildDetail(store, currentJob(store))}
	</div>`;
	bridge?.notifySize(root.scrollHeight);
}

async function refreshDetail() {
	if (config.mode === 'standalone' && !store.session.ready) {
		updateRoute({ missionId: store.selectedMissionId, jobId: store.selectedJobId, tab: 'overview' });
		render();
		return;
	}
	if (store.selectedMissionId) {
		await refreshMission(store, api, store.selectedMissionId);
	}
	if (store.selectedJobId) {
		await refreshJob(store, api, store.selectedJobId);
	}
	if (store.selectedMissionId) {
		const feed = await api.loadMissionFeed(store.selectedMissionId).catch(() => ({ items: [] }));
		store.missionFeed = Array.isArray(feed.items) ? feed.items : [];
	}
	if (store.selectedJobId && config.mode !== 'widget') {
		await refreshBrowserControl(store, api);
	}
	updateRoute({ missionId: store.selectedMissionId, jobId: store.selectedJobId, tab: 'overview' });
	await syncModelContext(bridge, store).catch(() => {});
	render();
}

function syncPolling() {
	if (config.mode === 'widget' || store.session.ready) {
		polling.start();
		return;
	}
	polling.stop();
}

async function bootstrap() {
	if (bridge) {
		await bridge.connect().catch(() => null);
	}
	if (config.mode === 'standalone') {
		await refreshStandaloneAuthConfig(store, api);
		await completeStandaloneBrowserLogin(store);
		await refreshStandaloneSession(store, api);
	}
	if (config.mode === 'standalone' && !store.session.ready) {
		render();
		syncPolling();
		return;
	}
	await refreshDashboard(store, api);
	await refreshDetail();
	render();
	syncPolling();
}

const polling = createPollingController({
	onDashboardTick: async () => {
		await refreshDashboard(store, api);
		render();
	},
	onDetailTick: refreshDetail,
});

root.addEventListener('click', async (event) => {
	const target = event.target instanceof Element ? event.target.closest('[data-action],[data-select-mission],[data-select-job]') : null;
	if (!target) {
		return;
	}
	if (target.dataset.selectMission) {
		store.notificationMenuOpen = false;
		selectMission(store, target.dataset.selectMission);
		await refreshDetail();
		return;
	}
	if (target.dataset.selectJob) {
		store.notificationMenuOpen = false;
		selectJob(store, target.dataset.selectJob);
		await refreshDetail();
		return;
	}
	switch (target.dataset.action) {
		case 'toggle-notifications':
			store.notificationMenuOpen = !store.notificationMenuOpen;
			render();
			return;
		case 'toggle-yolo-all':
			await toggleYoloAll(store, api);
			break;
		case 'refresh-dashboard':
			await refreshDashboard(store, api);
			break;
		case 'retry-auth-config':
			await refreshStandaloneAuthConfig(store, api);
			await refreshStandaloneSession(store, api);
			break;
		case 'retry-standalone-session':
			await refreshStandaloneSession(store, api);
			if (store.session.ready) {
				await refreshDashboard(store, api);
			}
			break;
		case 'save-standalone-token': {
			const input = document.getElementById('standalone-token');
			saveStandaloneToken(store, input instanceof HTMLTextAreaElement ? input.value : store.standaloneToken);
			await refreshStandaloneSession(store, api);
			if (store.session.ready) {
				await refreshDashboard(store, api);
			}
			break;
		}
		case 'clear-standalone-token':
			clearStandaloneToken(store);
			break;
		case 'begin-browser-login':
			await beginStandaloneBrowserLogin(store);
			return;
		case 'refresh-job':
			await refreshJob(store, api);
			break;
		case 'mission-pause':
			await controlMission(store, api, 'pause');
			break;
		case 'mission-resume':
			await controlMission(store, api, 'resume');
			break;
		case 'mission-retry':
			await controlMission(store, api, 'retry_failed');
			break;
		case 'enable-yolo':
			await controlMission(store, api, 'enable_yolo');
			break;
		case 'disable-yolo':
			await controlMission(store, api, 'disable_yolo');
			break;
		case 'job-pause':
			await controlJob(store, api, 'pause');
			break;
		case 'job-resume':
			await controlJob(store, api, 'resume');
			break;
		case 'job-cancel':
			await controlJob(store, api, 'cancel');
			break;
		case 'approval-approve':
			await resolveApproval(store, api, 'approved');
			break;
		case 'approval-reject':
			await resolveApproval(store, api, 'rejected');
			break;
		case 'browser-click':
			await queueBrowserCommand(store, api, 'click_continue');
			break;
		case 'browser-followup':
			await queueBrowserCommand(store, api, 'send_followup', { prompt: 'Continue the approved run and summarize progress.' });
			break;
		default:
			break;
	}
	syncPolling();
	await refreshDetail();
});

document.addEventListener('click', (event) => {
	if (!store.notificationMenuOpen) {
		return;
	}
	const target = event.target instanceof Element ? event.target : null;
	if (target && target.closest('[data-notification-menu]')) {
		return;
	}
	store.notificationMenuOpen = false;
	render();
});

window.addEventListener('popstate', async () => {
	const route = currentRoute();
	selectMission(store, route.missionId);
	selectJob(store, route.jobId);
	await refreshDetail();
});

root.addEventListener('input', (event) => {
	const target = event.target;
	if (target instanceof HTMLTextAreaElement && target.name === 'standalone-token') {
		store.standaloneToken = target.value;
	}
});

window.addEventListener('openai:set_globals', (event) => {
	const detail = hasRecord(event.detail) ? event.detail : {};
	if (hasRecord(detail.hostContext)) {
		applyHostContextToDocument(detail.hostContext);
	}
	const payload =
		hasRecord(detail.payload)
			? detail.payload
			: hasRecord(detail.widgetPayload)
				? detail.widgetPayload
				: hasRecord(detail.widgetData)
					? { structuredContent: detail.widgetData }
					: hasRecord(detail.structuredContent)
						? { structuredContent: detail.structuredContent }
						: null;
	if (payload) {
		const envelope = extractToolResultEnvelope(payload) || payload;
		if (envelope?.structuredContent) {
			applyStructuredContent(envelope.structuredContent);
			render();
		}
	}
});

void bootstrap();
