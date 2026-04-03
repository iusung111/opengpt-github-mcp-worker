import { config } from '../config.mjs';
import { buildAttentionItems, yoloAllEnabled } from '../state/attention-center.mjs';
import { needsStandaloneAuth } from '../state/app-store.mjs';
import { actionButton, escapeHtml, formatRelative, renderEmpty, statusBadge } from './shared-ui.mjs';

function missionCard(mission, selectedMissionId) {
	const selected = mission.missionId === selectedMissionId ? ' is-selected' : '';
	const counts = mission.counts;
	return `<article class="job-card${selected}" data-select-mission="${escapeHtml(mission.missionId)}">
		<div class="job-card-heading">
			<div>
				<h3>${escapeHtml(mission.title)}</h3>
				<p class="supporting-copy">${escapeHtml(mission.repo)}</p>
			</div>
			${statusBadge(mission.status)}
		</div>
		<p class="job-card-summary">parallel ${escapeHtml(mission.maxParallelism)} / working ${escapeHtml(counts.working)} / blocked ${escapeHtml(counts.blocked)}</p>
		<div class="job-card-meta">
			<span class="job-card-meta-item">${escapeHtml(formatRelative(mission.updatedAt))}</span>
			<span class="job-card-meta-item">${mission.yoloMode ? 'YOLO on' : 'YOLO off'}</span>
		</div>
	</article>`;
}

function jobCard(job, selectedJobId) {
	const selected = job.jobId === selectedJobId ? ' is-selected' : '';
	return `<article class="job-card${selected}" data-select-job="${escapeHtml(job.jobId)}">
		<div class="job-card-heading">
			<div>
				<h3>${escapeHtml(job.title)}</h3>
				<p class="supporting-copy">${escapeHtml(job.repo || job.jobId)}</p>
			</div>
			${statusBadge(job.status)}
		</div>
		<p class="job-card-summary">${escapeHtml(job.lastEvent || 'No recent event.')}</p>
		<div class="job-card-meta">
			<span class="job-card-meta-item">${escapeHtml(formatRelative(job.updatedAt))}</span>
			<span class="job-card-meta-item">${escapeHtml(job.nextActor || 'system')}</span>
		</div>
	</article>`;
}

function standaloneAuthPanel(store) {
	if (config.mode !== 'standalone' || !needsStandaloneAuth(store)) {
		return '';
	}
	const authError = store.auth.error || store.session.error;
	return `<section class="panel auth-panel">
		<div class="panel-header">
			<div>
				<p class="eyebrow">Standalone Access</p>
				<h2>Connect the web control API</h2>
				<p class="supporting-copy">Use browser login or a bearer token before loading mission data outside the host bridge.</p>
			</div>
		</div>
		<div class="action-row">
			${actionButton(store.auth.loading ? 'Loading...' : 'Sign in', 'begin-browser-login', {}, !store.auth.enabled || store.auth.loading)}
			${actionButton('Reload config', 'retry-auth-config', {}, false, true)}
			${actionButton('Retry API', 'retry-standalone-session', {}, false, true)}
		</div>
		<div class="field-stack">
			<label for="standalone-token">Bearer token</label>
			<textarea id="standalone-token" class="command-textarea" name="standalone-token" placeholder="Paste a bearer token for /gui/api/session">${escapeHtml(store.standaloneToken || '')}</textarea>
		</div>
		<div class="action-row">
			${actionButton('Save token', 'save-standalone-token')}
			${actionButton('Clear token', 'clear-standalone-token', {}, !store.standaloneToken, true)}
		</div>
		${authError ? `<article class="empty-card"><strong>Access required</strong><p>${escapeHtml(authError)}</p></article>` : ''}
	</section>`;
}

function notificationCenter(store) {
	const items = buildAttentionItems(store);
	const open = store.notificationMenuOpen === true;
	return `<div class="notification-shell" data-notification-menu>
		<button type="button" class="icon-button notification-button" data-action="toggle-notifications" aria-expanded="${open ? 'true' : 'false'}">
			Alerts
			${items.length ? `<span class="notification-badge">${escapeHtml(items.length)}</span>` : ''}
		</button>
		${
			open
				? `<div class="notification-menu">
					<div class="notification-menu-header">
						<h3>Attention</h3>
						${actionButton('Close', 'toggle-notifications', {}, false, true)}
					</div>
					<div class="notification-list">
						${
							items.length
								? items
										.map(
											(item) => `<article class="notification-entry">
												<strong>${escapeHtml(item.title)}</strong>
												<p>${escapeHtml(item.body)}</p>
												<span>${escapeHtml(item.status)} / ${escapeHtml(formatRelative(item.updatedAt))}</span>
												<div class="action-row">
													${item.jobId ? `<button type="button" class="mini-button" data-select-job="${escapeHtml(item.jobId)}">Open job</button>` : ''}
													${item.missionId ? `<button type="button" class="mini-button" data-select-mission="${escapeHtml(item.missionId)}">Open mission</button>` : ''}
												</div>
											</article>`,
										)
										.join('')
								: '<article class="notification-empty">No active alerts.</article>'
						}
					</div>
				</div>`
				: ''
		}
	</div>`;
}

export function renderDashboard(store, legacyJobs) {
	const missions = store.missionOrder.map((missionId) => store.missionsById[missionId]).filter(Boolean);
	const yoloAll = yoloAllEnabled(store);
	return `<section class="dashboard-pane">
		<header class="hero-card">
			<div>
				<p class="eyebrow">Run Console</p>
				<h1>Mission control for child jobs</h1>
				<p class="supporting-copy">Mission rollups on the left, lane board in the middle, child run detail on the right.</p>
			</div>
			<div class="action-row">
				${notificationCenter(store)}
				${actionButton(yoloAll ? 'YOLO all on' : 'YOLO all off', 'toggle-yolo-all', {}, missions.length === 0, yoloAll)}
				${actionButton('Refresh', 'refresh-dashboard')}
			</div>
		</header>
		${standaloneAuthPanel(store)}
		${store.error ? `<article class="empty-card"><strong>Error</strong><p>${escapeHtml(store.error)}</p></article>` : ''}
		${store.message ? `<article class="empty-card"><strong>Activity</strong><p>${escapeHtml(store.message)}</p></article>` : ''}
		<section>
			<div class="panel-header"><h2>Missions</h2></div>
			${missions.length ? missions.map((mission) => missionCard(mission, store.selectedMissionId)).join('') : renderEmpty('No missions yet.')}
		</section>
		<section>
			<div class="panel-header"><h2>Legacy Jobs</h2></div>
			${legacyJobs.length ? legacyJobs.map((job) => jobCard(job, store.selectedJobId)).join('') : renderEmpty('No standalone jobs.')}
		</section>
	</section>`;
}
