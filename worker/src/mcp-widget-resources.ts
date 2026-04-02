import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AppEnv } from './contracts';
import { getSelfCurrentUrl, getSelfLiveUrl, getSelfMirrorUrl } from './utils';

export const NOTIFICATION_WIDGET_URI = 'ui://widget/notification-center.html';

const WIDGET_META_KEYS = new Set(['openai/outputTemplate', 'openai/widgetAccessible']);

function buildNotificationWidgetHtml(origin: string): string {
	const stylesUrl = `${origin}/gui/styles.css`;
	const appUrl = `${origin}/gui/app.js`;
	const config = JSON.stringify({
		mode: 'widget',
		appOrigin: origin,
		assetOrigin: origin,
	});

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>OpenGPT Notification Center</title>
	<link rel="stylesheet" href="${stylesUrl}" />
</head>
<body>
	<div id="notification-app" data-testid="notification-root"></div>
	<script>window.__OPENGPT_GUI_CONFIG__ = ${config};</script>
	<script type="module" src="${appUrl}"></script>
</body>
</html>`;
}

export function notificationWidgetToolMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
	const uiMeta = (meta.ui ?? {}) as Record<string, unknown>;
	return {
		...meta,
		ui: {
			resourceUri: NOTIFICATION_WIDGET_URI,
			visibility: ['model', 'app'],
			...uiMeta,
		},
		'openai/outputTemplate': NOTIFICATION_WIDGET_URI,
		'openai/widgetAccessible': true,
	};
}

export function stripNotificationWidgetMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
	if (!meta) {
		return undefined;
	}
	const nextMeta: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (WIDGET_META_KEYS.has(key)) {
			continue;
		}
		if (key === 'ui' && value && typeof value === 'object' && !Array.isArray(value)) {
			const nextUi = { ...(value as Record<string, unknown>) };
			delete nextUi.resourceUri;
			delete nextUi.visibility;
			if (Object.keys(nextUi).length > 0) {
				nextMeta.ui = nextUi;
			}
			continue;
		}
		nextMeta[key] = value;
	}
	return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
}

export function stripNotificationWidgetResult<T extends Record<string, unknown> | null | undefined>(
	result: T,
): T | Record<string, unknown> | undefined {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		return result;
	}
	const nextResult = { ...result } as Record<string, unknown>;
	const cleanedMeta = stripNotificationWidgetMeta(
		nextResult._meta && typeof nextResult._meta === 'object' && !Array.isArray(nextResult._meta)
			? (nextResult._meta as Record<string, unknown>)
			: undefined,
	);
	if (cleanedMeta) {
		if (cleanedMeta['opengpt/widget'] && typeof cleanedMeta['opengpt/widget'] === 'object') {
			const nextWidget = { ...(cleanedMeta['opengpt/widget'] as Record<string, unknown>) };
			delete nextWidget.data;
			if (Object.keys(nextWidget).length > 0) {
				cleanedMeta['opengpt/widget'] = nextWidget;
			} else {
				delete cleanedMeta['opengpt/widget'];
			}
		}
		nextResult._meta = cleanedMeta;
	} else {
		delete nextResult._meta;
	}
	return nextResult;
}

export function registerWidgetResources(server: McpServer, env: AppEnv): void {
	server.registerResource(
		'notification-center',
		NOTIFICATION_WIDGET_URI,
		{
			title: 'OpenGPT Notification Center',
			description: 'Interactive queue run dashboard for notifications, approvals, and incident bundles.',
			mimeType: 'text/html;profile=mcp-app',
		},
		async () => {
			const origin = getSelfCurrentUrl(env) || getSelfLiveUrl(env) || getSelfMirrorUrl(env) || '';
			return {
				contents: [
					{
						uri: NOTIFICATION_WIDGET_URI,
						mimeType: 'text/html;profile=mcp-app',
						text: buildNotificationWidgetHtml(origin),
						_meta: {
							ui: {
								prefersBorder: true,
								csp: origin ? {
									connectDomains: [origin],
									resourceDomains: [origin],
								} : undefined,
								domain: origin || undefined,
							},
							'openai/widgetDescription':
								'Inspect queue run status, approvals, event feeds, and incident bundles without extra assistant narration.',
							'openai/widgetPrefersBorder': true,
							'openai/widgetCSP': origin ? {
								connect_domains: [origin],
								resource_domains: [origin],
							} : undefined,
							'openai/widgetDomain': origin || undefined,
						},
					},
				],
			};
		},
	);
}

