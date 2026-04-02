import type { AppEnv } from '../contracts';
import { githubGet } from '../utils';
import { decodeBase64Text, encodeGitHubPath, encodeGitHubRef } from '../utils';
import type { GitCommitResponse, GitRefResponse, RepoFileSnapshot, RepoFileTreeEntry, TreeResponse } from './types';
import { isNotFoundError } from './shared';

export async function getBranchRefSha(env: AppEnv, owner: string, repo: string, branch: string): Promise<string> {
	const ref = (await githubGet(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeGitHubRef(branch)}`)) as GitRefResponse;
	const sha = ref.object?.sha;
	if (!sha) throw new Error(`branch ref sha not found for ${branch}`);
	return sha;
}

export async function getCommitTreeSha(env: AppEnv, owner: string, repo: string, commitSha: string): Promise<string> {
	const commit = (await githubGet(env, `/repos/${owner}/${repo}/git/commits/${commitSha}`)) as GitCommitResponse;
	const treeSha = commit.tree?.sha;
	if (!treeSha) throw new Error(`tree sha not found for commit ${commitSha}`);
	return treeSha;
}

export async function getBranchTreeMap(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
): Promise<Map<string, RepoFileTreeEntry>> {
	const tree = (await githubGet(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}`, {
		params: { recursive: true },
	})) as TreeResponse;
	const map = new Map<string, RepoFileTreeEntry>();
	for (const entry of tree.tree ?? []) {
		if (typeof entry.path !== 'string' || entry.type !== 'blob') continue;
		map.set(entry.path, {
			path: entry.path,
			sha: entry.sha ?? null,
			mode: entry.mode ?? null,
			type: entry.type ?? null,
		});
	}
	return map;
}

export async function getRepoFileSnapshot(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
	path: string,
	treeMap?: Map<string, RepoFileTreeEntry>,
): Promise<RepoFileSnapshot> {
	const treeEntry = treeMap?.get(path) ?? null;
	try {
		const response = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
			params: { ref: branch },
		})) as { content?: string; sha?: string; type?: string };
		if (response.type && response.type !== 'file') {
			throw new Error(`path is not a file: ${path}`);
		}
		return {
			path,
			sha: response.sha ?? treeEntry?.sha ?? null,
			mode: treeEntry?.mode ?? '100644',
			type: 'blob',
			exists: true,
			content_b64: typeof response.content === 'string' ? response.content.replace(/\n/g, '') : null,
			content_text: decodeBase64Text(response.content),
		};
	} catch (error) {
		if (isNotFoundError(error)) {
			return {
				path,
				sha: null,
				mode: treeEntry?.mode ?? null,
				type: treeEntry?.type ?? null,
				exists: false,
				content_b64: null,
				content_text: null,
			};
		}
		throw error;
	}
}
