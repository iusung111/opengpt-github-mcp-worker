import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { repoIdentityInputSchema, resolveUnknownRepoIdentityInput } from './mcp-repo-identity';
import { classifyRepoPathIssue } from './utils';

type ToolCallback = (args: Record<string, unknown>) => unknown;

type ToolDefinition = {
	description?: string;
	inputSchema?: Record<string, unknown>;
	[key: string]: unknown;
};

type JsonRpcToolCall = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: {
		name?: string;
		arguments?: Record<string, unknown>;
	};
};

const repoIdentityToolNames = new Set<string>();

function isSchemaShape(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaUsesRepoIdentity(inputSchema: Record<string, unknown> | undefined): boolean {
	if (!inputSchema) {
		return false;
	}
	return (
		('repo_key' in inputSchema && inputSchema.repo_key !== undefined) ||
		('owner' in inputSchema && 'repo' in inputSchema)
	);
}

function buildRepoIdentityAwareSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
	if (!schemaUsesRepoIdentity(inputSchema)) {
		return inputSchema;
	}
	return {
		...inputSchema,
		...repoIdentityInputSchema,
	};
}

function appendRepoIdentityHint(description: string | undefined): string | undefined {
	if (!description) {
		return description;
	}
	if (description.includes('repo_key') || description.includes('owner/repo')) {
		return description;
	}
	return `${description} Repo identity may be provided as repo_key in owner/repo form, or as owner and repo separately.`;
}

function invalidParamsResponse(id: unknown, message: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			id: id ?? null,
			error: {
				code: -32602,
				message,
			},
		}),
		{
			status: 200,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		},
	);
}

function getNestedRepoPathIssue(
	toolName: string,
	argumentsObject: Record<string, unknown>,
): { field: string; message: string } | null {
	if (!toolName.startsWith('repo_')) {
		return null;
	}

	if ('path' in argumentsObject) {
		const directPathIssue = classifyRepoPathIssue(argumentsObject.path, 'path', { allowEmpty: true });
		if (directPathIssue) {
			return {
				field: 'path',
				message: directPathIssue.message,
			};
		}
	}

	if (Array.isArray(argumentsObject.paths)) {
		for (let index = 0; index < argumentsObject.paths.length; index += 1) {
			const issue = classifyRepoPathIssue(argumentsObject.paths[index], `paths[${index}]`);
			if (issue) {
				return {
					field: `paths[${index}]`,
					message: issue.message,
				};
			}
		}
	}

	if (Array.isArray(argumentsObject.operations)) {
		for (let index = 0; index < argumentsObject.operations.length; index += 1) {
			const operation = argumentsObject.operations[index];
			if (!isSchemaShape(operation)) {
				continue;
			}
			for (const field of ['path', 'from_path', 'to_path'] as const) {
				if (!(field in operation)) {
					continue;
				}
				const issue = classifyRepoPathIssue(operation[field], `operations[${index}].${field}`);
				if (issue) {
					return {
						field: `operations[${index}].${field}`,
						message: issue.message,
					};
				}
			}
		}
	}

	if (Array.isArray(argumentsObject.patches)) {
		for (let index = 0; index < argumentsObject.patches.length; index += 1) {
			const patch = argumentsObject.patches[index];
			if (!isSchemaShape(patch) || !('path' in patch)) {
				continue;
			}
			const issue = classifyRepoPathIssue(patch.path, `patches[${index}].path`);
			if (issue) {
				return {
					field: `patches[${index}].path`,
					message: issue.message,
				};
			}
		}
	}

	return null;
}

function normalizeToolArguments(toolName: string, argumentsObject: Record<string, unknown>): Record<string, unknown> {
	if (!repoIdentityToolNames.has(toolName)) {
		return argumentsObject;
	}
	const normalizedArgs = { ...argumentsObject };
	const resolved = resolveUnknownRepoIdentityInput(normalizedArgs);
	normalizedArgs.repo_key = resolved.repo_key;
	normalizedArgs.owner = resolved.owner;
	normalizedArgs.repo = resolved.repo;
	return normalizedArgs;
}

export function decorateToolRegistration(server: McpServer): void {
	const originalRegisterTool = server.registerTool.bind(server) as (
		name: string,
		config: ToolDefinition,
		callback: ToolCallback,
	) => unknown;

	server.registerTool = ((name: string, config: ToolDefinition, callback: ToolCallback) => {
		const inputSchema = isSchemaShape(config.inputSchema) ? config.inputSchema : undefined;
		const usesRepoIdentity = schemaUsesRepoIdentity(inputSchema);
		if (usesRepoIdentity) {
			repoIdentityToolNames.add(name);
		}

		const nextConfig: ToolDefinition = {
			...config,
			description: usesRepoIdentity ? appendRepoIdentityHint(config.description) : config.description,
			inputSchema: inputSchema ? buildRepoIdentityAwareSchema(inputSchema) : config.inputSchema,
		};

		const nextCallback: ToolCallback = usesRepoIdentity
			? (args) => callback(normalizeToolArguments(name, args))
			: callback;

		return originalRegisterTool(name, nextConfig, nextCallback);
	}) as typeof server.registerTool;
}

export async function preflightMcpToolCallRequest(request: Request): Promise<Request | Response> {
	if (request.method !== 'POST') {
		return request;
	}
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		return request;
	}

	let payload: unknown;
	try {
		payload = await request.clone().json();
	} catch {
		return request;
	}

	if (!isSchemaShape(payload)) {
		return request;
	}

	const rpcPayload = payload as JsonRpcToolCall;
	if (rpcPayload.method !== 'tools/call' || !isSchemaShape(rpcPayload.params)) {
		return request;
	}

	const toolName = typeof rpcPayload.params.name === 'string' ? rpcPayload.params.name : '';
	if (!toolName) {
		return request;
	}

	const argumentsObject = isSchemaShape(rpcPayload.params.arguments) ? rpcPayload.params.arguments : {};

	try {
		const normalizedArgs = normalizeToolArguments(toolName, argumentsObject);
		const pathIssue = getNestedRepoPathIssue(toolName, normalizedArgs);
		if (pathIssue) {
			return invalidParamsResponse(
				rpcPayload.id,
				`Invalid params for ${toolName}: ${pathIssue.message}`,
			);
		}

		if (normalizedArgs !== argumentsObject) {
			const nextPayload: JsonRpcToolCall = {
				...rpcPayload,
				params: {
					...rpcPayload.params,
					arguments: normalizedArgs,
				},
			};
			return new Request(request, {
				body: JSON.stringify(nextPayload),
				headers: new Headers(request.headers),
			});
		}
		return request;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return invalidParamsResponse(
			rpcPayload.id,
			`Invalid params for ${toolName}: ${message}`,
		);
	}
}
