import { AppEnv } from './types';
import { githubPatch, githubRequestRaw } from './github';
import { applyUnifiedPatch } from './unified-patch';
import {
	decodeBase64Text,
	encodeBase64Text,
	encodeGitHubPath,
	encodeGitHubRef,
	ensureSafePath,
	githubGet,
	githubPost,
} from './utils';

export type RepoBatchWriteMode = 'preview' | 'apply';

export interface RepoBatchWriteOperation {
	type: 'create_file' | 'update_file' | 'delete_file' | 'rename_path' | 'mkdir_scaffold';
	path?: string;
	from_path?: string;
	to_path?: string;
	message?: string;
	content_b64?: string;
	expected_blob_sha?: string;
	entries?: Array<{ path: string; content_b64?: string }>;
}

export interface RepoPatchsetInput {
	path: string;
	expected_blob_sha?: string;
	patch_unified: string;
}

export interface RepoFileTreeEntry {
	path: string;
	sha: string | null;
	mode: string | null;
	type: string | null;
}

export interface RepoFileSnapshot extends RepoFileTreeEntry {
	exists: boolean;
	content_b64: string | null;
	content_text: string | null;
}

interface GitRefResponse {
	object?: { sha?: string };
}

interface GitCommitResponse {
	tree?: { sha?: string };
}

interface TreeResponse {
	tree?: Array<{ path?: string; sha?: string; mode?: string; type?: string }>;
}

interface PreparedTreeChange {
	path: string;
	action: 'create' | 'update' | 'delete' | 'rename' | 'mkdir_scaffold';
	mode: string;
	type: 'blob';
	sha?: string | null;
	content_b64?: string;
	previous_path?: string | null;
	previous_blob_sha?: string | null;
}

function isNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('github request failed: 404');
}

function defaultFileMode(mode?: string | null): string {
	return mode && mode.trim() ? mode : '100644';
}

function normalizeOptionalBase64(content_b64: string | undefined, fallback = ''): string {
	const value = content_b64 ?? btoa(fallback);
	atob(value);
	return value;
}

export async function getBranchRefSha(
	env: AppEnv,
	owner: string,
	repo: string,
	branch: string,
): Promise<string> {
	const ref = (await githubGet(
		env,
		`/repos/${owner}/${repo}/git/ref/heads/${encodeGitHubRef(branch)}`,
	)) as GitRefResponse;
	const sha = ref.object?.sha;
	if (!sha) {
		throw new Error(`branch ref sha not found for ${branch}`);
	}
	return sha;
}

