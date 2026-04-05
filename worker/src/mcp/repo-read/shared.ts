import type { AppEnv } from '../../contracts';
import { rankIndexMatches } from '../../read-index-match';
import { buildPathScopedIndex } from '../../read-navigation';
import { incrementReadCounter, recordToolMetric } from '../../read-observability';
import { prepareSearchQuery } from '../../read-query';
import { decodeBase64Text, encodeGitHubPath, getSelfRepoKey, githubGet } from '../../utils';

export function normalizeTreePath(path: string | undefined): string {
	return path ? path.replace(/^\/+|\/+$/g, '') : '';
}

export function matchesTreePathScope(entryPath: string, requestedPath: string | undefined): boolean {
	const normalizedRequestedPath = normalizeTreePath(requestedPath);
	return !normalizedRequestedPath || entryPath === normalizedRequestedPath || entryPath.startsWith(`${normalizedRequestedPath}/`);
}

export function matchesRequestedPaths(entryPath: string, requestedPaths: string[] | undefined): boolean {
	if (!requestedPaths || requestedPaths.length === 0) return true;
	return requestedPaths.some((requestedPath) => {
		const normalized = normalizeTreePath(requestedPath);
		return !normalized || entryPath === normalized || entryPath.startsWith(`${normalized}/`);
	});
}

export function summarizeTreeEntries(entries: Array<Record<string, unknown>>, basePath: string, depth: number, maxEntries: number): Record<string, unknown> {
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
		if (!entryPath || entryPath === normalizedBasePath) continue;
		const relativePath = normalizedBasePath && entryPath.startsWith(basePrefix) ? entryPath.slice(basePrefix.length) : entryPath;
		const segments = relativePath.split('/').filter(Boolean);
		if (segments.length === 0) continue;
		if (segments.length === 1) {
			if (String(entry.type ?? '') === 'tree') directDirectories.add(segments[0]);
			else directFiles.add(segments[0]);
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

export async function measureTool<T>(name: string, action: () => Promise<T>, bytesRead = 0): Promise<T> {
	const startedAt = Date.now();
	try {
		return await action();
	} finally {
		recordToolMetric(name, Date.now() - startedAt, bytesRead);
	}
}

export async function getRepoTree(env: AppEnv, owner: string, repo: string, ref: string, recursive: boolean) {
	return (await githubGet(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`, {
		params: { recursive },
	})) as { sha?: string; truncated?: boolean; tree?: Array<Record<string, unknown>> };
}

export async function getRepoFile(env: AppEnv, owner: string, repo: string, path: string, ref?: string) {
	const data = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
		params: ref ? { ref } : {},
	})) as Record<string, unknown> & {
		content?: string;
		path?: string;
		name?: string;
		type?: string;
		sha?: string;
	};
	return { ...data, decoded_text: typeof data.content === 'string' ? decodeBase64Text(data.content) : null };
}

export async function resolveToolIndex(env: AppEnv, owner: string, repo: string, ref: string, query?: string): Promise<Record<string, unknown>> {
	const repoKey = `${owner}/${repo}`;
	const preparedQuery = prepareSearchQuery(query);
	const treeResult = await getRepoTree(env, owner, repo, ref, true);
	const treeEntries = treeResult.tree ?? [];
	const pathMatches = buildPathScopedIndex(treeEntries, 'tool', query);
	const selfRepoToolEntries: Array<Record<string, unknown>> = [];
	if (repoKey === getSelfRepoKey(env)) {
		const toolCatalog = await getRepoFile(env, owner, repo, 'worker/src/tool-catalog.json', ref);
		const parsed = toolCatalog.decoded_text ? (JSON.parse(toolCatalog.decoded_text) as { groups?: Array<{ tools?: string[]; label?: string; id?: string }> }) : null;
		const catalogEntries = (parsed?.groups ?? []).flatMap((group) =>
			(group.tools ?? []).map((toolName) => ({
				tool_name: toolName,
				group_id: group.id ?? null,
				group_label: group.label ?? null,
				path: 'worker/src/tool-catalog.json',
				anchor: toolName,
			})),
		);
		selfRepoToolEntries.push(
			...rankIndexMatches(
				catalogEntries,
				(entry) => ({
					primaryText: String(entry.tool_name ?? ''),
					secondaryText: [String(entry.group_label ?? ''), String(entry.path ?? '')],
				}),
				preparedQuery,
			)
				.slice(0, 50)
				.map(({ value }) => value),
		);
	}
	incrementReadCounter(pathMatches.length > 0 || selfRepoToolEntries.length > 0 ? 'tool_index_hit' : 'tool_index_miss');
	return {
		repo_key: repoKey,
		ref,
		query: query ?? null,
		tool_paths: pathMatches,
		tool_entries: selfRepoToolEntries.slice(0, 50),
	};
}
