import { describe, expect, it } from 'vitest';
import { rankIndexMatches, scoreSearchIndexText } from '../src/read-index-match';
import { prepareSearchQuery, tokenizeSearchQuery } from '../src/read-query';

describe('read index matching helpers', () => {
	it('tokenizes natural-language search queries into stable tokens', () => {
		expect(tokenizeSearchQuery('tool index, read observability, manifest, cache')).toEqual([
			'tool',
			'index',
			'read',
			'observability',
			'manifest',
			'cache',
		]);
	});

	it('prefers exact and phrase matches over partial token hits', () => {
		const query = prepareSearchQuery('repo_tool_index_lookup');
		const exact = scoreSearchIndexText({ primaryText: 'repo_tool_index_lookup' }, query);
		const partial = scoreSearchIndexText({ primaryText: 'worker/src/mcp/repo-read/navigation.ts' }, query);
		expect(exact.score).toBeGreaterThan(partial.score);
	});

	it('ranks multi-token partial matches ahead of unrelated entries', () => {
		const ranked = rankIndexMatches(
			[
				{ path: 'worker/src/tool-catalog.json' },
				{ path: 'worker/src/mcp/repo-read/navigation.ts' },
				{ path: 'worker/src/index.ts' },
			],
			(entry) => ({
					primaryText: entry.path,
					secondaryText: [entry.path.split('/').pop() ?? entry.path],
				}),
			prepareSearchQuery('tool index, read observability, manifest, cache'),
		);
		expect(ranked.map((entry) => entry.value.path)).toEqual(
			expect.arrayContaining([
				'worker/src/tool-catalog.json',
				'worker/src/mcp/repo-read/navigation.ts',
			]),
		);
	});
});
