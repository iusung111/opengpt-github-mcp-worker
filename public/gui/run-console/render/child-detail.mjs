import { actionButton, escapeHtml, formatTime, renderEmpty, renderMetaRows, statusBadge } from './shared-ui.mjs';

function approvalSection(job) {
	if (!job?.approval?.pending) {
		return '';
	}
	return `<section class="hero-card">
		<div class="panel-header">
			<h3>Approval</h3>
			${statusBadge('pending_approval', 'pending')}
		</div>
		<p class="supporting-copy">${escapeHtml(job.approval.reason || 'Approval required before continuing.')}</p>
		<div class="action-row">
			${actionButton('Approve', 'approval-approve')}
			${actionButton('Reject', 'approval-reject', {}, false, true)}
		</div>
	</section>`;
}

function browserSection(browserControl) {
	if (!browserControl) {
		return '';
	}
	return `<section class="hero-card">
		<div class="panel-header"><h3>Browser Companion</h3></div>
		<p class="supporting-copy">${escapeHtml(browserControl.session?.status || 'disconnected')}</p>
		<div class="action-row">
			${actionButton('Click Continue', 'browser-click')}
			${actionButton('Send Follow-up', 'browser-followup', {}, false, true)}
		</div>
	</section>`;
}

function feedSection(feedItems = []) {
	if (!feedItems.length) {
		return renderEmpty('No mission or job feed loaded yet.');
	}
	return `<section class="hero-card">
		<div class="panel-header"><h3>Feed</h3></div>
		<div class="console-block">${feedItems
			.slice(0, 10)
			.map(
				(item) =>
					`<div class="console-line"><span class="console-prefix">${escapeHtml(item.status || item.source_layer || 'log')}</span>${escapeHtml(item.body || item.message || '')}</div>`,
			)
			.join('')}</div>
	</section>`;
}

export function renderChildDetail(store, job) {
	if (!job) {
		return `<section class="detail-pane">${renderEmpty('Select a child job or legacy job to inspect details.')}</section>`;
	}
	const meta = renderMetaRows([
		{ label: 'Job ID', value: job.jobId },
		{ label: 'Repo', value: job.repo },
		{ label: 'Mission', value: job.missionId },
		{ label: 'Lane', value: job.laneId },
		{ label: 'Updated', value: formatTime(job.updatedAt) },
		{ label: 'Workflow', value: job.workflowRunId ? `#${job.workflowRunId}` : '' },
		{ label: 'PR', value: job.prNumber ? `#${job.prNumber}` : '' },
	]);
	return `<section class="detail-pane">
		<header class="hero-card">
			<div>
				<p class="eyebrow">Child Run</p>
				<h2>${escapeHtml(job.title)}</h2>
				<p class="supporting-copy">${escapeHtml(job.lastEvent || 'No recent event.')}</p>
			</div>
			<div class="action-row">
				${statusBadge(job.status)}
				${actionButton('Refresh', 'refresh-job', {}, false, true)}
				${actionButton('Pause', 'job-pause', {}, false, true)}
				${actionButton('Resume', 'job-resume', {}, false, true)}
				${actionButton('Cancel', 'job-cancel', {}, false, true)}
			</div>
		</header>
		<section class="hero-card">${meta}</section>
		${approvalSection(job)}
		${browserSection(store.browserControl)}
		${feedSection(store.jobFeed.length ? store.jobFeed : store.missionFeed)}
	</section>`;
}
