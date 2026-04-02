import type { AppEnv } from '../contracts';
import { githubGet, encodeGitHubPath, encodeGitHubRef } from '../utils';
import { githubPatch, githubRequestRaw } from '../github';
import { githubPost } from '../utils';
import type { PreparedTreeChange } from './types';
import { getBranchRefSha, getCommitTreeSha } from './tree';

async function createBlob(env: AppEnv, owner: string, repo: string, contentB64: string): Promise<string> {
	const blob = (await githubPost(env, `/repos/${owner}/${repo}/git/blobs`, {
		content: contentB64,
		encoding: 'base64',
	})) as { sha?: string };
	if (!blob.sha) throw new Error('blob sha not returned');
	return blob.sha;
}

export async function commitBatchWriteChanges(
	env: AppEnv,
	input: { owner: string; repo: string; branch: string; message: string; base_ref_sha: string; changes: PreparedTreeChange[] },
): Promise<Record<string, unknown>> {
	const currentRefSha = await getBranchRefSha(env, input.owner, input.repo, input.branch);
	if (currentRefSha !== input.base_ref_sha) throw new Error(`stale ref for ${input.branch}`);
	const baseTreeSha = await getCommitTreeSha(env, input.owner, input.repo, currentRefSha);
	const tree = [];
	for (const change of input.changes) {
		let sha = change.sha;
		if (change.content_b64 !== undefined) {
			sha = await createBlob(env, input.owner, input.repo, change.content_b64);
		}
		tree.push({ path: change.path, mode: change.mode, type: change.type, sha: sha ?? null });
	}
	const createdTree = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/trees`, { base_tree: baseTreeSha, tree })) as { sha?: string };
	if (!createdTree.sha) throw new Error('tree sha not returned');
	const commit = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/commits`, {
		message: input.message,
		tree: createdTree.sha,
		parents: [currentRefSha],
	})) as { sha?: string; html_url?: string };
	if (!commit.sha) throw new Error('commit sha not returned');
	const ref = (await githubPatch(env, `/repos/${input.owner}/${input.repo}/git/refs/heads/${encodeGitHubRef(input.branch)}`, {
		sha: commit.sha,
		force: false,
	})) as Record<string, unknown>;
	return {
		commit: { sha: commit.sha, html_url: commit.html_url ?? null, parent_sha: currentRefSha, tree_sha: createdTree.sha, message: input.message },
		ref,
		changed_files: input.changes.map((change) => ({
			path: change.path,
			action: change.action,
			previous_path: change.previous_path ?? null,
			previous_blob_sha: change.previous_blob_sha ?? null,
		})),
	};
}

export async function getRepoCompareDiff(
	env: AppEnv,
	input: { owner: string; repo: string; base_ref: string; head_ref: string },
): Promise<Record<string, unknown>> {
	return (await githubGet(env, `/repos/${input.owner}/${input.repo}/compare/${encodeURIComponent(input.base_ref)}...${encodeURIComponent(input.head_ref)}`)) as Record<string, unknown>;
}

export async function deleteRepoPath(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
	path: string,
	message: string,
	expectedBlobSha: string,
): Promise<Record<string, unknown>> {
	const response = await githubRequestRaw(env, 'DELETE', `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
		body: { message, branch, sha: expectedBlobSha },
	});
	return (await response.json()) as Record<string, unknown>;
}