export async function getCommitTreeSha(
	env: AppEnv,
	owner: string,
	repo: string,
	commitSha: string,
): Promise<string> {
	const commit = (await githubGet(env, `/repos/${owner}/${repo}/git/commits/${commitSha}`)) as GitCommitResponse;
	const treeSha = commit.tree?.sha;
	if (!treeSha) {
		throw new Error(`tree sha not found for commit ${commitSha}`);
	}
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
		if (typeof entry.path !== 'string' || entry.type !== 'blob') {
			continue;
		}
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

function ensureExpectedBlobSha(snapshot: RepoFileSnapshot, expectedBlobSha?: string): void {
	if (expectedBlobSha !== undefined && expectedBlobSha !== snapshot.sha) {
		throw new Error(`expected blob sha mismatch for ${snapshot.path}`);
	}
}

function buildScaffoldEntries(
	basePath: string,
	entries: Array<{ path: string; content_b64?: string }> | undefined,
): Array<{ path: string; content_b64: string }> {
	if (!entries || entries.length === 0) {
		return [{ path: `${basePath.replace(/\/+$/, '')}/.gitkeep`, content_b64: btoa('') }];
	}
	return entries.map((entry) => {
		const relativePath = entry.path.replace(/^\/+/, '');
		return {
			path: `${basePath.replace(/\/+$/, '')}/${relativePath}`,
			content_b64: normalizeOptionalBase64(entry.content_b64),
		};
	});
}

export async function prepareBatchWriteChanges(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		branch: string;
		operations: RepoBatchWriteOperation[];
	},
): Promise<{ base_ref_sha: string; changes: PreparedTreeChange[] }> {
	const { owner, repo, branch, operations } = input;
	const [baseRefSha, treeMap] = await Promise.all([
		getBranchRefSha(env, owner, repo, branch),
		getBranchTreeMap(env, owner, repo, branch),
	]);
	const changes: PreparedTreeChange[] = [];
	const reservedPaths = new Set<string>();

	for (const operation of operations) {
		if (operation.type === 'create_file' || operation.type === 'update_file' || operation.type === 'delete_file') {
			const path = operation.path ?? '';
			ensureSafePath(path);
			const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, path, treeMap);
			ensureExpectedBlobSha(snapshot, operation.expected_blob_sha);
			if (operation.type === 'create_file' && snapshot.exists) {
				throw new Error(`path already exists: ${path}`);
			}
			if ((operation.type === 'update_file' || operation.type === 'delete_file') && !snapshot.exists) {
				throw new Error(`path not found: ${path}`);
			}
			if (reservedPaths.has(path)) {
				throw new Error(`path already modified in batch: ${path}`);
			}
			reservedPaths.add(path);
			changes.push({
				path,
				action: operation.type === 'delete_file' ? 'delete' : operation.type === 'create_file' ? 'create' : 'update',
				mode: defaultFileMode(snapshot.mode),
				type: 'blob',
				sha: operation.type === 'delete_file' ? null : undefined,
				content_b64:
					operation.type === 'delete_file'
						? undefined
						: normalizeOptionalBase64(operation.content_b64),
				previous_blob_sha: snapshot.sha,
				previous_path: null,
			});
			continue;
		}

		if (operation.type === 'rename_path') {
			const fromPath = operation.from_path ?? '';
			const toPath = operation.to_path ?? '';
			ensureSafePath(fromPath);
			ensureSafePath(toPath);
			if (reservedPaths.has(fromPath) || reservedPaths.has(toPath)) {
				throw new Error(`path already modified in batch: ${fromPath} or ${toPath}`);
			}
			const [fromSnapshot, toSnapshot] = await Promise.all([
				getRepoFileSnapshot(env, owner, repo, branch, fromPath, treeMap),
				getRepoFileSnapshot(env, owner, repo, branch, toPath, treeMap),
			]);
			if (!fromSnapshot.exists) {
				throw new Error(`path not found: ${fromPath}`);
			}
			if (toSnapshot.exists) {
				throw new Error(`path already exists: ${toPath}`);
			}
			ensureExpectedBlobSha(fromSnapshot, operation.expected_blob_sha);
			reservedPaths.add(fromPath);
			reservedPaths.add(toPath);
			changes.push({
				path: fromPath,
				action: 'delete',
				mode: defaultFileMode(fromSnapshot.mode),
				type: 'blob',
				sha: null,
				previous_blob_sha: fromSnapshot.sha,
				previous_path: null,
			});
			changes.push({
				path: toPath,
				action: 'rename',
				mode: defaultFileMode(fromSnapshot.mode),
				type: 'blob',
				sha: fromSnapshot.sha,
				content_b64: fromSnapshot.content_b64 ?? undefined,
				previous_blob_sha: fromSnapshot.sha,
				previous_path: fromPath,
			});
			continue;
		}

		if (operation.type === 'mkdir_scaffold') {
			const basePath = operation.path ?? '';
			ensureSafePath(basePath);
			for (const entry of buildScaffoldEntries(basePath, operation.entries)) {
				ensureSafePath(entry.path);
				if (reservedPaths.has(entry.path)) {
					throw new Error(`path already modified in batch: ${entry.path}`);
				}
				const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, entry.path, treeMap);
				if (snapshot.exists) {
					throw new Error(`path already exists: ${entry.path}`);
				}
				reservedPaths.add(entry.path);
				changes.push({
					path: entry.path,
					action: 'mkdir_scaffold',
					mode: '100644',
					type: 'blob',
					content_b64: entry.content_b64,
					previous_blob_sha: null,
					previous_path: null,
				});
			}
			continue;
		}

		throw new Error(`unsupported batch operation: ${operation.type}`);
	}

	return { base_ref_sha: baseRefSha, changes };
}

async function createBlob(
	env: AppEnv,
	owner: string,
	repo: string,
	contentB64: string,
): Promise<string> {
	const blob = (await githubPost(env, `/repos/${owner}/${repo}/git/blobs`, {
		content: contentB64,
		encoding: 'base64',
	})) as { sha?: string };
	if (!blob.sha) {
		throw new Error('blob sha not returned');
	}
	return blob.sha;
}

