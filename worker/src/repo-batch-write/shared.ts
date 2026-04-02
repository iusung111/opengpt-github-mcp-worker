import { ensureSafeRepoPath } from '../utils';
import type { RepoBatchWriteOperation, RepoFileSnapshot } from './types';

export function isNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('github request failed:') && message.includes(' 404 ');
}

export function defaultFileMode(mode?: string | null): string {
	return mode && mode.trim() ? mode : '100644';
}

export function normalizeOptionalBase64(content_b64: string | undefined, fallback = ''): string {
	const value = content_b64 ?? btoa(fallback);
	atob(value);
	return value;
}

export function ensureExpectedBlobSha(snapshot: RepoFileSnapshot, expectedBlobSha?: string): void {
	if (expectedBlobSha !== undefined && expectedBlobSha !== snapshot.sha) {
		throw new Error(`expected blob sha mismatch for ${snapshot.path}`);
	}
}

export function buildScaffoldEntries(
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

export function validateBatchWriteOperationPaths(operations: RepoBatchWriteOperation[]): void {
	for (const operation of operations) {
		if (operation.type === 'create_file' || operation.type === 'update_file' || operation.type === 'delete_file') {
			ensureSafeRepoPath(operation.path ?? '');
			continue;
		}
		if (operation.type === 'rename_path') {
			ensureSafeRepoPath(operation.from_path ?? '');
			ensureSafeRepoPath(operation.to_path ?? '');
			continue;
		}
		if (operation.type === 'mkdir_scaffold') {
			const basePath = operation.path ?? '';
			ensureSafeRepoPath(basePath);
			for (const entry of buildScaffoldEntries(basePath, operation.entries)) {
				ensureSafeRepoPath(entry.path);
			}
		}
	}
}
