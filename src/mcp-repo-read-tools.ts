import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import {
	decodeBase64Text,
	encodeGitHubPath,
	ensureRepoAllowed,
	ensureSafePath,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	githubGet,
	ok,
	toolText,
} from './utils';
import { ToolAnnotations } from './mcp-overview-tools';

function normalizeTreePath(path: string | undefined): string {
	if (!path) {
		return '';
	}
	return path.replace(/^\/+|\/+$/g, '');
}

function summarizeTreeEntries(
	entries: Array<Record<string, unknown>>,
	basePath: string,
	depth: number,
	maxEntries: number,
): Record<string, unknown> {
	const normalizedBasePath = normalizeTreePath(basePath);
	const basePrefix = normalizedBasePath ? `${normalizedBasePath}/` : '';
	const scopedEntries = entries.filter((entry) => {
		const entryPath = String(entry.path ?? '');
		return !normalizedBasePath || entryPath === normalizedBasePath || entryPath.startsWith(basePrefix);
	});
	const directDirectories = new Set<string>();
	const directFiles = new Set<string>();
	const samplePaths: string[] = [];
	const projectRootCandidates = new Set<string>();
	for (const entry of scopedEntries) {
		const entryPath = String(entry.path ?? '');
		if (!entryPath || entryPath === normalizedBasePath) {
			continue;
		}
		const relativePath = normalizedBasePath
			? entryPath.startsWith(basePrefix)
				? entryPath.slice(basePrefix.length)
				: entryPath
			: entryPath;
		if (!relativePath) {
			continue;
		}
		const segments = relativePath.split('/').filter(Boolean);
		if (segments.length === 0) {
			continue;
		}
		if (segments.length === 1) {
			if (String(entry.type ?? '') === 'tree') {
				directDirectories.add(segments[0]);
			} else {
				directFiles.add(segments[0]);
			}
		}
		if (segments.length <= depth && samplePaths.length < maxEntries) {
			samplePaths.push(entryPath);
		}
		const firstSegment = segments[0];
		if (['projects', 'apps', 'examples', 'samples', 'tools', 'playground', 'playgrounds'].includes(firstSegment)) {
			projectRootCandidates.add(firstSegment);
		}
	}
	return {
		base_path: normalizedBasePath,
		depth,
		total_entries: scopedEntries.length,
		directories: Array.from(directDirectories).sort(),
		files: Array.from(directFiles).sort(),
		sample_paths: samplePaths,
		project_root_candidates: Array.from(projectRootCandidates).sort(),
	};
}

export function registerRepoReadTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'repo_get_file',
		{
			description: 'Read a file from an allowlisted GitHub repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				path: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, path, ref }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureSafePath(path);
				const data = (await githubGet(
					env,
					`/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`,
					{ params: ref ? { ref } : {} },
				)) as Record<string, unknown>;
				const content = typeof data.content === 'string' ? decodeBase64Text(data.content) : null;
				return toolText(ok({ ...data, decoded_text: content }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_get_file_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_list_tree',
		{
			description: 'List repository tree entries from an allowlisted GitHub repository.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				path: z.string().optional(),
				recursive: z.boolean().default(false),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref, path, recursive }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				const treeResult = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || getDefaultBaseBranch(env))}`,
					{ params: { recursive } },
				)) as { tree?: Array<Record<string, unknown>> };
				const filteredTree = path
					? (treeResult.tree ?? []).filter((entry) => String(entry.path ?? '').startsWith(path))
					: treeResult.tree ?? [];
				return toolText(ok({ ...treeResult, tree: filteredTree }, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_list_tree_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_tree_snapshot',
		{
			description:
				'Summarize an allowlisted GitHub repository tree for project planning. Returns top-level directories/files, depth-limited sample paths, and likely project roots.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				ref: z.string().optional(),
				path: z.string().optional(),
				depth: z.number().int().min(1).max(6).default(2),
				max_entries: z.number().int().min(10).max(500).default(100),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, ref, path, depth, max_entries }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				if (path) {
					ensureSafePath(path);
				}
				const effectiveRef = ref || getDefaultBaseBranch(env);
				const treeResult = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(effectiveRef)}`,
					{ params: { recursive: true } },
				)) as { sha?: string; truncated?: boolean; tree?: Array<Record<string, unknown>> };
				const tree = treeResult.tree ?? [];
				const requestedPath = normalizeTreePath(path);
				return toolText(
					ok(
						{
							repo_key: repoKey,
							ref: effectiveRef,
							sha: treeResult.sha ?? null,
							truncated: treeResult.truncated ?? false,
							requested_path: requestedPath,
							snapshot: summarizeTreeEntries(tree, requestedPath, depth, max_entries),
							top_level: summarizeTreeEntries(tree, '', 1, Math.min(max_entries, 100)),
						},
						readAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_tree_snapshot_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_search_code',
		{
			description: 'Search for code in an allowlisted repository using GitHub search. The query is automatically scoped to the repo.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				query: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, query }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, '/search/code', {
					params: { q: `${query} repo:${owner}/${repo}` },
				})) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_search_code_failed'), error, readAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_search_issues',
		{
			description: 'Search for issues or pull requests in an allowlisted repository using GitHub search. The query is automatically scoped to the repo.',
			inputSchema: {
				owner: z.string(),
				repo: z.string(),
				query: z.string(),
			},
			annotations: readAnnotations,
		},
		async ({ owner, repo, query }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubGet(env, '/search/issues', {
					params: { q: `${query} repo:${owner}/${repo}` },
				})) as Record<string, unknown>;
				return toolText(ok(data, readAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_search_issues_failed'), error, readAnnotations));
			}
		},
	);
}
