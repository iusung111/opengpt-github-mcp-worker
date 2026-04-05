import type { PreparedSearchQuery } from './read-query';
import { normalizeSearchText } from './read-query';

export type SearchIndexText = {
	primaryText: string;
	secondaryText?: string[];
};

export type RankedIndexMatch<T> = {
	value: T;
	score: number;
	matchedTokens: string[];
};

function scoreCandidate(candidate: string, query: PreparedSearchQuery): { score: number; matchedTokens: string[] } {
	if (!query.normalized) {
		return { score: 1, matchedTokens: [] };
	}
	const normalizedCandidate = normalizeSearchText(candidate);
	if (!normalizedCandidate) {
		return { score: 0, matchedTokens: [] };
	}
	if (normalizedCandidate === query.normalized) {
		return { score: 1000, matchedTokens: [...query.tokens] };
	}
	if (normalizedCandidate.includes(query.normalized)) {
		return { score: 700 + query.tokens.length * 25, matchedTokens: [...query.tokens] };
	}
	const matchedTokens = query.tokens.filter((token) => normalizedCandidate.includes(token));
	if (matchedTokens.length === 0) {
		return { score: 0, matchedTokens: [] };
	}
	if (matchedTokens.length === query.tokens.length) {
		return { score: 500 + matchedTokens.length * 25, matchedTokens };
	}
	return { score: 100 + matchedTokens.length * 25, matchedTokens };
}

export function scoreSearchIndexText(
	text: SearchIndexText,
	query: PreparedSearchQuery,
): { score: number; matchedTokens: string[] } {
	const candidates = [text.primaryText, ...(text.secondaryText ?? [])];
	let bestScore = 0;
	let bestMatchedTokens: string[] = [];
	for (const candidate of candidates) {
		const candidateScore = scoreCandidate(candidate, query);
		if (candidateScore.score > bestScore) {
			bestScore = candidateScore.score;
			bestMatchedTokens = candidateScore.matchedTokens;
		}
	}
	return { score: bestScore, matchedTokens: bestMatchedTokens };
}

export function rankIndexMatches<T>(
	entries: T[],
	selectText: (entry: T) => SearchIndexText,
	query: PreparedSearchQuery,
): Array<RankedIndexMatch<T>> {
	return entries
		.map((entry, index) => {
			const text = selectText(entry);
			const scored = scoreSearchIndexText(text, query);
			return {
				index,
				text,
				value: entry,
				score: scored.score,
				matchedTokens: scored.matchedTokens,
			};
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return left.index - right.index;
		})
		.map(({ value, score, matchedTokens }) => ({
			value,
			score,
			matchedTokens,
		}));
}
