import { AppEnv } from './contracts';
import { githubPatch, githubPost, githubRequestRaw } from './github';
import { encodeGitHubPath, encodeGitHubRef } from './utils';

export interface CommitUploadedFileInput {
	owner: string;
	repo: string;
	branch: string;
	path: string;
	message: string;
	content_b64: string;
	base_ref_sha: string;
	expected_blob_sha?: string | null;
}

interface RefResponse {
	object?: { sha?: string };
}

interface CommitResponse {
	tree?: { sha?: string };
}

interface ContentResponse {
	sha?: string;
	type?: string;
}

async function getRefSha(env: AppEnv, owner: string, repo: string, branch: string): Promise<string> {
	const ref = (await githubRequestRaw(
		env,
		'GET',
		`/repos/${owner}/${repo}/git/ref/heads/${encodeGitHubRef(branch)}`,
	)).json() as Promise<RefResponse>;
	const sha = (await ref).object?.sha;
	if (!sha) {
		throw new Error(`branch ref sha not found for ${branch}`);
	}
	return sha;
}

async function getTreeShaFromCommit(env: AppEnv, owner: string, repo: string, commitSha: string): Promise<string> {
	const commit = (await githubRequestRaw(env, 'GET', `/repos/${owner}/${repo}/git/commits/${commitSha}`)).json() as Promise<CommitResponse>;
	const treeSha = (await commit).tree?.sha;
	if (!treeSha) {
		throw new Error(`tree sha not found for commit ${commitSha}`);
	}
	return treeSha;
}

async function getCurrentBlobShaForPath(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
	path: string,
): Promise<string | null> {
	const encodedPath = encodeGitHubPath(path);
	try {
		const response = await githubRequestRaw(env, 'GET', `/repos/${owner}/${repo}/contents/${encodedPath}`, {
			params: { ref: branch },
		});
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			const message = await response.text();
			throw new Error(`github request failed: ${response.status} ${message}`.trim());
		}
		const payload = (await response.json()) as ContentResponse;
		if (payload.type && payload.type !== 'file') {
			throw new Error(`path is not a file: ${path}`);
		}
		return payload.sha ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('github request failed: GET') && message.includes(`/contents/${encodedPath}`) && message.includes('-> 404')) {
			return null;
		}
		throw error;
	}
}

export async function inspectFileAtBranch(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
	path: string,
): Promise<{ ref_sha: string; blob_sha: string | null }> {
	const [refSha, blobSha] = await Promise.all([
		getRefSha(env, owner, repo, branch),
		getCurrentBlobShaForPath(env, owner, repo, branch, path),
	]);
	return { ref_sha: refSha, blob_sha: blobSha };
}

export async function commitUploadedFile(
	env: AppEnv,
	input: CommitUploadedFileInput,
): Promise<Record<string, unknown>> {
	let currentRefSha = await getRefSha(env, input.owner, input.repo, input.branch);
	const currentBlobSha = await getCurrentBlobShaForPath(env, input.owner, input.repo, input.branch, input.path);
	if (currentRefSha !== input.base_ref_sha) {
		if ((input.expected_blob_sha ?? null) !== currentBlobSha && input.expected_blob_sha !== undefined && input.expected_blob_sha !== null) {
			throw new Error(
				`upload branch head changed for ${input.branch}; current_ref_sha=${currentRefSha}; base_ref_sha=${input.base_ref_sha}; current_blob_sha=${currentBlobSha ?? 'null'}; expected_blob_sha=${input.expected_blob_sha}`,
			);
		}
	}

	if ((input.expected_blob_sha ?? null) !== currentBlobSha && input.expected_blob_sha !== undefined && input.expected_blob_sha !== null) {
		throw new Error(
			`expected blob sha mismatch for ${input.path}; current_ref_sha=${currentRefSha}; current_blob_sha=${currentBlobSha ?? 'null'}; expected_blob_sha=${input.expected_blob_sha}`,
		);
	}

	const baseTreeSha = await getTreeShaFromCommit(env, input.owner, input.repo, currentRefSha);
	const blob = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/blobs`, {
		content: input.content_b64,
		encoding: 'base64',
	})) as { sha?: string; url?: string };
	if (!blob.sha) {
		throw new Error(`blob sha not returned for ${input.path}`);
	}

	const tree = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/trees`, {
		base_tree: baseTreeSha,
		tree: [
			{
				path: input.path,
				mode: '100644',
				type: 'blob',
				sha: blob.sha,
			},
		],
	})) as { sha?: string; url?: string };
	if (!tree.sha) {
		throw new Error(`tree sha not returned for ${input.path}`);
	}

	const commit = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/commits`, {
		message: input.message,
		tree: tree.sha,
		parents: [currentRefSha],
	})) as { sha?: string; url?: string };
	if (!commit.sha) {
		throw new Error(`commit sha not returned for ${input.path}`);
	}

	const refUpdate = (await githubPatch(
		env,
		`/repos/${input.owner}/${input.repo}/git/refs/heads/${encodeGitHubRef(input.branch)}`,
		{
			sha: commit.sha,
			force: false,
		},
	)) as Record<string, unknown>;

	return {
		content: {
			path: input.path,
			sha: blob.sha,
		},
		commit: {
			sha: commit.sha,
			message: input.message,
			tree_sha: tree.sha,
			base_ref_sha: input.base_ref_sha,
			parent_sha: currentRefSha,
		},
		ref: refUpdate,
		previous_blob_sha: currentBlobSha,
	};
}
