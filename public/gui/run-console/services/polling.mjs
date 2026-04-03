import { DASHBOARD_POLL_MS, DETAIL_POLL_MS } from '../config.mjs';

export function createPollingController(callbacks = {}) {
	let dashboardTimer = null;
	let detailTimer = null;

	function clearTimers() {
		if (dashboardTimer) {
			window.clearInterval(dashboardTimer);
			dashboardTimer = null;
		}
		if (detailTimer) {
			window.clearInterval(detailTimer);
			detailTimer = null;
		}
	}

	function start() {
		clearTimers();
		dashboardTimer = window.setInterval(() => {
			if (typeof callbacks.onDashboardTick === 'function') {
				void callbacks.onDashboardTick();
			}
		}, DASHBOARD_POLL_MS);
		detailTimer = window.setInterval(() => {
			if (typeof callbacks.onDetailTick === 'function') {
				void callbacks.onDetailTick();
			}
		}, DETAIL_POLL_MS);
	}

	return {
		start,
		stop: clearTimers,
	};
}
