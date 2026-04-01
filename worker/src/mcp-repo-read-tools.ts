import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { AppEnv } from './types';
import { parseUnifiedPatch } from './unified-patch';
import {
	buildFileSummary,
	buildNavigationManifest,
	buildPathScopedIndex,
	classifyReadPath,
	getReadBudgetStatus,
	recordFileRead,
	shouldInlineFileContent,
	sliceFileChunk,
} from './read-navigation';
import { incrementReadCounter, recordToolMetric } from './read-observability';
import { repoIdentityInputSchema, withRepoIdentity } from './mcp-repo-identity';
import {
	decodeBase64Text,
	encodeGitHubPath,
	ensureRepoAllowed,
	ensureSafeRepoPath,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	getSelfRepoKey,
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

export function matchesTreePathScope(entryPath: string, requestedPath: string | undefined): boolean {
	const normalizedRequestedPath = normalizeTreePath(requestedPath);
	if (!normalizedRequestedPath) {
		return true;
	}
	return entryPath === normalizedRequestedPath || entryPath.startsWith(`${normalizedRequestedPath}/`);
}

function matchesRequestedPaths(entryPath: string, requestedPaths: string[] | undefined): boolean {
	if (!requestedPaths || requestedPaths.length === 0) {
		return true;
	}
	return requestedPaths.some((requestedPath) => {
		const normalized = normalizeTreePath(requestedPath);
		if (!normalized) {
			return true;
		}
		return entryPath === normalized || entryPath.startsWith(`${normalized}/`);
	});
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
	for (const entry of scopedEntries) {
		const entryPath = String(entry.path ?? '');
		if (!entryPath || entryPath === normalizedBasePath) {
			continue;
		}
		const relativePath = normalizedBasePath && entryPath.startsWith(basePrefix) ? entryPath.slice(basePrefix.length) : entryPath;
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
	}
	return {
		base_path: normalizedBasePath,
		depth,
		total_entries: scopedEntries.length,
		directories: Array.from(directDirectories).sort(),
		files: Array.from(directFiles).sort(),
		sample_paths: samplePaths,
	};
}

async function measureTool<T>(name: string, action: () => Promise<T>, bytesRead = 0): Promise<T> {
	const startedAt = Date.now();
	try {
		return await action();
	} finally {
		recordToolMetric(name, Date.now() - startedAt, bytesRead);
	}
}

async function getRepoTree(
	env: AppEnv,
	owner: string,
	repo: string,
	ref: string,
	recursive: boolean,
): Promise<{ sha?: string; truncated?: boolean; tree?: Array<Record<string, unknown>> }> {
	return (await githubGet(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`, {
		params: { recursive },
	})) as { sha?: string; truncated?: boolean; tree?: Array<Record<string, unknown>> };
}

async function getRepoFile(
	env: AppEnv,
	owner: string,
	repo: string,
	path: string,
	ref?: string,
): Promise<Record<string, unknown> & { decoded_text: string | null }> {
	const data = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
		params: ref ? { ref } : {},
	})) as Record<string, unknown>;
	return {
		...data,
		decoded_text: typeof data.content === 'string' ? decodeBase64Text(data.content) : null,
	};
}

async function resolveToolIndex(
	env: AppEnv,
	owner: string,
	repo: string,
	ref: string,
	query?: string,
): Promise<Record<string, unknown>> {
	const repoKey = `${owner}/${repo}`;
	const normalizedQuery = (query ?? '').trim().toLowerCase();
	const treeResult = await getRepoTree(env, owner, repo, ref, true);
	const treeEntries = treeResult.tree ?? [];
	const pathMatches = buildPathScopedIndex(treeEntries, 'tool', normalizedQuery);
	const selfRepoToolEntries: Array<Record<string, unknown>> = [];
	if (repoKey === getSelfRepoKey(env)) {
		const toolCatalog = await getRepoFile(env, owner, repo, 'worker/src/tool-catalog.json', ref);
		const parsed = toolCatalog.decoded_text ? (JSON.parse(toolCatalog.decoded_text) as { groups?: Array<{ tools?: string[]; label?: string; id?: string }> }) : null;
		for (const group of parsed?.groups ?? []) {
			for (const toolName of group.tools ?? []) {
				if (normalizedQuery && !toolName.toLowerCase().includes(normalizedQuery)) {
					continue;
				}
				selfRepoToolEntries.push({
					tool_name: toolName,
					group_id: group.id ?? null,
					group_label: group.label ?? null,
					path: 'worker/src/tool-catalog.json',
					anchor: toolName,
				});
			}
		}
	}
	if (pathMatches.length > 0 || selfRepoToolEntries.length > 0) {
		incrementReadCounter('tool_index_hit');
	} else {
		incrementReadCounter('tool_index_miss');
	}
	return {
		repo_key: repoKey,
		ref,
		query: query ?? null,
		tool_paths: pathMatches,
		tool_entries: selfRepoToolEntries.slice(0, 50),
	};
}

export function registerRepoReadTools(
	server: McpServer,
	env: AppEnv,
	readAnnotations: ToolAnnotations,
): void {
	server.registerTool(
		'repo_navigation_manifest',
		{
			description: 'Return the repository navigation manifest. Use this before reading docs or tool files directly.',
			inputSchema: {
				...repoIdentityInputSchema,
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo }) =>
			measureTool('repo_navigation_manifest', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					return toolText(ok(buildNavigationManifest(env, repoKey), readAnnotations));
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_navigation_manifest_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_context_snapshot',
		{
			description: 'Return a manifest-aware repository context snapshot with recommended next paths. Optional path filters must be repo-relative POSIX paths.',
			inputSchema: {
				...repoIdentityInputSchema,
				ref: z.string().optional(),
				path: z.string().optional(),
				depth: z.number().int().min(1).max(6).default(2),
				max_entries: z.number().int().min(10).max(200).default(50),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, ref, path, depth, max_entries }) =>
			measureTool('repo_context_snapshot', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					if (path) {
						ensureSafeRepoPath(path);
					}
					const effectiveRef = ref || getDefaultBaseBranch(env);
					const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
					const tree = treeResult.tree ?? [];
					const manifest = buildNavigationManifest(env, repoKey);
					const requestedPath = normalizeTreePath(path);
					const pathEntries = requestedPath
						? tree.filter((entry) => matchesTreePathScope(String(entry.path ?? ''), requestedPath))
						: tree;
					const recommendedPaths = Array.from(
						new Set(
							(manifest.domains as Array<{ entry_paths?: string[] }> | undefined)?.flatMap((domain) => domain.entry_paths ?? []) ?? [],
						),
					)
						.filter((entryPath) => !requestedPath || matchesTreePathScope(entryPath, requestedPath))
						.slice(0, 12);
					return toolText(
						ok(
							{
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
								recommended_next_actions: [
									'repo_doc_index_lookup',
									'repo_tool_index_lookup',
									'repo_get_file_summary',
									'repo_get_file_chunk',
								],
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_context_snapshot_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_doc_index_lookup',
		{
			description: 'Look up documentation paths and anchors without reading full document bodies.',
			inputSchema: {
				...repoIdentityInputSchema,
				query: z.string().optional(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, query, ref }) =>
			measureTool('repo_doc_index_lookup', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					const effectiveRef = ref || getDefaultBaseBranch(env);
					const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
					const matches = buildPathScopedIndex(treeResult.tree ?? [], 'doc', query);
					if (matches.length > 0) {
						incrementReadCounter('doc_index_hit');
					} else {
						incrementReadCounter('doc_index_miss');
					}
					return toolText(
						ok(
							{
								repo_key: repoKey,
								ref: effectiveRef,
								query: query ?? null,
								manifest: buildNavigationManifest(env, repoKey),
								matches,
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_doc_index_lookup_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_tool_index_lookup',
		{
			description: 'Look up MCP and tool-related entries without reading full source files.',
			inputSchema: {
				...repoIdentityInputSchema,
				query: z.string().optional(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, query, ref }) =>
			measureTool('repo_tool_index_lookup', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					const effectiveRef = ref || getDefaultBaseBranch(env);
					return toolText(ok(await resolveToolIndex(env, owner, repo, effectiveRef, query), readAnnotations));
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_tool_index_lookup_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_read_budget_status',
		{
			description: 'Inspect current repository read budget usage and repeated path access.',
			inputSchema: {
				...repoIdentityInputSchema,
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo }) =>
			measureTool('repo_read_budget_status', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					return toolText(ok(getReadBudgetStatus(repoKey) as Record<string, unknown>, readAnnotations));
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_read_budget_status_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_get_diff',
		{
			description: 'Return a structured diff between two refs, including per-file hunks and rename detection.',
			inputSchema: {
				...repoIdentityInputSchema,
				base_ref: z.string(),
				head_ref: z.string(),
				paths: z.array(z.string()).default([]),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, base_ref, head_ref, paths }) =>
			measureTool('repo_get_diff', async () => {
				try {
					ensureRepoAllowed(env, `${owner}/${repo}`);
					for (const path of paths) {
						ensureSafeRepoPath(path);
					}
					const data = (await githubGet(
						env,
						`/repos/${owner}/${repo}/compare/${encodeURIComponent(base_ref)}...${encodeURIComponent(head_ref)}`,
					)) as {
						ahead_by?: number;
						behind_by?: number;
						html_url?: string;
						status?: string;
						total_commits?: number;
						files?: Array<Record<string, unknown>>;
					};
					const filteredFiles = (data.files ?? [])
						.filter((file) => matchesRequestedPaths(String(file.filename ?? ''), paths))
						.map((file) => {
							const patch = typeof file.patch === 'string' ? file.patch : null;
							return {
								path: file.filename ?? null,
								previous_path: file.previous_filename ?? null,
								status: file.status ?? null,
								additions: file.additions ?? null,
								deletions: file.deletions ?? null,
								changes: file.changes ?? null,
								blob_url: file.blob_url ?? null,
								raw_url: file.raw_url ?? null,
								patch,
								hunks: patch ? parseUnifiedPatch(patch) : [],
								binary: !patch,
							};
						});
					return toolText(
						ok(
							{
								repo_key: `${owner}/${repo}`,
								base_ref,
								head_ref,
								paths,
								status: data.status ?? null,
								ahead_by: data.ahead_by ?? null,
								behind_by: data.behind_by ?? null,
								total_commits: data.total_commits ?? null,
								html_url: data.html_url ?? null,
								changed_files: filteredFiles,
								summary: {
									files: filteredFiles.length,
									additions: filteredFiles.reduce((sum, file) => sum + Number(file.additions ?? 0), 0),
									deletions: filteredFiles.reduce((sum, file) => sum + Number(file.deletions ?? 0), 0),
								},
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_get_diff_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_get_file_summary',
		{
			description: 'Read only the summary, headings, preview, and chunk guidance for a repository file using a repo-relative POSIX path such as worker/src/index.ts.',
			inputSchema: {
				...repoIdentityInputSchema,
				path: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, path, ref }) =>
			measureTool('repo_get_file_summary', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					ensureSafeRepoPath(path);
					const data = await getRepoFile(env, owner, repo, path, ref);
					const text = data.decoded_text;
					if (text === null) {
						return toolText(ok({ path, type: data.type ?? null, classification: classifyReadPath(path), summary: null }, readAnnotations));
					}
					recordFileRead(repoKey, path, text.length);
					incrementReadCounter('full_read_avoided');
					return toolText(
						ok(
							{
								path,
								ref: ref ?? null,
								sha: data.sha ?? null,
								summary: buildFileSummary(path, text),
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_get_file_summary_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_get_file_chunk',
		{
			description: 'Read only a selected line range or heading chunk from a repository file using a repo-relative POSIX path such as worker/src/index.ts.',
			inputSchema: {
				...repoIdentityInputSchema,
				path: z.string(),
				ref: z.string().optional(),
				start_line: z.number().int().positive().optional(),
				max_lines: z.number().int().positive().max(200).default(80),
				anchor: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, path, ref, start_line, max_lines, anchor }) =>
			measureTool('repo_get_file_chunk', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					ensureSafeRepoPath(path);
					const data = await getRepoFile(env, owner, repo, path, ref);
					const text = data.decoded_text;
					if (text === null) {
						return toolText(fail('repo_get_file_chunk_failed', `path is not a text file: ${path}`, readAnnotations));
					}
					recordFileRead(repoKey, path, text.length);
					incrementReadCounter('chunk_read');
					return toolText(
						ok(
							{
								path,
								ref: ref ?? null,
								sha: data.sha ?? null,
								classification: classifyReadPath(path),
								chunk: sliceFileChunk(text, { start_line, max_lines, anchor }),
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_get_file_chunk_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_get_file',
		{
			description:
				'Read a file from an allowlisted GitHub repository using a repo-relative POSIX path such as worker/src/index.ts. Large docs, workflows, and tool files return summary-first responses with chunk guidance.',
			inputSchema: {
				...repoIdentityInputSchema,
				path: z.string(),
				ref: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, path, ref }) =>
			measureTool('repo_get_file', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					ensureSafeRepoPath(path);
					const data = await getRepoFile(env, owner, repo, path, ref);
					const text = data.decoded_text;
					if (text === null) {
						return toolText(ok({ ...data, access_mode: 'binary_or_non_text', decoded_text: null }, readAnnotations));
					}
					recordFileRead(repoKey, path, text.length);
					if (shouldInlineFileContent(path, text, repoKey)) {
						incrementReadCounter('full_read');
						return toolText(
							ok(
								{
									...data,
									decoded_text: text,
									access_mode: 'inline',
									classification: classifyReadPath(path),
								},
								readAnnotations,
							),
						);
					}
					incrementReadCounter('full_read_avoided');
					return toolText(
						ok(
							{
								path: data.path ?? path,
								name: data.name ?? null,
								type: data.type ?? null,
								sha: data.sha ?? null,
								access_mode: 'summary_first',
								classification: classifyReadPath(path),
								decoded_text: null,
								summary: buildFileSummary(path, text),
								read_budget: getReadBudgetStatus(repoKey),
								recommended_next_tool: 'repo_get_file_chunk',
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_get_file_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_list_tree',
		{
			description: 'List repository tree entries from an allowlisted GitHub repository. Optional path filters must be repo-relative POSIX paths.',
			inputSchema: {
				...repoIdentityInputSchema,
				ref: z.string().optional(),
				path: z.string().optional(),
				recursive: z.boolean().default(false),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, ref, path, recursive }) =>
			measureTool('repo_list_tree', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					if (path) {
						ensureSafeRepoPath(path);
					}
					const effectiveRef = ref || getDefaultBaseBranch(env);
					const treeResult = await getRepoTree(env, owner, repo, effectiveRef, recursive);
					const filteredTree = path
						? (treeResult.tree ?? []).filter((entry) => matchesTreePathScope(String(entry.path ?? ''), path))
						: treeResult.tree ?? [];
					return toolText(ok({ ...treeResult, ref: effectiveRef, tree: filteredTree }, readAnnotations));
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_list_tree_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_tree_snapshot',
		{
			description:
				'Summarize an allowlisted repository tree with navigation manifest hints, recommended paths, and top-level layout. Optional path filters must be repo-relative POSIX paths.',
			inputSchema: {
				...repoIdentityInputSchema,
				ref: z.string().optional(),
				path: z.string().optional(),
				depth: z.number().int().min(1).max(6).default(2),
				max_entries: z.number().int().min(10).max(500).default(100),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, ref, path, depth, max_entries }) =>
			measureTool('repo_tree_snapshot', async () => {
				try {
					const repoKey = `${owner}/${repo}`;
					ensureRepoAllowed(env, repoKey);
					if (path) {
						ensureSafeRepoPath(path);
					}
					const effectiveRef = ref || getDefaultBaseBranch(env);
					const treeResult = await getRepoTree(env, owner, repo, effectiveRef, true);
					const tree = treeResult.tree ?? [];
					const requestedPath = normalizeTreePath(path);
					const manifest = buildNavigationManifest(env, repoKey);
					const recommendedPaths = Array.from(
						new Set(
							(manifest.domains as Array<{ entry_paths?: string[] }> | undefined)?.flatMap((domain) => domain.entry_paths ?? []) ?? [],
						),
					)
						.filter((entryPath) => !requestedPath || matchesTreePathScope(entryPath, requestedPath))
						.slice(0, Math.min(max_entries, 20));
					return toolText(
						ok(
							{
								repo_key: repoKey,
								ref: effectiveRef,
								sha: treeResult.sha ?? null,
								truncated: treeResult.truncated ?? false,
								requested_path: requestedPath,
								manifest,
								snapshot: summarizeTreeEntries(tree, requestedPath, depth, max_entries),
								top_level: summarizeTreeEntries(tree, '', 1, Math.min(max_entries, 100)),
								recommended_paths: recommendedPaths,
								recommended_next_tools: [
									'repo_navigation_manifest',
									'repo_context_snapshot',
									'repo_doc_index_lookup',
									'repo_tool_index_lookup',
									'repo_get_file_summary',
								],
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_tree_snapshot_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_search_code',
		{
			description:
				'Search for code in an allowlisted repository using GitHub search. Prefer manifest and index tools first; use this as a fallback.',
			inputSchema: {
				...repoIdentityInputSchema,
				query: z.string(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, query }) =>
			measureTool('repo_search_code', async () => {
				try {
					ensureRepoAllowed(env, `${owner}/${repo}`);
					const data = (await githubGet(env, '/search/code', {
						params: { q: `${query} repo:${owner}/${repo}` },
					})) as Record<string, unknown> & { items?: Array<Record<string, unknown>> };
					return toolText(
						ok(
							{
								...data,
								search_hint: 'Use repo_get_file_summary or repo_get_file_chunk on matched paths before reading entire files.',
								items: (data.items ?? []).map((item) => ({
									name: item.name ?? null,
									path: item.path ?? null,
									html_url: item.html_url ?? null,
									score: item.score ?? null,
								})),
							},
							readAnnotations,
						),
					);
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_search_code_failed'), error, readAnnotations));
				}
			}),
		),
	);

	server.registerTool(
		'repo_search_issues',
		{
			description: 'Search for issues or pull requests in an allowlisted repository using GitHub search.',
			inputSchema: {
				...repoIdentityInputSchema,
				query: z.string(),
			},
			annotations: readAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, query }) =>
			measureTool('repo_search_issues', async () => {
				try {
					ensureRepoAllowed(env, `${owner}/${repo}`);
					const data = (await githubGet(env, '/search/issues', {
						params: { q: `${query} repo:${owner}/${repo}` },
					})) as Record<string, unknown>;
					return toolText(ok(data, readAnnotations));
				} catch (error) {
					return toolText(fail(errorCodeFor(error, 'repo_search_issues_failed'), error, readAnnotations));
				}
			}),
		),
	);
}
