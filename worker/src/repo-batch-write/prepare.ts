import type { AppEnv } from '../contracts';
import { ensureSafeRepoPath } from '../utils';
import type { PreparedTreeChange, RepoBatchWriteOperation } from './types';
import { buildScaffoldEntries, defaultFileMode, ensureExpectedBlobSha, normalizeOptionalBase64, validateBatchWriteOperationPaths } from './shared';
import { getBranchRefSha, getBranchTreeMap, getRepoFileSnapshot } from './tree';

export async function prepareBatchWriteChanges(
	env: AppEnv,
	input: { owner: string; repo: string; branch: string; operations: RepoBatchWriteOperation[] },
): Promise<{ base_ref_sha: string; changes: PreparedTreeChange[] }> {
	const { owner, repo, branch, operations } = input;
	validateBatchWriteOperationPaths(operations);
	const [baseRefSha, treeMap] = await Promise.all([
		getBranchRefSha(env, owner, repo, branch),
		getBranchTreeMap(env, owner, repo, branch),
	]);
	const changes: PreparedTreeChange[] = [];
	const reservedPaths = new Set<string>();

	for (const operation of operations) {
		if (operation.type === 'create_file' || operation.type === 'update_file' || operation.type === 'delete_file') {
			const path = operation.path ?? '';
			ensureSafeRepoPath(path);
			const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, path, treeMap);
			ensureExpectedBlobSha(snapshot, operation.expected_blob_sha);
			if (operation.type === 'create_file' && snapshot.exists) throw new Error(`path already exists: ${path}`);
			if ((operation.type === 'update_file' || operation.type === 'delete_file') && !snapshot.exists) throw new Error(`path not found: ${path}`);
			if (reservedPaths.has(path)) throw new Error(`path already modified in batch: ${path}`);
			reservedPaths.add(path);
			changes.push({
				path,
				action: operation.type === 'delete_file' ? 'delete' : operation.type === 'create_file' ? 'create' : 'update',
				mode: defaultFileMode(snapshot.mode),
				type: 'blob',
				sha: operation.type === 'delete_file' ? null : undefined,
				content_b64: operation.type === 'delete_file' ? undefined : normalizeOptionalBase64(operation.content_b64),
				previous_blob_sha: snapshot.sha,
				previous_path: null,
			});
			continue;
		}

		if (operation.type === 'rename_path') {
			const fromPath = operation.from_path ?? '';
			const toPath = operation.to_path ?? '';
			ensureSafeRepoPath(fromPath);
			ensureSafeRepoPath(toPath);
			if (reservedPaths.has(fromPath) || reservedPaths.has(toPath)) throw new Error(`path already modified in batch: ${fromPath} or ${toPath}`);
			const [fromSnapshot, toSnapshot] = await Promise.all([
				getRepoFileSnapshot(env, owner, repo, branch, fromPath, treeMap),
				getRepoFileSnapshot(env, owner, repo, branch, toPath, treeMap),
			]);
			if (!fromSnapshot.exists) throw new Error(`path not found: ${fromPath}`);
			if (toSnapshot.exists) throw new Error(`path already exists: ${toPath}`);
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
			ensureSafeRepoPath(basePath);
			for (const entry of buildScaffoldEntries(basePath, operation.entries)) {
				ensureSafeRepoPath(entry.path);
				if (reservedPaths.has(entry.path)) throw new Error(`path already modified in batch: ${entry.path}`);
				const snapshot = await getRepoFileSnapshot(env, owner, repo, branch, entry.path, treeMap);
				if (snapshot.exists) throw new Error(`path already exists: ${entry.path}`);
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
