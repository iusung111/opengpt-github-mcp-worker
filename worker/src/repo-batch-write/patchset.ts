import type { AppEnv } from '../contracts';
import { applyUnifiedPatch } from '../unified-patch';
import { encodeBase64Text, ensureSafeRepoPath } from '../utils';
import type { PreparedTreeChange, RepoPatchsetInput } from './types';
import { defaultFileMode, ensureExpectedBlobSha } from './shared';
import { getBranchRefSha, getBranchTreeMap, getRepoFileSnapshot } from './tree';

export async function preparePatchsetChanges(
	env: AppEnv,
	input: { owner: string; repo: string; branch: string; patches: RepoPatchsetInput[] },
): Promise<{ base_ref_sha: string; changes: PreparedTreeChange[]; preview: Array<Record<string, unknown>> }> {
	const { owner, repo, branch, patches } = input;
	for (const patch of patches) ensureSafeRepoPath(patch.path);
	const [baseRefSha, treeMap] = await Promise.all([
		getBranchRefSha(env, owner, repo, branch),
		getBranchTreeMap(env, owner, repo, branch),
	]);
	const changes: PreparedTreeChange[] = [];
	const preview: Array<Record<string, unknown>> = [];
	const reservedPaths = new Set<string>();

	for (const patch of patches) {
		ensureSafeRepoPath(patch.path);
		if (reservedPaths.has(patch.path)) throw new Error(`path already modified in patchset: ${patch.path}`);
		reservedPaths.add(patch.path);
		const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, patch.path, treeMap);
		ensureExpectedBlobSha(snapshot, patch.expected_blob_sha);
		if (snapshot.exists && snapshot.content_text === null) throw new Error(`path is not a text file: ${patch.path}`);
		const applyResult = applyUnifiedPatch(snapshot.content_text ?? '', patch.patch_unified);
		if (!applyResult.ok || applyResult.text === undefined) {
			throw new Error(`patch conflict for ${patch.path} at line ${applyResult.conflict?.line_number ?? 0}: expected ${applyResult.conflict?.expected ?? 'unknown'}`);
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

	return { base_ref_sha: baseRefSha, changes, preview };
}
