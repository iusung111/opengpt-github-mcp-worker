import { getSelfRepoKey } from './utils';
import { AppEnv } from './contracts';
import { incrementReadCounter } from './read-observability';

export type ReadPathClass =
	| 'source'
	| 'doc'
	| 'tool'
	| 'workflow'
	| 'config'
	| 'generated'
	| 'artifact'
	| 'binary';

export interface NavigationManifestDomain {
	id: string;
	label: string;
	purpose: string;
	entry_paths: string[];
	next_paths: string[];
}

const MAX_INLINE_FILE_BYTES = 24_000;
const DEFAULT_MAX_UNIQUE_FILES = 24;
const DEFAULT_MAX_TOTAL_BYTES = 180_000;
const DEFAULT_REPEAT_LIMIT = 3;

const readBudgetState = new Map<
	string,
	{
		unique_files: Set<string>;
		total_bytes: number;
		read_counts: Map<string, number>;
	}
>();

function ensureBudgetState(repoKey: string) {
	const existing = readBudgetState.get(repoKey);
	if (existing) {
		return existing;
	}
	const created = {
		unique_files: new Set<string>(),
		total_bytes: 0,
		read_counts: new Map<string, number>(),
	};
	readBudgetState.set(repoKey, created);
	return created;
}

export function classifyReadPath(path: string): ReadPathClass {
	const normalized = path.toLowerCase();
	if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz|pdf|svg|woff2?|ttf|mp4|mov|mp3)$/.test(normalized)) {
		return 'binary';
	}
	if (
		normalized.includes('/dist/') ||
		normalized.includes('/build/') ||
		normalized.includes('/coverage/') ||
		normalized.endsWith('.min.js') ||
		normalized.endsWith('.lock')
	) {
		return 'generated';
	}
	if (normalized.startsWith('docs/') || normalized.endsWith('.md')) {
		return 'doc';
	}
	if (normalized.includes('.github/workflows/')) {
		return 'workflow';
	}
	if (
		normalized.includes('tool-catalog') ||
		normalized.includes('/mcp-') ||
		normalized.includes('/mcp/')
	) {
		return 'tool';
	}
	if (
		normalized.endsWith('.json') ||
		normalized.endsWith('.jsonc') ||
		normalized.endsWith('.yaml') ||
		normalized.endsWith('.yml') ||
		normalized.endsWith('.toml')
	) {
		return 'config';
	}
	if (normalized.includes('/artifacts/') || normalized.includes('/snapshots/')) {
		return 'artifact';
	}
	return 'source';
}

