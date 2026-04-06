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
	readAnnotations: Record<string, unknown>,
	writeAnnotations: Record<string, unknown>,
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
	readAnnotations: Record<string, unknown>,
	writeAnnotations: Record<string, unknown>,
): void {
	registerDirectFullTools(server, env, readAnnotations, writeAnnotations);
}

export function buildMcpServer(env: AppEnv, options: McpServerBuildOptions = {}): McpServer {
	const profile = options.profile ?? 'direct_full';
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.2.4',
	});
	decorateToolRegistration(server);
	const enableWidgets = options.enableWidgets ?? true;
	registerWidgetResources(server, env);
	if (!enableWidgets) {
		disableWidgetRegistrations(server);
	}

	\nconst readAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};

	if (profile === 'chatgpt_public') {
		registerChatgptPublicTools(server, env, readAnnotations, writeAnnotations);
	} else {
		registerDirectFullTools(server, env, readAnnotations, writeAnnotations);
	}

	return server;
}
