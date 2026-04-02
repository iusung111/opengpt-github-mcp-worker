import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { buildNavigationManifest, classifyReadPath } from '../../read-navigation';
import { repoIdentityInputSchema, withRepoIdentity } from '../../mcp-repo-identity';
import { ensureRepoAllowed, ensureSafeRepoPath, errorCodeFor, fail, getDefaultBaseBranch, githubGet, ok, toolText } from '../../utils';
import { getRepoTree, matchesTreePathScope, measureTool, summarizeTreeEntries } from './shared';

export function registerRepoReadTreeSearchTools(server: McpServer, env: AppEnv, readAnnotations: ToolAnnotations): void {
	server.registerTool('repo_list_tree', {
		description: 'List repository tree entries from an allowlisted GitHub repository. Optional path filters must be repo-relative POSIX paths.',
		inputSchema: { ...repoIdentityInputSchema, ref: z.string().optional(), path: z.string().optional(), recursive: z.boolean().default(false) },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, ref, path, recursive }) => measureTool('repo_list_tree', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			if (path) ensureSafeRepoPath(path);
			const effectiveRef = ref || getDefaultBaseBranch(env);
			const treeResult = await getRepoTree(env, owner, repo, effectiveRef, recursive);
			const filteredTree = path ? (treeResult.tree ?? []).filter((entry) => matchesTreePathScope(String(entry.path ?? ''), path)) : treeResult.tree ?? [];
			return toolText(ok({ ...treeResult, ref: effectiveRef, tree: filteredTree }, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_list_tree_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_tree_snapshot', {
		description: 'Summarize an allowlisted repository tree with navigation manifest hints, recommended paths, and top-level layout. Optional path filters must be repo-relative POSIX paths.',
		inputSchema: { ...repoIdentityInputSchema, ref: z.string().optional(), path: z.string().optional(), depth: z.number().int().min(1).max(6).default(2), max_entries: z.number().int().min(10).max(500).default(100) },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, ref, path, depth, max_entries }) => measureTool('repo_tree_snapshot', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			if (path) ensureSafeRepoPath(path);
			const effectiveRef = ref || getDefaultBaseBranch(env);
			const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
			const tree = treeResult.tree ?? [];
			const requestedPath = path ? path.replace(/^\/+|\/+$/g, '') : '';
			const manifest = buildNavigationManifest(env, repoKey);
			const recommendedPaths = Array.from(new Set(((manifest.domains as Array<{ entry_paths?: string[] }> | undefined)?.flatMap((domain) => domain.entry_paths ?? [])) ?? []))
				.filter((entryPath) => !requestedPath || matchesTreePathScope(entryPath, requestedPath))
				.slice(0, Math.min(max_entries, 20));
			return toolText(ok({
				repo_key: repoKey,
				ref: effectiveRef,
				sha: treeResult.sha ?? null,
				truncated: treeResult.truncated ?? false,
				requested_path: requestedPath,
				manifest,
				snapshot: summarizeTreeEntries(tree, requestedPath, depth, max_entries),
				top_level: summarizeTreeEntries(tree, '', 1, Math.min(max_entries, 100)),
				recommended_paths: recommendedPaths,
				recommended_next_tools: ['repo_navigation_manifest', 'repo_context_snapshot', 'repo_doc_index_lookup', 'repo_tool_index_lookup', 'repo_get_file_summary'],
			}, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_tree_snapshot_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_search_code', {
		description: 'Search for code in an allowlisted repository using GitHub search. Prefer manifest and index tools first; use this as a fallback.',
		inputSchema: { ...repoIdentityInputSchema, query: z.string() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, query }) => measureTool('repo_search_code', async () => {
		try {
			ensureRepoAllowed(env, `${owner}/${repo}`);
			const data = (await githubGet(env, '/search/code', { params: { q: `${query} repo:${owner}/${repo}` } })) as Record<string, unknown> & { items?: Array<Record<string, unknown>> };
			return toolText(ok({
				...data,
				search_hint: 'Use repo_get_file_summary or repo_get_file_chunk on matched paths before reading entire files.',
				items: (data.items ?? []).map((item) => ({ name: item.name ?? null, path: item.path ?? null, html_url: item.html_url ?? null, score: item.score ?? null })),
			}, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_search_code_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_search_issues', {
		description: 'Search for issues or pull requests in an allowlisted repository using GitHub search.',
		inputSchema: { ...repoIdentityInputSchema, query: z.string() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, query }) => measureTool('repo_search_issues', async () => {
		try {
			ensureRepoAllowed(env, `${owner}/${repo}`);
			const data = (await githubGet(env, '/search/issues', { params: { q: `${query} repo:${owner}/${repo}` } })) as Record<string, unknown>;
			return toolText(ok(data, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_search_issues_failed'), error, readAnnotations));
		}
	})));
}
