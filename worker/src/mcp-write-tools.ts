import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import {
	PHASE2_FILE_WRITE_READY,
	resolveExpectedBlobSha,
	shouldProbeExistingFile,
	type Phase2FileWriteMode,
} from './file-write-phase2';
import {
	commitBatchWriteChanges,
	prepareBatchWriteChanges,
	preparePatchsetChanges,
	type RepoBatchWriteOperation,
} from './repo-batch-write';
import {
	repoIdentityInputSchema,
	resolveRepoIdentityInput,
	type RepoIdentityInput,
	withRepoIdentity,
} from './mcp-repo-identity';
import { AppEnv } from './types';
import { ToolAnnotations } from './mcp-overview-tools';
import { abortUploadSession, appendUploadChunk, commitUploadSession, createUploadSession } from './upload-session-client';
import {
	activateRepoWorkspace,
	encodeGitHubPath,
	ensureBranchAllowed,
	ensureNotDefaultBranch,
	ensureRepoAllowed,
	ensureSafeRepoPath,
	errorCodeFor,
	fail,
	getDefaultBaseBranch,
	githubGet,
	githubPost,
	githubPut,
	ok,
	toolText,
} from './utils';
import { MAX_REPO_UPDATE_FILE_B64_BYTES } from './upload-session';

interface RepoFileWriteArgs extends RepoIdentityInput {
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

const batchWriteOperationSchema = z.object({
	type: z.enum(['create_file', 'update_file', 'delete_file', 'rename_path', 'mkdir_scaffold']),
	path: z.string().optional(),
	from_path: z.string().optional(),
	to_path: z.string().optional(),
	content_b64: z.string().optional(),
	expected_blob_sha: z.string().optional(),
	entries: z
		.array(
			z.object({
				path: z.string(),
				content_b64: z.string().optional(),
			}),
		)
		.optional(),
});

const patchsetEntrySchema = z.object({
	path: z.string(),
	expected_blob_sha: z.string().optional(),
	patch_unified: z.string(),
});

async function probeExistingBlobSha(
	env: AppEnv,
	owner: string,
	repo: string,
	path: string,
	branch: string,
): Promise<string | null> {
	try {
		const data = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
			params: { ref: branch },
		})) as { sha?: string; type?: string };
		if (data.type && data.type !== 'file') {
			throw new Error(`path is not a file: ${path}`);
		}
		return data.sha ?? null;
	} catch (error) {
		if (isGitHubNotFoundError(error)) {
			return null;
		}
		throw error;
	}
}

