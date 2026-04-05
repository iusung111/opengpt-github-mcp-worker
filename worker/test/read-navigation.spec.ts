import { describe, expect, it } from 'vitest';
import {
	buildFileSummary,
	buildPathScopedIndex,
	buildNavigationManifest,
	classifyReadPath,
	getReadBudgetStatus,
	recordFileRead,
	shouldInlineFileContent,
	sliceFileChunk,
} from '../src/read-navigation';

describe('read navigation helpers', () => {
	it('classifies docs, workflows, tools, and source paths', () => {
		expect(classifyReadPath('docs/guide.md')).toBe('doc');
		expect(classifyReadPath('.github/workflows/ci.yml')).toBe('workflow');
		expect(classifyReadPath('worker/src/mcp-tools.ts')).toBe('tool');
		expect(classifyReadPath('worker/src/mcp/fullstack/api.ts')).toBe('tool');
		expect(classifyReadPath('worker/src/runtime/mcp/handlers.ts')).toBe('tool');
		expect(classifyReadPath('worker/src/index.ts')).toBe('source');
	});

	it('indexes tool implementation paths under worker/src/mcp', () => {
		expect(
			buildPathScopedIndex(
				[
					{ path: 'worker/src/mcp/fullstack/api.ts', type: 'blob' },
					{ path: 'worker/src/runtime/mcp/handlers.ts', type: 'blob' },
					{ path: 'worker/src/index.ts', type: 'blob' },
				],
				'tool',
				'api',
			),
		).toEqual([
			expect.objectContaining({
				path: 'worker/src/mcp/fullstack/api.ts',
				classification: 'tool',
			}),
		]);
	});

	it('builds manifest-first navigation for the self repo', () => {
		const manifest = buildNavigationManifest(
			{
				SELF_REPO_KEY: 'iusung111/opengpt-github-mcp-worker',
			},
			'iusung111/opengpt-github-mcp-worker',
		);
		expect(manifest).toMatchObject({
			repo_key: 'iusung111/opengpt-github-mcp-worker',
			mode: 'manifest_first',
			domains: expect.arrayContaining([
				expect.objectContaining({
					id: 'mcp',
				}),
			]),
		});
	});

	it('builds summary metadata and chunk suggestions', () => {
		const summary = buildFileSummary('docs/test.md', '# Title\n\n## Section\nbody');
		expect(summary).toMatchObject({
			classification: 'doc',
			title: 'Title',
		});
		expect((summary.chunk_suggestions as unknown[]).length).toBeGreaterThan(0);
	});

	it('slices chunks by line and anchor', () => {
		const text = '# Intro\nline1\n## Details\nline2\nline3';
		expect(sliceFileChunk(text, { start_line: 2, max_lines: 2 })).toMatchObject({
			start_line: 2,
			end_line: 3,
			text: 'line1\n## Details',
		});
		expect(sliceFileChunk(text, { anchor: 'Details', max_lines: 2 })).toMatchObject({
			start_line: 3,
		});
	});

	it('tracks budget usage and prevents inline reads after limits are exceeded', () => {
		for (let index = 0; index < 4; index += 1) {
			recordFileRead('iusung111/OpenGPT', 'worker/src/index.ts', 10);
		}
		const budget = getReadBudgetStatus('iusung111/OpenGPT');
		expect(budget).toMatchObject({
			limits_exceeded: true,
		});
		expect(shouldInlineFileContent('worker/src/index.ts', 'const a = 1;', 'iusung111/OpenGPT')).toBe(false);
	});
});
