export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function formatTime(value) {
	if (!value) {
		return 'Unknown';
	}
	try {
		return new Date(value).toLocaleString();
	} catch {
		return String(value);
	}
}

export function formatRelative(value) {
	if (!value) {
		return 'Unknown';
	}
	const deltaMs = Date.now() - new Date(value).getTime();
	const deltaMinutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (deltaMinutes < 60) {
		return `${deltaMinutes}m ago`;
	}
	const deltaHours = Math.round(deltaMinutes / 60);
	if (deltaHours < 24) {
		return `${deltaHours}h ago`;
	}
	return `${Math.round(deltaHours / 24)}d ago`;
}

export function statusBadge(status, label = status) {
	return `<span class="status-pill" data-status="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

export function actionButton(label, action, dataset = {}, disabled = false, secondary = false) {
	const dataAttrs = Object.entries(dataset)
		.map(([key, value]) => `data-${escapeHtml(key)}="${escapeHtml(value)}"`)
		.join(' ');
	const classes = secondary ? 'action-button secondary' : 'action-button';
	return `<button type="button" class="${classes}" data-action="${escapeHtml(action)}" ${dataAttrs}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

export function renderEmpty(message) {
	return `<article class="empty-card"><p class="supporting-copy">${escapeHtml(message)}</p></article>`;
}

export function renderMetaRows(rows) {
	return `<dl class="detail-grid">${rows
		.filter((row) => row.value)
		.map(
			(row) =>
				`<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`,
		)
		.join('')}</dl>`;
}
