import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppEnv } from './contracts';
import { registerCollabTools } from './mcp-collab-tools';
import { registerGuiTools } from './mcp-gui-tools';
import { registerFullstackTools } from './mcp-fullstack-tools';
import { registerOverviewTools } from './mcp-overview-tools';
import { registerQueueTools } from './mcp-queue-tools';
import { registerRepoReadTools } from './mcp-repo-read-tools';
import { decorateToolRegistration } from './mcp-tool-contracts';
import { registerWidgetResources } from './mcp-widget-resources';
import { registerWorkflowDispatchTools } from './mcp-workflow-dispatch-tools';
import { registerWorkflowReadTools } from './mcp-workflow-read-tools';
import { registerWriteTools } from './mcp-write-tools';

export function buildMcpServer(env: AppEnv): McpServer {
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.2.4',
	});
	decorateToolRegistration(server);

	const readAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};

	registerWidgetResources(server, env);
	registerOverviewTools(server, env, readAnnotations, writeAnnotations);
	registerRepoReadTools(server, env, readAnnotations);
	registerCollabTools(server, env, readAnnotations, writeAnnotations);
	registerWorkflowReadTools(server, env, readAnnotations);
	registerWriteTools(server, env, writeAnnotations);
	registerWorkflowDispatchTools(server, env, writeAnnotations);
	registerGuiTools(server, env, writeAnnotations);
	registerFullstackTools(server, env, readAnnotations, writeAnnotations);
	registerQueueTools(server, env, readAnnotations, writeAnnotations);

	return server;
}


