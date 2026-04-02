import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { AppEnv } from '../../contracts';
import type { ToolAnnotations } from '../contracts';
import { commitBatchWriteChanges, prepareBatchWriteChanges, preparePatchsetChanges, type RepoBatchWriteOperation } from '../../repo-batch-write';
import { repoIdentityInputSchema, withRepoIdentity } from '../../mcp-repo-identity';
import { activateRepoWorkspace, ensureBranchAllowed, ensureNotDefaultBranch, ensureRepoAllowed, errorCodeFor, fail, githubPost, githubPut, ok, toolText } from '../../utils';
import { batchWriteOperationSchema, patchsetEntrySchema } from './shared';

export function registerWriteBatchPrTools(server: McpServer, env: AppEnv, writeAnnotations: ToolAnnotations): void {
	server.registerTool('repo_batch_write', {
		description: 'Preview or atomically apply multiple file operations on an agent branch using repo-relative POSIX paths, including create, update, delete, rename, and scaffold writes.',
		inputSchema: { ...repoIdentityInputSchema, branch: z.string(), message: z.string(), mode: z.enum(['preview', 'apply']).default('preview'), operations: z.array(batchWriteOperationSchema).min(1) },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, branch, message, mode, operations }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureBranchAllowed(env, branch);
			ensureNotDefaultBranch(env, branch);
			await activateRepoWorkspace(env, repoKey);
			const prepared = await prepareBatchWriteChanges(env, { owner, repo, branch, operations: operations as RepoBatchWriteOperation[] });
			if (mode === 'preview') {
				return toolText(ok({ repo_key: repoKey, branch, mode, message, base_ref_sha: prepared.base_ref_sha, can_apply: true, changed_files: prepared.changes.map((change) => ({ path: change.path, action: change.action, previous_path: change.previous_path ?? null, previous_blob_sha: change.previous_blob_sha ?? null })) }, writeAnnotations));
			}
			return toolText(ok(await commitBatchWriteChanges(env, { owner, repo, branch, message, base_ref_sha: prepared.base_ref_sha, changes: prepared.changes }), writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_batch_write_failed'), error, writeAnnotations));
		}
	}));

	server.registerTool('repo_apply_patchset', {
		description: 'Preview or atomically apply a multi-file unified patchset on an agent branch after validating each target blob. Patch paths must be repo-relative POSIX paths.',
		inputSchema: { ...repoIdentityInputSchema, branch: z.string(), message: z.string(), mode: z.enum(['preview', 'apply']).default('preview'), patches: z.array(patchsetEntrySchema).min(1) },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, branch, message, mode, patches }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			ensureBranchAllowed(env, branch);
			ensureNotDefaultBranch(env, branch);
			await activateRepoWorkspace(env, repoKey);
			const prepared = await preparePatchsetChanges(env, { owner, repo, branch, patches });
			if (mode === 'preview') {
				return toolText(ok({ repo_key: repoKey, branch, mode, message, base_ref_sha: prepared.base_ref_sha, can_apply: true, changed_files: prepared.preview }, writeAnnotations));
			}
			return toolText(ok({ preview: prepared.preview, ...(await commitBatchWriteChanges(env, { owner, repo, branch, message, base_ref_sha: prepared.base_ref_sha, changes: prepared.changes })) }, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'repo_apply_patchset_failed'), error, writeAnnotations));
		}
	}));

	server.registerTool('pr_create', {
		description: 'Create a pull request in an allowlisted repository.',
		inputSchema: { ...repoIdentityInputSchema, title: z.string(), body: z.string(), head: z.string(), base: z.string() },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, title, body, head, base }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			await activateRepoWorkspace(env, repoKey);
			return toolText(ok((await githubPost(env, `/repos/${owner}/${repo}/pulls`, { title, body, head, base })) as Record<string, unknown>, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'pr_create_failed'), error, writeAnnotations));
		}
	}));

	server.registerTool('pr_merge', {
		description: 'Merge an open pull request in an allowlisted repository when it is ready to land on the base branch.',
		inputSchema: { ...repoIdentityInputSchema, pull_number: z.number().int().positive(), merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'), commit_title: z.string().optional(), commit_message: z.string().optional(), expected_head_sha: z.string().optional() },
		annotations: { ...writeAnnotations, destructiveHint: true },
	}, withRepoIdentity(async ({ owner, repo, pull_number, merge_method, commit_title, commit_message, expected_head_sha }) => {
		try {
			const repoKey = `${owner}/${repo}`;
			ensureRepoAllowed(env, repoKey);
			await activateRepoWorkspace(env, repoKey);
			const payload: Record<string, unknown> = { merge_method };
			if (commit_title) payload.commit_title = commit_title;
			if (commit_message) payload.commit_message = commit_message;
			if (expected_head_sha) payload.sha = expected_head_sha;
			return toolText(ok((await githubPut(env, `/repos/${owner}/${repo}/pulls/${pull_number}/merge`, payload)) as Record<string, unknown>, { ...writeAnnotations, destructiveHint: true }));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'pr_merge_failed'), error, { ...writeAnnotations, destructiveHint: true }));
		}
	}));

	server.registerTool('comment_create', {
		description: 'Create an issue or PR comment in an allowlisted repository.',
		inputSchema: { ...repoIdentityInputSchema, issue_number: z.number().int().positive(), body: z.string() },
		annotations: writeAnnotations,
	}, withRepoIdentity(async ({ owner, repo, issue_number, body }) => {
		try {
			ensureRepoAllowed(env, `${owner}/${repo}`);
			return toolText(ok((await githubPost(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, { body })) as Record<string, unknown>, writeAnnotations));
		} catch (error) {
			return toolText(fail(errorCodeFor(error, 'comment_create_failed'), error, writeAnnotations));
		}
	}));
}
