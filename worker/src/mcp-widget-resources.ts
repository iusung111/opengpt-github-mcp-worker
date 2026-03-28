import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AppEnv } from './types';
import { getSelfCurrentUrl } from './utils';

export const NOTIFICATION_WIDGET_URI = 'ui://widget/notification-center.html';

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

export function registerWidgetResources(server: McpServer, env: AppEnv): void {
	const origin = getSelfCurrentUrl(env);
	if (!origin) {
		return;
	}

	server.registerResource(
		'notification-center',
		NOTIFICATION_WIDGET_URI,
		{
			title: 'OpenGPT Notification Center',
			description: 'Interactive queue run dashboard for notifications, approvals, and incident bundles.',
			mimeType: 'text/html;profile=mcp-app',
		},
		async () => ({
			contents: [
				{
					uri: NOTIFICATION_WIDGET_URI,
					mimeType: 'text/html;profile=mcp-app',
					text: buildNotificationWidgetHtml(origin),
					_meta: {
						ui: {
							prefersBorder: true,
							csp: {
								connectDomains: [origin],
								resourceDomains: [origin],
							},
							domain: origin,
						},
						'openai/widgetDescription':
							'Inspect queue run status, approvals, event feeds, and incident bundles without extra assistant narration.',
						'openai/widgetPrefersBorder': true,
						'openai/widgetCSP': {
							connect_domains: [origin],
							resource_domains: [origin],
						},
						'openai/widgetDomain': origin,
					},
				},
			],
		}),
	);
}
