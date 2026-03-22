import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppEnv } from './types';
import { registerCollabTools } from './mcp-collab-tools';
import { registerGuiTools } from './mcp-gui-tools';
import { registerOverviewTools } from './mcp-overview-tools';
import { registerQueueTools } from './mcp-queue-tools';
import { registerRepoReadTools } from './mcp-repo-read-tools';
import { registerWorkflowDispatchTools } from './mcp-workflow-dispatch-tools';
import { registerWorkflowReadTools } from './mcp-workflow-read-tools';
import { registerWriteTools } from './mcp-write-tools';

export function buildMcpServer(env: AppEnv): McpServer {
	const server = new McpServer({
		name: 'opengpt-github-mcp-worker',
		version: '0.2.1',
	});

	const readAnnotations = { readOnlyHint: true, openWorldHint: false };
	const writeAnnotations = {
		readOnlyHint: false,
		openWorldHint: false,
		destructiveHint: false,
	};

	registerOverviewTools(server, env, readAnnotations, writeAnnotations);
	registerRepoReadTools(server, env, readAnnotations);
	registerCollabTools(server, env, readAnnotations, writeAnnotations);
	registerWorkflowReadTools(server, env, readAnnotations);
	registerWriteTools(server, env, writeAnnotations);
	registerWorkflowDispatchTools(server, env, writeAnnotations);
	registerGuiTools(server, env, writeAnnotations);
	registerQueueTools(server, env, readAnnotations, writeAnnotations);

	return server;
}
