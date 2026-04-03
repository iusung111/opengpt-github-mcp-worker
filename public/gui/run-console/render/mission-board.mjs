import { actionButton, escapeHtml, formatRelative, renderEmpty, statusBadge } from './shared-ui.mjs';

function laneCard(lane, selectedJobId) {
	const selected = lane.currentJobId && lane.currentJobId === selectedJobId ? ' is-selected' : '';
	return `<article class="job-card${selected}" data-select-job="${escapeHtml(lane.currentJobId || '')}">
		<div class="job-card-heading">
			<div>
				<h3>${escapeHtml(lane.title)}</h3>
				<p class="supporting-copy">${escapeHtml(lane.role)} / attempt ${escapeHtml(lane.attempt)}</p>
			</div>
			${statusBadge(lane.status)}
		</div>
		<p class="job-card-summary">${escapeHtml(lane.blockedReason || lane.lastError || lane.lastEvent || 'Waiting for scheduler activity.')}</p>
		<div class="job-card-meta">
			<span class="job-card-meta-item">${escapeHtml(lane.currentJobId || 'No child job')}</span>
			<span class="job-card-meta-item">${escapeHtml(formatRelative(lane.updatedAt))}</span>
		</div>
	</article>`;
}

export function renderMissionBoard(store, mission) {
	if (!mission) {
		return `<section class="board-pane">${renderEmpty('Select a mission to inspect lane state.')}</section>`;
	}
	return `<section class="board-pane">
		<header class="hero-card">
			<div>
				<p class="eyebrow">Mission</p>
				<h2>${escapeHtml(mission.title)}</h2>
				<p class="supporting-copy">${escapeHtml(mission.repo)} / updated ${escapeHtml(formatRelative(mission.updatedAt))}</p>
			</div>
			<div class="action-row">
				${actionButton(mission.yoloMode ? 'Disable YOLO' : 'Enable YOLO', mission.yoloMode ? 'disable-yolo' : 'enable-yolo')}
				${actionButton('Pause all', 'mission-pause', {}, false, true)}
				${actionButton('Resume all', 'mission-resume', {}, false, true)}
				${actionButton('Retry failed', 'mission-retry', {}, false, true)}
			</div>
		</header>
		<section class="hero-card">
			<p class="supporting-copy">Status ${escapeHtml(mission.status)} / parallel ${escapeHtml(mission.maxParallelism)} / blocked ${escapeHtml(mission.counts.blocked)} / failed ${escapeHtml(mission.counts.failed)}</p>
		</section>
		<section class="job-grid" aria-label="Mission lanes">
			${mission.lanes.length ? mission.lanes.map((lane) => laneCard(lane, store.selectedJobId)).join('') : renderEmpty('No lanes defined for this mission.')}
		</section>
	</section>`;
}
