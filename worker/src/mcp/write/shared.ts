import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import { PHASE2_FILE_WRITE_READY, resolveExpectedBlobSha, shouldProbeExistingFile, type Phase2FileWriteMode } from '../../file-write-phase2';
import { resolveRepoIdentityInput, type RepoIdentityInput } from '../../mcp-repo-identity';
import { MAX_REPO_UPDATE_FILE_B64_BYTES } from '../../upload-session';
import {
	activateRepoWorkspace,
	decodeBase64Text,
	encodeBase64Text,
	encodeGitHubPath,
	ensureBranchAllowed,
	ensureNotDefaultBranch,
	ensureRepoAllowed,
	ensureSafeRepoPath,
	getDefaultBaseBranch,
	githubGet,
	githubPut,
	ok,
} from '../../utils';
import type { ToolAnnotations } from '../contracts';

export interface RepoFileWriteArgs extends RepoIdentityInput {
	owner?: string;
	repo?: string;
	branch: string;
	path: string;
	message: string;
	content_b64: string;
	expected_blob_sha?: string;
	content_kind?: 'text' | 'binary';
	mime_type?: string;
	validate_only?: boolean;
}

function isGitHubNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('github request failed:') && message.includes(' 404 ');
}

function normalizeContentBase64(contentB64: string): string {
	const compact = contentB64.replace(/\s+/g, '');
	const decodedText = decodeBase64Text(compact);
	if (decodedText !== null) return encodeBase64Text(decodedText);
	return btoa(atob(compact));
}

export const batchWriteOperationSchema = z.object({
	type: z.enum(['create_file', 'update_file', 'delete_file', 'rename_path', 'mkdir_scaffold']),
	path: z.string().optional(),
	from_path: z.string().optional(),
	to_path: z.string().optional(),
	content_b64: z.string().optional(),
	expected_blob_sha: z.string().optional(),
	entries: z.array(z.object({ path: z.string(), content_b64: z.string().optional() })).optional(),
});

export const patchsetEntrySchema = z.object({
	path: z.string(),
	expected_blob_sha: z.string().optional(),
	patch_unified: z.string(),
});

export async function probeExistingBlobSha(env: AppEnv, owner: string, repo: string, path: string, branch: string): Promise<string | null> {
	try {
		const data = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
			params: { ref: branch },
		})) as { sha?: string; type?: string };
		if (data.type && data.type !== 'file') throw new Error(`path is not a file: ${path}`);
		return data.sha ?? null;
	} catch (error) {
		if (isGitHubNotFoundError(error)) return null;
		throw error;
	}
}

export async function handleRepoFileWrite(env: AppEnv, writeAnnotations: ToolAnnotations, mode: Phase2FileWriteMode, args: RepoFileWriteArgs) {
	void PHASE2_FILE_WRITE_READY;
	const { owner, repo } = resolveRepoIdentityInput(args);
	const { branch, path, message, content_b64, expected_blob_sha, content_kind, mime_type, validate_only } = args;
	const repoKey = `${owner}/${repo}`;
	ensureRepoAllowed(env, repoKey);
	ensureBranchAllowed(env, branch);
	ensureNotDefaultBranch(env, branch);
	ensureSafeRepoPath(path);
	await activateRepoWorkspace(env, repoKey);
	atob(content_b64.replace(/\s+/g, ''));
	const normalizedContentB64 = normalizeContentBase64(content_b64);
	if (content_b64.length > MAX_REPO_UPDATE_FILE_B64_BYTES) {
		throw new Error(`content_b64 too large for ${mode === 'create' ? 'repo_create_file' : mode === 'upsert' ? 'repo_upsert_file' : 'repo_update_file'}; use repo_upload_start/repo_upload_append/repo_upload_commit instead`);
	}
	let probedBlobSha: string | null = null;
	if (shouldProbeExistingFile(mode)) {
		probedBlobSha = await probeExistingBlobSha(env, owner, repo, path, branch);
	}
	const resolvedBlobSha = resolveExpectedBlobSha({ mode, expectedBlobSha: expected_blob_sha ?? null, probedBlobSha });
	if (validate_only) {
		return ok({
			validate_only: true,
			repo_key: repoKey,
			branch,
			path,
			content_kind: content_kind ?? null,
			mime_type: mime_type ?? null,
			expected_blob_sha: expected_blob_sha ?? null,
			resolved_blob_sha: resolvedBlobSha,
			probed_blob_sha: probedBlobSha,
			write_mode: mode,
		}, writeAnnotations);
	}
	const payload: Record<string, unknown> = { message, content: normalizedContentB64, branch };
	if (resolvedBlobSha) payload.sha = resolvedBlobSha;
	return ok((await githubPut(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, payload)) as Record<string, unknown>, writeAnnotations);
}

export function resolveBaseBranch(baseBranch: string | undefined, env: AppEnv) {
	return baseBranch || getDefaultBaseBranch(env);
}