export function extractHeadings(text: string): Array<{ line: number; text: string }> {
	return text
		.split(/\r?\n/g)
		.map((line, index) => ({ line: index + 1, text: line.trim() }))
		.filter((line) => /^#{1,6}\s+/.test(line.text))
		.map((line) => ({
			line: line.line,
			text: line.text.replace(/^#{1,6}\s+/, '').trim(),
		}));
}

function detectTitle(path: string, text: string): string {
	const headings = extractHeadings(text);
	if (headings.length > 0) {
		return headings[0].text;
	}
	const firstNonEmpty = text
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.find(Boolean);
	if (firstNonEmpty) {
		return firstNonEmpty.slice(0, 120);
	}
	return path.split('/').pop() ?? path;
}

export function buildFileSummary(path: string, text: string): Record<string, unknown> {
	const headings = extractHeadings(text);
	const lines = text.split(/\r?\n/g);
	const classification = classifyReadPath(path);
	const title = detectTitle(path, text);
	const chunkSuggestions =
		headings.length > 0
			? headings.slice(0, 8).map((heading) => ({
					anchor: heading.text,
					start_line: heading.line,
					end_line: Math.min(lines.length, heading.line + 40),
			  }))
			: [
					{
						anchor: 'start',
						start_line: 1,
						end_line: Math.min(lines.length, 80),
					},
			  ];
	return {
		path,
		classification,
		title,
		line_count: lines.length,
		byte_length: text.length,
		headings: headings.slice(0, 12),
		preview: lines.slice(0, 12).join('\n'),
		recommended_access: classification === 'source' ? 'chunk_or_inline' : 'summary_then_chunk',
		chunk_suggestions: chunkSuggestions,
	};
}

export function sliceFileChunk(
	text: string,
	options: { start_line?: number; max_lines?: number; anchor?: string },
): Record<string, unknown> {
	const lines = text.split(/\r?\n/g);
	let startLine = Math.max(1, options.start_line ?? 1);
	if (options.anchor) {
		const headings = extractHeadings(text);
		const matched = headings.find((heading) => heading.text.toLowerCase().includes(options.anchor!.toLowerCase()));
		if (matched) {
			startLine = matched.line;
		}
	}
	const maxLines = Math.min(Math.max(1, options.max_lines ?? 80), 200);
	const endLine = Math.min(lines.length, startLine + maxLines - 1);
	return {
		start_line: startLine,
		end_line: endLine,
		line_count: endLine - startLine + 1,
		text: lines.slice(startLine - 1, endLine).join('\n'),
	};
}

export function shouldInlineFileContent(path: string, text: string, repoKey: string): boolean {
	const classification = classifyReadPath(path);
	const budget = getReadBudgetStatus(repoKey);
	if (classification !== 'source') {
		return false;
	}
	if (text.length > MAX_INLINE_FILE_BYTES) {
		return false;
	}
	if (budget.limits_exceeded) {
		return false;
	}
	return true;
}

export function recordFileRead(repoKey: string, path: string, bytesRead: number): void {
	const state = ensureBudgetState(repoKey);
	state.unique_files.add(path);
	state.total_bytes += bytesRead;
	state.read_counts.set(path, (state.read_counts.get(path) ?? 0) + 1);
}

export function getReadBudgetStatus(repoKey: string): Record<string, unknown> {
	const state = ensureBudgetState(repoKey);
	const repeatedPaths = Array.from(state.read_counts.entries())
		.filter(([, count]) => count > DEFAULT_REPEAT_LIMIT)
		.map(([path, count]) => ({ path, count }));
	return {
		repo_key: repoKey,
		limits: {
			max_unique_files: DEFAULT_MAX_UNIQUE_FILES,
			max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
			repeat_limit_per_path: DEFAULT_REPEAT_LIMIT,
		},
		usage: {
			unique_files: state.unique_files.size,
			total_bytes: state.total_bytes,
			recent_paths: Array.from(state.read_counts.keys()).slice(-12),
			repeated_paths: repeatedPaths,
		},
		limits_exceeded:
			state.unique_files.size > DEFAULT_MAX_UNIQUE_FILES ||
			state.total_bytes > DEFAULT_MAX_TOTAL_BYTES ||
			repeatedPaths.length > 0,
	};
}

export function buildNavigationManifest(env: AppEnv, repoKey: string): Record<string, unknown> {
	const selfRepoKey = getSelfRepoKey(env);
	if (repoKey === selfRepoKey) {
		incrementReadCounter('manifest_hit');
		const domains: NavigationManifestDomain[] = [
			{
				id: 'mcp',
				label: 'MCP',
				purpose: 'Tool surface, routing, and ChatGPT-facing MCP behavior.',
				entry_paths: ['docs/CHATGPT_MCP.md', 'worker/src/mcp-tools.ts', 'worker/src/mcp/README.md'],
				next_paths: ['worker/src/runtime/mcp/handlers.ts', 'worker/src/mcp/repo-read/navigation.ts', 'worker/src/tool-catalog.json'],
			},
			{
				id: 'auth',
				label: 'Authentication',
				purpose: 'OIDC, direct MCP auth, and GitHub app credential handling.',
				entry_paths: ['worker/src/auth.ts', 'worker/src/github.ts', 'worker/src/runtime/mcp/handlers.ts'],
				next_paths: ['docs/CHATGPT_MCP.md', 'worker/test/auth.spec.ts', 'worker/src/runtime/http/oauth.ts'],
			},
			{
				id: 'deploy',
				label: 'Deploy',
				purpose: 'Self-host deployment, live/mirror controls, and Cloudflare integration.',
				entry_paths: ['wrangler.jsonc', 'worker/src/mcp-overview-tools.ts', 'worker/src/cloudflare.ts'],
				next_paths: ['docs/TOOL_SURFACE.md', 'README.md', 'worker/src/overview/logic.ts'],
			},
			{
				id: 'queue',
				label: 'Queue and workflow',
				purpose: 'Durable Object queue state, reconciliation, and workflow integration.',
				entry_paths: ['worker/src/queue.ts', 'worker/src/queue/README.md', 'worker/src/queue/actions/router.ts'],
				next_paths: ['worker/src/queue/actions/*.ts', 'worker/src/queue/projections/*.ts', 'worker/test/queue-*.spec.ts'],
			},
			{
				id: 'gui',
				label: 'GUI',
				purpose: 'Public GUI assets and GUI capture helpers.',
				entry_paths: ['public/gui/index.html', 'public/gui/app.js', 'worker/src/mcp-gui-tools.ts'],
				next_paths: ['worker/src/gui-*.ts', 'worker/test/gui-*.spec.ts'],
			},
			{
				id: 'incidents',
				label: 'Incidents',
				purpose: 'Past operational incidents and troubleshooting references.',
				entry_paths: ['docs/incidents/README.md'],
				next_paths: ['docs/incidents/*.md'],
			},
			{
				id: 'tooling',
				label: 'Tool surface',
				purpose: 'Published tool catalog and permission presets.',
				entry_paths: ['worker/src/tool-catalog.json', 'docs/TOOL_SURFACE.md'],
				next_paths: ['worker/src/tool-catalog.ts', 'worker/src/mcp-overview-tools.ts', 'worker/src/mcp/README.md'],
			},
		];
		return {
			repo_key: repoKey,
			mode: 'manifest_first',
			domains,
			default_flow: [
				'repo_navigation_manifest',
				'repo_context_snapshot',
				'repo_doc_index_lookup or repo_tool_index_lookup',
				'repo_get_file_summary',
				'repo_get_file_chunk',
			],
		};
	}
	incrementReadCounter('manifest_miss');
	return {
		repo_key: repoKey,
		mode: 'manifest_first',
		domains: [
			{
				id: 'root',
				label: 'Repository root',
				purpose: 'Start from tree snapshot, then narrow to docs, config, and source paths.',
				entry_paths: ['README.md'],
				next_paths: ['docs/', 'src/', '.github/workflows/'],
			},
		],
		default_flow: [
			'repo_navigation_manifest',
			'repo_context_snapshot',
			'repo_search_code or repo_tree_snapshot',
			'repo_get_file_summary',
			'repo_get_file_chunk',
		],
	};
}

export function buildPathScopedIndex(
	tree: Array<Record<string, unknown>>,
	kind: 'doc' | 'tool',
	query?: string,
): Array<Record<string, unknown>> {
	const normalizedQuery = (query ?? '').trim().toLowerCase();
	return tree
		.map((entry) => ({
			path: String(entry.path ?? ''),
			type: String(entry.type ?? ''),
		}))
		.filter((entry) => entry.type === 'blob')
		.filter((entry) => (kind === 'doc' ? classifyReadPath(entry.path) === 'doc' : classifyReadPath(entry.path) === 'tool'))
		.filter((entry) => !normalizedQuery || entry.path.toLowerCase().includes(normalizedQuery))
		.slice(0, 50)
		.map((entry) => ({
			path: entry.path,
			title: entry.path.split('/').pop() ?? entry.path,
			classification: classifyReadPath(entry.path),
			anchor: 'start',
		}));
}

