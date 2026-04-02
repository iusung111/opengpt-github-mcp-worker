import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { buildNavigationManifest, buildPathScopedIndex, classifyReadPath, getReadBudgetStatus } from '../../read-navigation';
import { incrementReadCounter } from '../../read-observability';
import { repoIdentityInputSchema, withRepoIdentity } from '../../mcp-repo-identity';
import { ensureRepoAllowed, ensureSafeRepoPath, errorCodeFor, fail, getDefaultBaseBranch, ok, toolText } from '../../utils';
import { getRepoTree, matchesTreePathScope, measureTool, resolveToolIndex, summarizeTreeEntries } from './shared';

export function registerRepoReadNavigationTools(server: McpServer, env: AppEnv, readAnnotations: ToolAnnotations): void {
	server.registerTool('repo_navigation_manifest', {
		description: 'Return the repository navigation manifest. Use this before reading docs or tool files directly.',
		inputSchema: { ...repoIdentityInputSchema },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo }) => measureTool('repo_navigation_manifest', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			return toolText(ok(buildNavigationManifest(env, repoKey), readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_navigation_manifest_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_context_snapshot', {
		description: 'Return a manifest-aware repository context snapshot with recommended next paths. Optional path filters must be repo-relative POSIX paths.',
		inputSchema: { ...repoIdentityInputSchema, ref: z.string().optional(), path: z.string().optional(), depth: z.number().int().min(1).max(6).default(2), max_entries: z.number().int().min(10).max(200).default(50) },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, ref, path, depth, max_entries }) => measureTool('repo_context_snapshot', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			if (path) ensureSafeRepoPath(path);
			const effectiveRef = ref || getDefaultBaseBranch(env);
			const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
			const tree = treeResult.tree ?? [];
			const manifest = buildNavigationManifest(env, repoKey);
			const requestedPath = path ? path.replace(/^\/+|\/+$/g, '') : '';
			const pathEntries = requestedPath ? tree.filter((entry) => matchesTreePathScope(String(entry.path ?? ''), requestedPath)) : tree;
			const recommendedPaths = Array.from(new Set(((manifest.domains as Array<{ entry_paths?: string[] }> | undefined)?.flatMap((domain) => domain.entry_paths ?? [])) ?? []))
				.filter((entryPath) => !requestedPath || matchesTreePathScope(entryPath, requestedPath))
				.slice(0, 12);
			return toolText(ok({
				repo_key: repoKey,
				ref: effectiveRef,
				sha: treeResult.sha ?? null,
				requested_path: requestedPath,
				manifest,
				snapshot: summarizeTreeEntries(pathEntries, requestedPath, depth, max_entries),
				path_counts: {
					docs: pathEntries.filter((entry) => classifyReadPath(String(entry.path ?? '')) === 'doc').length,
					tools: pathEntries.filter((entry) => classifyReadPath(String(entry.path ?? '')) === 'tool').length,
					workflows: pathEntries.filter((entry) => classifyReadPath(String(entry.path ?? '')) === 'workflow').length,
					source: pathEntries.filter((entry) => classifyReadPath(String(entry.path ?? '')) === 'source').length,
				},
				recommended_next_paths: recommendedPaths,
				recommended_next_actions: ['repo_doc_index_lookup', 'repo_tool_index_lookup', 'repo_get_file_summary', 'repo_get_file_chunk'],
			}, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_context_snapshot_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_doc_index_lookup', {
		description: 'Look up documentation paths and anchors without reading full document bodies.',
		inputSchema: { ...repoIdentityInputSchema, query: z.string().optional(), ref: z.string().optional() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, query, ref }) => measureTool('repo_doc_index_lookup', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			const effectiveRef = ref || getDefaultBaseBranch(env);
			const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
			const matches = buildPathScopedIndex(treeResult.tree ?? [], 'doc', query);
			incrementReadCounter(matches.length > 0 ? 'doc_index_hit' : 'doc_index_miss');
			return toolText(ok({ repo_key: repoKey, ref: effectiveRef, query: query ?? null, manifest: buildNavigationManifest(env, repoKey), matches }, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_doc_index_lookup_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_tool_index_lookup', {
		description: 'Look up MCP and tool-related entries without reading full source files.',
		inputSchema: { ...repoIdentityInputSchema, query: z.string().optional(), ref: z.string().optional() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, query, ref }) => measureTool('repo_tool_index_lookup', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			return toolText(ok(await resolveToolIndex(env, owner, repo, ref || getDefaultBaseBranch(env), query), readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_tool_index_lookup_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_read_budget_status', {
		description: 'Inspect current repository read budget usage and repeated path access.',
		inputSchema: { ...repoIdentityInputSchema },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo }) => measureTool('repo_read_budget_status', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			return toolText(ok(getReadBudgetStatus(repoKey) as Record<string, unknown>, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_read_budget_status_failed'), error, readAnnotations));
		}
	})));
}
