import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { resolveProjectCapabilities } from '../../project-capabilities';
import { ensureRepoAllowed, errorCodeFor, fail, getDefaultBaseBranch, ok, toolText } from '../../utils';
import { findContractCandidates, readRepoTextFile, readRepoTree } from '../../fullstack/repo-utils';
import { normalizeContractValidation } from '../../fullstack/logic';
import { resolveApiTargetUrl } from './shared';

export function registerFullstackApiTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
	writeAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'api_contract_list',
		{
			description: 'List API contract files discovered from project capabilities or repository heuristics.',
			inputSchema: { owner: z.string(), repo: z.string(), ref: z.string().optional() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				return toolText(ok({ repo: repoKey, ref: effectiveRef, configured_sources: capabilities.api_contract_sources, contracts: findContractCandidates(tree, capabilities.api_contract_sources) }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_list_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'api_contract_get',
		{
			description: 'Read a single API contract file from the repository.',
			inputSchema: { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, path, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				ensureRepoAllowed(env, repoKey);
				return toolText(ok({ repo: repoKey, ref: effectiveRef, path, text: await readRepoTextFile(env, owner, repo, path, effectiveRef) }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_get_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'api_request_run',
		{
			description: 'Make a direct API request against a preview URL or explicit app URL and return a concise response summary.',
			inputSchema: {
				preview_token: z.string().optional(),
				app_url: z.string().url().optional(),
				path: z.string().optional(),
				method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
				headers: z.record(z.string(), z.string()).default({}),
				body_text: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		async ({ preview_token, app_url, path, method, headers, body_text }) => {
			try {
				const url = await resolveApiTargetUrl(env, preview_token, app_url, path);
				const response = await fetch(url, { method, headers: { ...headers }, body: body_text });
				const responseText = await response.text();
				return toolText(ok({ url, method, status: response.status, ok: response.ok, content_type: response.headers.get('content-type'), body_excerpt: responseText.slice(0, 4000) }, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_request_run_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'api_contract_validate',
		{
			description: 'Perform lightweight validation on discovered API contract files.',
			inputSchema: { owner: z.string(), repo: z.string(), ref: z.string().optional() },
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref }) => {
			try {
				const effectiveRef = ref?.trim() || getDefaultBaseBranch(env);
				const capabilities = await resolveProjectCapabilities(env, owner, repo, effectiveRef);
				const tree = await readRepoTree(env, owner, repo, effectiveRef);
				const contracts = findContractCandidates(tree, capabilities.api_contract_sources);
				const validations = [];
				for (const contract of contracts.slice(0, 20)) {
					const path = String(contract.path ?? '');
					if (!path || String(contract.type ?? '') !== 'blob') continue;
					const text = await readRepoTextFile(env, owner, repo, path, effectiveRef);
					validations.push(normalizeContractValidation(path, text));
				}
				return toolText(ok({ repo: `${owner}/${repo}`, ref: effectiveRef, validations }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'api_contract_validate_failed'), error, readAnnotations));
			}
		},
	);
}
