import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { abortUploadSession, appendUploadChunk, commitUploadSession, createUploadSession } from '../../upload-session-client';
import { repoIdentityInputSchema, withRepoIdentity } from '../../mcp-repo-identity';
import { activateRepoWorkspace, ensureBranchAllowed, ensureNotDefaultBranch, ensureRepoAllowed, ensureSafeRepoPath, errorCodeFor, fail, githubGet, githubPost, ok, toolText } from '../../utils';
import { handleRepoFileWrite, resolveBaseBranch } from './shared';

export function registerWriteBranchUploadTools(server: McpServer, env: AppEnv, writeAnnotations: ToolAnnotations): void {
	server.registerTool('repo_create_branch', {
		description: 'Create an agent branch from the default base branch in an allowlisted repository.',
		inputSchema: { ...repoIdentityInputSchema, branch_name: z.string(), base_branch: z.string().optional() },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, branch_name, base_branch }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureBranchAllowed(env, branch_name);
			await activateRepoWorkspace(env, repoKey);
			const baseRef = (await githubGet(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(resolveBaseBranch(base_branch, env))}`)) as { object?: { sha?: string } };
			if (!baseRef.object?.sha) throw new Error('base branch sha not found');
			return toolText(ok((await githubPost(env, `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch_name}`, sha: baseRef.object.sha })) as Record<string, unknown>, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_create_branch_failed'), error, writeAnnotations));
		}
	}));

	for (const [toolName, mode, errorCode, description] of [
		['repo_create_file', 'create', 'repo_create_file_failed', 'Create a new file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts, including workflow files under .github/workflows/.'],
		['repo_upsert_file', 'upsert', 'repo_upsert_file_failed', 'Create or update a file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts. When expected_blob_sha is omitted, existing file sha is probed automatically.'],
		['repo_update_file', 'update', 'repo_update_file_failed', 'Update a file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts, including workflow files under .github/workflows/.'],
	] as const) {
		server.registerTool(toolName, {
			description,
			inputSchema: { ...repoIdentityInputSchema, branch: z.string(), path: z.string(), message: z.string(), content_b64: z.string(), expected_blob_sha: z.string().optional(), content_kind: z.enum(['text', 'binary']).optional(), mime_type: z.string().optional(), validate_only: z.boolean().optional() },
			annotations: writeAnnotations,
		}, async (args) => {
			try {
				return toolText(await handleRepoFileWrite(env, writeAnnotations, mode, args));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, errorCode), error, writeAnnotations));
			}
		});
	}

	server.registerTool('repo_upload_start', {
		description: 'Start a streamed file upload session on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts. Use this instead of repo_update_file for larger files or ChatGPT web uploads.',
		inputSchema: { ...repoIdentityInputSchema, branch: z.string(), path: z.string(), message: z.string(), expected_blob_sha: z.string().optional(), content_kind: z.enum(['text', 'binary']).optional(), mime_type: z.string().optional(), total_bytes: z.number().int().nonnegative().optional(), validate_only: z.boolean().optional() },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, branch, path, message, expected_blob_sha, content_kind, mime_type, total_bytes, validate_only }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureBranchAllowed(env, branch);
			ensureNotDefaultBranch(env, branch);
			ensureSafeRepoPath(path);
			await activateRepoWorkspace(env, repoKey);
			if (validate_only) {
				return toolText(ok({ validate_only: true, repo_key: repoKey, branch, path, content_kind: content_kind ?? null, mime_type: mime_type ?? null, expected_blob_sha: expected_blob_sha ?? null, total_bytes: total_bytes ?? null }, writeAnnotations));
			}
			return toolText(ok(await createUploadSession(env, { owner, repo, branch, path, message, expected_blob_sha: expected_blob_sha ?? null, content_kind: content_kind ?? null, mime_type: mime_type ?? null, total_bytes: total_bytes ?? null }), writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_upload_start_failed'), error, writeAnnotations));
		}
	}));

	server.registerTool('repo_upload_append', { description: 'Append one base64-encoded chunk to an existing streamed file upload session.', inputSchema: { upload_id: z.string(), chunk_b64: z.string(), chunk_index: z.number().int().nonnegative(), byte_offset: z.number().int().nonnegative() }, annotations: writeAnnotations }, async ({ upload_id, chunk_b64, chunk_index, byte_offset }) => {
		try { return toolText(ok(await appendUploadChunk(env, upload_id, { chunk_b64, chunk_index, byte_offset }), writeAnnotations)); } catch (error) { return toolText(fail(errorCodeFor(error, 'repo_upload_append_failed'), error, writeAnnotations)); }
	});
	server.registerTool('repo_upload_commit', { description: 'Commit a previously uploaded streamed file session to GitHub using the git data APIs.', inputSchema: { upload_id: z.string() }, annotations: writeAnnotations }, async ({ upload_id }) => {
		try { return toolText(ok(await commitUploadSession(env, upload_id), writeAnnotations)); } catch (error) { return toolText(fail(errorCodeFor(error, 'repo_upload_commit_failed'), error, writeAnnotations)); }
	});
	server.registerTool('repo_upload_abort', { description: 'Abort a streamed file upload session and delete its stored chunk data.', inputSchema: { upload_id: z.string() }, annotations: writeAnnotations }, async ({ upload_id }) => {
		try { return toolText(ok(await abortUploadSession(env, upload_id), writeAnnotations)); } catch (error) { return toolText(fail(errorCodeFor(error, 'repo_upload_abort_failed'), error, writeAnnotations)); }
	});
}
