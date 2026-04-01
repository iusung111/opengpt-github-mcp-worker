import { describe, expect, it } from 'vitest';
import { buildWorkspaceRecord, findSimilarWorkspaceMatches, sortWorkspaces } from '../src/queue-workspaces';
import { ensureSafeWorkspacePath } from '../src/queue-helpers';
import type { WorkspaceRecord } from '../src/types';

describe('queue workspace helpers', () => {
	it('builds a normalized workspace record', () => {
		const workspace = buildWorkspaceRecord(
			{
				repo_key: 'iusung111/OpenGPT',
				workspace_path: 'D:\\VScode\\projects\\OpenGPT\\',
			},
			null,
			'2026-03-21T00:00:00.000Z',
		);

		expect(workspace).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			repo_slug: 'opengpt',
			display_name: 'iusung111/OpenGPT',
			aliases: [],
			workspace_path: 'D:/VScode/projects/OpenGPT',
			last_used_at: '2026-03-21T00:00:00.000Z',
		});
	});

	it('sorts active workspace first', () => {
		const workspaces: WorkspaceRecord[] = [
			{
				repo_key: 'iusung111/opengpt-github-mcp-worker',
				repo_slug: 'opengpt-github-mcp-worker',
				display_name: 'worker',
				aliases: [],
				workspace_path: '/tmp/worker',
				created_at: '2026-03-21T00:00:00.000Z',
				updated_at: '2026-03-21T00:00:01.000Z',
				last_used_at: '2026-03-21T00:00:01.000Z',
			},
			{
				repo_key: 'iusung111/OpenGPT',
				repo_slug: 'opengpt',
				display_name: 'OpenGPT',
				aliases: ['webgpt'],
				workspace_path: '/tmp/OpenGPT',
				created_at: '2026-03-21T00:00:00.000Z',
				updated_at: '2026-03-21T00:00:02.000Z',
				last_used_at: '2026-03-21T00:00:02.000Z',
			},
		];

		const sorted = sortWorkspaces(workspaces, 'iusung111/OpenGPT');
		expect(sorted[0]?.repo_key).toBe('iusung111/OpenGPT');
		expect(sorted[0]?.is_active).toBe(true);
	});

	it('finds similar workspaces by repo key or alias', () => {
		const workspaces: Array<WorkspaceRecord & { is_active?: boolean }> = [
			{
				repo_key: 'iusung111/OpenGPT',
				repo_slug: 'opengpt',
				display_name: 'OpenGPT',
				aliases: ['webgpt'],
				workspace_path: 'D:/tmp/OpenGPT',
				created_at: '2026-03-21T00:00:00.000Z',
				updated_at: '2026-03-21T00:00:00.000Z',
			},
		];

		expect(findSimilarWorkspaceMatches(workspaces, 'webgpt')).toHaveLength(1);
		expect(findSimilarWorkspaceMatches(workspaces, undefined, 'iusung111/OpenGPT')).toHaveLength(1);
		expect(findSimilarWorkspaceMatches(workspaces, 'D:\\tmp\\OpenGPT\\')).toHaveLength(1);
	});

	it('accepts absolute workspace paths and rejects relative ones', () => {
		expect(ensureSafeWorkspacePath('D:\\VScode\\projects\\opengpt\\')).toBe('D:/VScode/projects/opengpt');
		expect(ensureSafeWorkspacePath('/home/uieseong/workspace/projects/opengpt')).toBe(
			'/home/uieseong/workspace/projects/opengpt',
		);
		expect(() => ensureSafeWorkspacePath('../unsafe')).toThrow(/invalid workspace path/i);
	});
});
