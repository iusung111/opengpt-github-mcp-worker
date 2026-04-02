import { WorkspaceRecord } from './contracts';
import { normalizeLookup, normalizeWorkspacePath } from './queue-helpers';
import { parseIsoMs } from './utils';

export function normalizeWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
	return {
		...workspace,
		repo_slug: workspace.repo_slug || normalizeLookup(workspace.repo_key.split('/').pop()),
		display_name: workspace.display_name || workspace.repo_key,
		aliases: Array.isArray(workspace.aliases) ? workspace.aliases : [],
		workspace_path: normalizeWorkspacePath(workspace.workspace_path),
	};
}

export function workspaceRecordNeedsNormalization(workspace: WorkspaceRecord): boolean {
	const normalized = normalizeWorkspaceRecord(workspace);
	return JSON.stringify(normalized) !== JSON.stringify(workspace);
}

export function buildWorkspaceRecord(
	input: Partial<WorkspaceRecord> & { repo_key: string; workspace_path: string },
	existing: WorkspaceRecord | null,
	timestamp: string,
): WorkspaceRecord {
	const repoSlug = input.repo_slug || normalizeLookup(input.repo_key.split('/').pop());
	return {
		...(existing ?? {}),
		...input,
		repo_key: input.repo_key,
		workspace_path: normalizeWorkspacePath(input.workspace_path),
		repo_slug: repoSlug,
		display_name: input.display_name || existing?.display_name || input.repo_key,
		aliases: input.aliases ?? existing?.aliases ?? [],
		created_at: existing?.created_at ?? timestamp,
		updated_at: timestamp,
		last_used_at: timestamp,
	};
}

export function sortWorkspaces(
	workspaces: WorkspaceRecord[],
	activeRepoKey: string | null,
): Array<WorkspaceRecord & { is_active?: boolean }> {
	const workspacesWithMeta = workspaces.map((workspace) => ({
		workspace: normalizeWorkspaceRecord(workspace),
		isActive: workspace.repo_key === activeRepoKey,
		usedMs: parseIsoMs(workspace.last_used_at) ?? 0,
		updatedMs: parseIsoMs(workspace.updated_at) ?? 0,
	}));

	return workspacesWithMeta
		.sort((left, right) => {
			if (left.isActive !== right.isActive) {
				return right.isActive ? 1 : -1;
			}
			if (left.usedMs !== right.usedMs) {
				return right.usedMs - left.usedMs;
			}
			if (left.updatedMs !== right.updatedMs) {
				return right.updatedMs - left.updatedMs;
			}
			return left.workspace.repo_key.localeCompare(right.workspace.repo_key);
		})
		.map((item) => ({
			...item.workspace,
			is_active: item.isActive,
		}));
}

export function findSimilarWorkspaceMatches(
	workspaces: Array<WorkspaceRecord & { is_active?: boolean }>,
	query?: string,
	repoKey?: string,
): WorkspaceRecord[] {
	const target = normalizeLookup(query || repoKey || '');
	const repoSlug = normalizeLookup((repoKey || '').split('/').pop() ?? '');
	return workspaces
		.map((workspace) => {
			const normalizedWorkspace = normalizeWorkspaceRecord(workspace);
			const candidates = [
				normalizedWorkspace.repo_key,
				normalizedWorkspace.repo_slug,
				normalizedWorkspace.display_name,
				normalizedWorkspace.workspace_path,
				...(normalizedWorkspace.aliases ?? []),
			].map(normalizeLookup);
			let score = 0;
			if (repoKey && candidates.includes(normalizeLookup(repoKey))) {
				score = 100;
			} else if (repoSlug && candidates.includes(repoSlug)) {
				score = 90;
			} else if (target && candidates.some((item) => item === target)) {
				score = 80;
			} else if (target && candidates.some((item) => item.includes(target))) {
				score = 50;
			}
			return { workspace: normalizedWorkspace, score };
		})
		.filter((match) => match.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((match) => match.workspace);
}

