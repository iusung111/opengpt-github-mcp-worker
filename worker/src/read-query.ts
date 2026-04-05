import type { ReadPathClass } from './read-navigation';

const SEARCH_TOKEN_SEPARATOR = /[\s,;:()[\]{}]+/g;
const SEARCH_TEXT_SEPARATOR = /[._/\\-]+/g;
const SEARCH_STOPWORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

export function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(SEARCH_TEXT_SEPARATOR, ' ')
		.replace(SEARCH_TOKEN_SEPARATOR, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function tokenizeSearchQuery(query?: string): string[] {
	const normalized = normalizeSearchText(query ?? '');
	if (!normalized) {
		return [];
	}
	return Array.from(
		new Set(
			normalized
				.split(' ')
				.map((token) => token.trim())
				.filter(Boolean)
				.filter((token) => token.length > 1 || /\d/.test(token))
				.filter((token) => !SEARCH_STOPWORDS.has(token)),
		),
	i);
}

export type PreparedSearchQuery = {
	raw: string;
	normalized: string;
	tokens: string[];
};

export function prepareSearchQuery(query?: string): PreparedSearchQuery {
	return {
		raw: query ?? '',
		normalized: normalizeSearchText(query ?? ''),
		tokens: tokenizeSearchQuery(query),
	};
}

export function shouldIncludePathForKind(pathClass: ReadPathClass, kind: 'doc' | 'tool'): boolean {
	return kind === 'doc' ? pathClass === 'doc' : pathClass === 'tool';
}