export function registerWriteTools(
	server: McpServer,
	env: AppEnv,
	writeAnnotations: ToolAnnotations,
): void {
	void PHASE2_FILE_WRITE_READY;

	async function handleRepoFileWrite(
		mode: Phase2FileWriteMode,
		args: RepoFileWriteArgs,
	) {
		const { owner, repo } = resolveRepoIdentityInput(args);
		const { branch, path, message, content_b64, expected_blob_sha, content_kind, mime_type, validate_only } = args;
		const repoKey = `${owner}/${repo}`;
		ensureRepoAllowed(env, repoKey);
		ensureBranchAllowed(env, branch);
		ensureNotDefaultBranch(env, branch);
		ensureSafeRepoPath(path);
		await activateRepoWorkspace(env, repoKey);
		atob(content_b64);

		if (content_b64.length > MAX_REPO_UPDATE_FILE_B64_BYTES) {
			throw new Error(
				`content_b64 too large for ${mode === 'create' ? 'repo_create_file' : mode === 'upsert' ? 'repo_upsert_file' : 'repo_update_file'}; use repo_upload_start/repo_upload_append/repo_upload_commit instead`,
			);
		}

		let probedBlobSha: string | null = null;
		if (shouldProbeExistingFile(mode)) {
			probedBlobSha = await probeExistingBlobSha(env, owner, repo, path, branch);
		}
		const resolvedBlobSha = resolveExpectedBlobSha({
			mode,
			expectedBlobSha: expected_blob_sha ?? null,
			probedBlobSha,
		});

		if (validate_only) {
			return ok(
				{
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
				},
				writeAnnotations,
			);
		}

		const payload: Record<string, unknown> = {
			message,
			content: content_b64,
			branch,
		};
		if (resolvedBlobSha) {
			payload.sha = resolvedBlobSha;
		}
		const data = (await githubPut(
			env,
			`/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`,
			payload,
		)) as Record<string, unknown>;
		return ok(data, writeAnnotations);
	}

	server.registerTool(
		'repo_create_branch',
		{
			description: 'Create an agent branch from the default base branch in an allowlisted repository.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch_name: z.string(),
				base_branch: z.string().optional(),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, branch_name, base_branch }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch_name);
				await activateRepoWorkspace(env, repoKey);
				const baseRef = (await githubGet(
					env,
					`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch || getDefaultBaseBranch(env))}`,
				)) as { object?: { sha?: string } };
				const sha = baseRef.object?.sha;
				if (!sha) {
					throw new Error('base branch sha not found');
				}
				const data = (await githubPost(env, `/repos/${owner}/${repo}/git/refs`, {
					ref: `refs/heads/${branch_name}`,
					sha,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_create_branch_failed'), error, writeAnnotations));
			}
		}),
	);

	server.registerTool(
		'repo_create_file',
		{
			description:
				'Create a new file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts, including workflow files under .github/workflows/.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				content_b64: z.string(),
				expected_blob_sha: z.string().optional(),
				content_kind: z.enum(['text', 'binary']).optional(),
				mime_type: z.string().optional(),
				validate_only: z.boolean().optional(),
			},
			annotations: writeAnnotations,
		},
		async (args) => {
			try {
				return toolText(await handleRepoFileWrite('create', args));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_create_file_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_upsert_file',
		{
			description:
				'Create or update a file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts. When expected_blob_sha is omitted, existing file sha is probed automatically.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				content_b64: z.string(),
				expected_blob_sha: z.string().optional(),
				content_kind: z.enum(['text', 'binary']).optional(),
				mime_type: z.string().optional(),
				validate_only: z.boolean().optional(),
			},
			annotations: writeAnnotations,
		},
		async (args) => {
			try {
				return toolText(await handleRepoFileWrite('upsert', args));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_upsert_file_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_upload_start',
		{
			description:
				'Start a streamed file upload session on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts. Use this instead of repo_update_file for larger files or ChatGPT web uploads.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				expected_blob_sha: z.string().optional(),
				content_kind: z.enum(['text', 'binary']).optional(),
				mime_type: z.string().optional(),
				total_bytes: z.number().int().nonnegative().optional(),
				validate_only: z.boolean().optional(),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, branch, path, message, expected_blob_sha, content_kind, mime_type, total_bytes, validate_only }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch);
				ensureNotDefaultBranch(env, branch);
				ensureSafeRepoPath(path);
				await activateRepoWorkspace(env, repoKey);
				if (validate_only) {
					return toolText(
						ok(
							{
								validate_only: true,
								repo_key: repoKey,
								branch,
								path,
								content_kind: content_kind ?? null,
								mime_type: mime_type ?? null,
								expected_blob_sha: expected_blob_sha ?? null,
								total_bytes: total_bytes ?? null,
							},
							writeAnnotations,
						),
					);
				}
				const data = await createUploadSession(env, {
					owner,
					repo,
					branch,
					path,
					message,
					expected_blob_sha: expected_blob_sha ?? null,
					content_kind: content_kind ?? null,
					mime_type: mime_type ?? null,
					total_bytes: total_bytes ?? null,
				});
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_upload_start_failed'), error, writeAnnotations));
			}
		}),
	);

	server.registerTool(
		'repo_upload_append',
		{
			description: 'Append one base64-encoded chunk to an existing streamed file upload session.',
			inputSchema: {
				upload_id: z.string(),
				chunk_b64: z.string(),
				chunk_index: z.number().int().nonnegative(),
				byte_offset: z.number().int().nonnegative(),
			},
			annotations: writeAnnotations,
		},
		async ({ upload_id, chunk_b64, chunk_index, byte_offset }) => {
			try {
				const data = await appendUploadChunk(env, upload_id, { chunk_b64, chunk_index, byte_offset });
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_upload_append_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_upload_commit',
		{
			description: 'Commit a previously uploaded streamed file session to GitHub using the git data APIs.',
			inputSchema: {
				upload_id: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ upload_id }) => {
			try {
				const data = await commitUploadSession(env, upload_id);
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_upload_commit_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_upload_abort',
		{
			description: 'Abort a streamed file upload session and delete its stored chunk data.',
			inputSchema: {
				upload_id: z.string(),
			},
			annotations: writeAnnotations,
		},
		async ({ upload_id }) => {
			try {
				const data = await abortUploadSession(env, upload_id);
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_upload_abort_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'repo_batch_write',
		{
			description:
				'Preview or atomically apply multiple file operations on an agent branch using repo-relative POSIX paths, including create, update, delete, rename, and scaffold writes.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				message: z.string(),
				mode: z.enum(['preview', 'apply']).default('preview'),
				operations: z.array(batchWriteOperationSchema).min(1),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, branch, message, mode, operations }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch);
				ensureNotDefaultBranch(env, branch);
				await activateRepoWorkspace(env, repoKey);
				const prepared = await prepareBatchWriteChanges(env, {
					owner,
					repo,
					branch,
					operations: operations as RepoBatchWriteOperation[],
				});
				if (mode === 'preview') {
					return toolText(
						ok(
							{
								repo_key: repoKey,
								branch,
								mode,
								message,
								base_ref_sha: prepared.base_ref_sha,
								can_apply: true,
								changed_files: prepared.changes.map((change) => ({
									path: change.path,
									action: change.action,
									previous_path: change.previous_path ?? null,
									previous_blob_sha: change.previous_blob_sha ?? null,
								})),
							},
							writeAnnotations,
						),
					);
				}
				return toolText(
					ok(
						await commitBatchWriteChanges(env, {
							owner,
							repo,
							branch,
							message,
							base_ref_sha: prepared.base_ref_sha,
							changes: prepared.changes,
						}),
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_batch_write_failed'), error, writeAnnotations));
			}
		}),
	);

	server.registerTool(
		'repo_apply_patchset',
		{
			description:
				'Preview or atomically apply a multi-file unified patchset on an agent branch after validating each target blob. Patch paths must be repo-relative POSIX paths.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				message: z.string(),
				mode: z.enum(['preview', 'apply']).default('preview'),
				patches: z.array(patchsetEntrySchema).min(1),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, branch, message, mode, patches }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				ensureBranchAllowed(env, branch);
				ensureNotDefaultBranch(env, branch);
				await activateRepoWorkspace(env, repoKey);
				const prepared = await preparePatchsetChanges(env, {
					owner,
					repo,
					branch,
					patches,
				});
				if (mode === 'preview') {
					return toolText(
						ok(
							{
								repo_key: repoKey,
								branch,
								mode,
								message,
								base_ref_sha: prepared.base_ref_sha,
								can_apply: true,
								changed_files: prepared.preview,
							},
							writeAnnotations,
						),
					);
				}
				return toolText(
					ok(
						{
							preview: prepared.preview,
							...(await commitBatchWriteChanges(env, {
								owner,
								repo,
								branch,
								message,
								base_ref_sha: prepared.base_ref_sha,
								changes: prepared.changes,
							})),
						},
						writeAnnotations,
					),
				);
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_apply_patchset_failed'), error, writeAnnotations));
			}
		}),
	);

	server.registerTool(
		'repo_update_file',
		{
			description:
				'Update a file on an agent branch in an allowlisted repository using a repo-relative POSIX path such as worker/src/index.ts, including workflow files under .github/workflows/.',
			inputSchema: {
				...repoIdentityInputSchema,
				branch: z.string(),
				path: z.string(),
				message: z.string(),
				content_b64: z.string(),
				expected_blob_sha: z.string().optional(),
				content_kind: z.enum(['text', 'binary']).optional(),
				mime_type: z.string().optional(),
				validate_only: z.boolean().optional(),
			},
			annotations: writeAnnotations,
		},
		async (args) => {
			try {
				return toolText(await handleRepoFileWrite('update', args));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'repo_update_file_failed'), error, writeAnnotations));
			}
		},
	);

	server.registerTool(
		'pr_create',
		{
			description: 'Create a pull request in an allowlisted repository.',
			inputSchema: {
				...repoIdentityInputSchema,
				title: z.string(),
				body: z.string(),
				head: z.string(),
				base: z.string(),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, title, body, head, base }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/pulls`, {
					title,
					body,
					head,
					base,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'pr_create_failed'), error, writeAnnotations));
			}
		}),
	);

	server.registerTool(
		'pr_merge',
		{
			description: 'Merge an open pull request in an allowlisted repository when it is ready to land on the base branch.',
			inputSchema: {
				...repoIdentityInputSchema,
				pull_number: z.number().int().positive(),
				merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
				commit_title: z.string().optional(),
				commit_message: z.string().optional(),
				expected_head_sha: z.string().optional(),
			},
			annotations: {
				...writeAnnotations,
				destructiveHint: true,
			},
		},
		withRepoIdentity(async ({ owner, repo, pull_number, merge_method, commit_title, commit_message, expected_head_sha }) => {
			try {
				const repoKey = `${owner}/${repo}`;
				ensureRepoAllowed(env, repoKey);
				await activateRepoWorkspace(env, repoKey);
				const payload: Record<string, unknown> = { merge_method };
				if (commit_title) {
					payload.commit_title = commit_title;
				}
				if (commit_message) {
					payload.commit_message = commit_message;
				}
				if (expected_head_sha) {
					payload.sha = expected_head_sha;
				}
				const data = (await githubPut(
					env,
					`/repos/${owner}/${repo}/pulls/${pull_number}/merge`,
					payload,
				)) as Record<string, unknown>;
				return toolText(ok(data, { ...writeAnnotations, destructiveHint: true }));
			} catch (error) {
				return toolText(
					fail(errorCodeFor(error, 'pr_merge_failed'), error, {
						...writeAnnotations,
						destructiveHint: true,
					}),
				);
			}
		}),
	);

	server.registerTool(
		'comment_create',
		{
			description: 'Create an issue or PR comment in an allowlisted repository.',
			inputSchema: {
				...repoIdentityInputSchema,
				issue_number: z.number().int().positive(),
				body: z.string(),
			},
			annotations: writeAnnotations,
		},
		withRepoIdentity(async ({ owner, repo, issue_number, body }) => {
			try {
				ensureRepoAllowed(env, `${owner}/${repo}`);
				const data = (await githubPost(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
					body,
				})) as Record<string, unknown>;
				return toolText(ok(data, writeAnnotations));
			} catch (error) {
				return toolText(fail(errorCodeFor(error, 'comment_create_failed'), error, writeAnnotations));
			}
		}),
	);
}
