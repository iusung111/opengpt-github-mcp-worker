import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { buildFileSummary, classifyReadPath, getReadBudgetStatus, recordFileRead, shouldInlineFileContent, sliceFileChunk } from '../../read-navigation';
import { incrementReadCounter } from '../../read-observability';
import { repoIdentityInputSchema, withRepoIdentity } from '../../mcp-repo-identity';
import { ensureRepoAllowed, ensureSafeRepoPath, errorCodeFor, fail, githubGet, ok, toolText } from '../../utils';
import { parseUnifiedPatch } from '../../unified-patch';
import { getRepoFile, matchesRequestedPaths, measureTool } from './shared';

export function registerRepoReadFileTools(server: McpServer, env: AppEnv, readAnnotations: ToolAnnotations): void {
	server.registerTool('repo_get_diff', {
		description: 'Return a structured diff between two refs, including per-file hunks and rename detection.',
		inputSchema: { ...repoIdentityInputSchema, base_ref: z.string(), head_ref: z.string(), paths: z.array(z.string()).default([]) },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, base_ref, head_ref, paths }) => measureTool('repo_get_diff', async () => {
		try {
			ensureRepoAllowed(env, `${owner}/${repo}`);
			for (const path of paths) ensureSafeRepoPath(path);
			const data = (await githubGet(env, `/repos/${owner}/${repo}/compare/${encodeURIComponent(base_ref)}...${encodeURIComponent(head_ref)}`)) as {
				ahead_by?: number; behind_by?: number; html_url?: string; status?: string; total_commits?: number; files?: Array<Record<string, unknown>>;
			};
			const filteredFiles = (data.files ?? []).filter((file) => matchesRequestedPaths(String(file.filename ?? ''), paths)).map((file) => {
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
			return toolText(ok({
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
			}, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_get_diff_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_get_file_summary', {
		description: 'Read only the summary, headings, preview, and chunk guidance for a repository file using a repo-relative POSIX path such as worker/src/index.ts.',
		inputSchema: { ...repoIdentityInputSchema, path: z.string(), ref: z.string().optional() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, path, ref }) => measureTool('repo_get_file_summary', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureSafeRepoPath(path);
			const data = await getRepoFile(env, owner, repo, path, ref);
			const text = data.decoded_text;
			if (text === null) return toolText(ok({ path, type: data.type ?? null, classification: classifyReadPath(path), summary: null }, readAnnotations));
			recordFileRead(repoKey, path, text.length);
			incrementReadCounter('full_read_avoided');
			return toolText(ok({ path, ref: ref ?? null, sha: data.sha ?? null, summary: buildFileSummary(path, text) }, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_get_file_summary_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_get_file_chunk', {
		description: 'Read only a selected line range or heading chunk from a repository file using a repo-relative POSIX path such as worker/src/index.ts.',
		inputSchema: { ...repoIdentityInputSchema, path: z.string(), ref: z.string().optional(), start_line: z.number().int().positive().optional(), max_lines: z.number().int().positive().max(200).default(80), anchor: z.string().optional() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, path, ref, start_line, max_lines, anchor }) => measureTool('repo_get_file_chunk', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureSafeRepoPath(path);
			const data = await getRepoFile(env, owner, repo, path, ref);
			const text = data.decoded_text;
			if (text === null) return toolText(fail('repo_get_file_chunk_failed', `path is not a text file: ${path}`, readAnnotations));
			recordFileRead(repoKey, path, text.length);
			incrementReadCounter('chunk_read');
			return toolText(ok({ path, ref: ref ?? null, sha: data.sha ?? null, classification: classifyReadPath(path), chunk: sliceFileChunk(text, { start_line, max_lines, anchor }) }, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_get_file_chunk_failed'), error, readAnnotations));
		}
	})));

	server.registerTool('repo_get_file', {
		description: 'Read a file from an allowlisted GitHub repository using a repo-relative POSIX path such as worker/src/index.ts. Large docs, workflows, and tool files return summary-first responses with chunk guidance.',
		inputSchema: { ...repoIdentityInputSchema, path: z.string(), ref: z.string().optional() },
		annotations: readAnnotations,
	}, withRepoIdentity(async ({ owner, repo, path, ref }) => measureTool('repo_get_file', async () => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureSafeRepoPath(path);
			const data = await getRepoFile(env, owner, repo, path, ref);
			const text = data.decoded_text;
			if (text === null) return toolText(ok({ ...data, access_mode: 'binary_or_non_text', decoded_text: null }, readAnnotations));
			recordFileRead(repoKey, path, text.length);
			if (shouldInlineFileContent(path, text, repoKey)) {
				incrementReadCounter('full_read');
				return toolText(ok({ ...data, decoded_text: text, access_mode: 'inline', classification: classifyReadPath(path) }, readAnnotations));
			}
			incrementReadCounter('full_read_avoided');
			return toolText(ok({
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
			}, readAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_get_file_failed'), error, readAnnotations));
		}
	})));
}