export async function commitBatchWriteChanges(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		branch: string;
		message: string;
		base_ref_sha: string;
		changes: PreparedTreeChange[];
	},
): Promise<Record<string, unknown>> {
	const currentRefSha = await getBranchRefSha(env, input.owner, input.repo, input.branch);
	if (currentRefSha !== input.base_ref_sha) {
		throw new Error(`stale ref for ${input.branch}`);
	}

	const baseTreeSha = await getCommitTreeSha(env, input.owner, input.repo, currentRefSha);
	const tree = [];
	for (const change of input.changes) {
		let sha = change.sha;
		if (change.content_b64 !== undefined) {
			sha = await createBlob(env, input.owner, input.repo, change.content_b64);
		}
		tree.push({
			path: change.path,
			mode: change.mode,
			type: change.type,
			sha: sha ?? null,
		});
	}

	const createdTree = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/trees`, {
		base_tree: baseTreeSha,
		tree,
	})) as { sha?: string };
	if (!createdTree.sha) {
		throw new Error('tree sha not returned');
	}

	const commit = (await githubPost(env, `/repos/${input.owner}/${input.repo}/git/commits`, {
		message: input.message,
		tree: createdTree.sha,
		parents: [currentRefSha],
	})) as { sha?: string; html_url?: string };
	if (!commit.sha) {
		throw new Error('commit sha not returned');
	}

	const ref = (await githubPatch(
		env,
		`/repos/${input.owner}/${input.repo}/git/refs/heads/${encodeGitHubRef(input.branch)}`,
		{
			sha: commit.sha,
			force: false,
		},
	)) as Record<string, unknown>;

	return {
		commit: {
			sha: commit.sha,
			html_url: commit.html_url ?? null,
			parent_sha: currentRefSha,
			tree_sha: createdTree.sha,
			message: input.message,
		},
		ref,
		changed_files: input.changes.map((change) => ({
			path: change.path,
			action: change.action,
			previous_path: change.previous_path ?? null,
			previous_blob_sha: change.previous_blob_sha ?? null,
		})),
	};
}

export async function preparePatchsetChanges(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		branch: string;
		patches: RepoPatchsetInput[];
	},
): Promise<{
		base_ref_sha: string;
		changes: PreparedTreeChange[];
		preview: Array<Record<string, unknown>>;
	}> {
	const { owner, repo, branch, patches } = input;
	const [baseRefSha, treeMap] = await Promise.all([
		getBranchRefSha(env, owner, repo, branch),
		getBranchTreeMap(env, owner, repo, branch),
	]);
	const changes: PreparedTreeChange[] = [];
	const preview: Array<Record<string, unknown>> = [];
	const reservedPaths = new Set<string>();

	for (const patch of patches) {
		ensureSafePath(patch.path);
		if (reservedPaths.has(patch.path)) {
			throw new Error(`path already modified in patchset: ${patch.path}`);
		}
		reservedPaths.add(patch.path);
		const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, patch.path, treeMap);
		ensureExpectedBlobSha(snapshot, patch.expected_blob_sha);
		if (snapshot.exists && snapshot.content_text === null) {
			throw new Error(`path is not a text file: ${patch.path}`);
		}
		const applyResult = applyUnifiedPatch(snapshot.content_text ?? '', patch.patch_unified);
		if (!applyResult.ok || applyResult.text === undefined) {
			throw new Error(
				`patch conflict for ${patch.path} at line ${applyResult.conflict?.line_number ?? 0}: expected ${applyResult.conflict?.expected ?? 'unknown'}`,
			);
		}
		const action = snapshot.exists ? 'update' : 'create';
		changes.push({
			path: patch.path,
			action,
			mode: defaultFileMode(snapshot.mode),
			type: 'blob',
			content_b64: encodeBase64Text(applyResult.text),
			previous_blob_sha: snapshot.sha,
			previous_path: null,
		});
		preview.push({
			path: patch.path,
			action,
			previous_blob_sha: snapshot.sha,
			additions: applyResult.additions,
			deletions: applyResult.deletions,
			hunks: applyResult.hunks,
		});
	}

	return {
		base_ref_sha: baseRefSha,
		changes,
		preview,
	};
}

export async function getRepoCompareDiff(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		base_ref: string;
		head_ref: string;
	},
): Promise<Record<string, unknown>> {
	return (await githubGet(
		env,
		`/repos/${input.owner}/${input.repo}/compare/${encodeURIComponent(input.base_ref)}...${encodeURIComponent(input.head_ref)}`,
	)) as Record<string, unknown>;
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
		body: {
			message,
			branch,
			sha: expectedBlobSha,
		},
	});
	return (await response.json()) as Record<string, unknown>;
}
