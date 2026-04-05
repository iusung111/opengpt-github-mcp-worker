import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppEnv } from './contracts';
import { registerCollabTools } from './mcp-collab-tools';
import { registerGuiTools } from './mcp-gui-tools';
import { registerFullstackTools } from './mcp-fullstack-tools';
import { registerOverviewTools } from './mcp-overview-tools';
import { registerQueueTools } from './mcp-queue-tools';
import { registerRepoReadTools } from './mcp-repo-read-tools';
import { decorateToolRegistration } from './mcp-tool-contracts';
import { registerWidgetResources, stripNotificationWidgetMeta, stripNotificationWidgetResult } from './mcp-widget-resources';
import { registerWorkflowDispatchTools } from './mcp-workflow-dispatch-tools';
import { registerWorkflowReadTools } from './mcp-workflow-read-tools';
import { registerWriteTools } from './mcp-write-tools';
import type { ToolAnnotations } from './mcp/contracts';

type McpServerBuildOptions = {
	enableWidgets?: boolean;
	profile?: 'direct_full' | 'chatgpt_public';
};

function disableWidgetRegistrations(server: McpServer): void {
	const originalRegisterTool = server.registerTool.bind(server);
	server.registerTool = ((name, config, handler) => {
		const nextConfig =
			config && typeof config === 'object'
				? {
						...config,
						_meta: stripNotificationWidgetMeta(
							'_meta' in config && config._meta && typeof config._meta === 'object' && !Array.isArray(config._meta)
								? (config._meta as Record<string, unknown>)
								: undefined,
							),
					}
				: config;
		const nextHandler =
			typeof handler === 'function'
				? async (...args: any[]) =>
						stripNotificationWidgetResult(
						(await (handler as (...innerArgs: any[]) => Promise<Record<string, unknown> | null | undefined>).apply(
								server,
								args,
							)) as Record<string, unknown> | null | undefined,
							)
				: handler;
		return originalRegisterTool(name, nextConfig as never, nextHandler as never);
	}) as typeof server.registerTool;
}

function registerDirectFullTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	registerOverviewTools(server, env, readAnnotations, writeAnnotations);
	registerRepoReadTools(server, env, readAnnotations);
	registerCollabTools(server, env, readAnnotations, writeAnnotations);
	registerWorkflowReadTools(server, env, readAnnotations);
	registerWriteTools(server, env, writeAnnotations);
	registerWorkflowDispatchTools(server, env, writeAnnotations);
	registerGuiTools(server, env, writeAnnotations);
	registerFullstackTools(server, env, readAnnotations, writeAnnotations);
	registerQueueTools(server, env, readAnnotations, writeAnnotations);
}

function registerChatgptPublicTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
): void {
	registerRepoReadTools(server, env, readAnnotations);
	registerWorkflowReadTools(server, env, readAnnotations);
}

export function buildMcpServer(env: AppEnv, options: McpServerBuildOptions = {}): McpServer {
	const profile = options.profile ?? 'direct_full';
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.2.4',
	});
	decorateToolRegistration(server);
	const enableWidgets = options.enableWidgets ?? true;
	if (!enableWidgets) {
		disableWidgetRegistrations(server);
	}

	const readAnnotations: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations: ToolAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};

	if (enableWidgets) {
		registerWidgetResources(server, env);
	}
	if (profile === 'chatgpt_public') {
		registerChatgptPublicTools(server, env, readAnnotations);
	} else {
		registerDirectFullTools(server, env, readAnnotations, writeAnnotations);
	}

	return server;
}
