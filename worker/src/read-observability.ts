type CounterMap = Record<string, number>;

interface ToolMetric {
	count: number;
	total_duration_ms: number;
	total_bytes_read: number;
}

const counters: CounterMap = {
	github_cache_hit: 0,
	github_cache_miss: 0,
	github_negative_cache_hit: 0,
	github_remote_call: 0,
	manifest_hit: 0,
	manifest_miss: 0,
	doc_index_hit: 0,
	doc_index_miss: 0,
	tool_index_hit: 0,
	tool_index_miss: 0,
	full_read_avoided: 0,
	chunk_read: 0,
	full_read: 0,
	queue_storage_list_call: 0,
	mcp_public_rpc_count: 0,
	mcp_public_blocked_count: 0,
	mcp_public_blocked_tool_call_count: 0,
	mcp_auth_fail_count: 0,
	mcp_auth_ok_count: 0,
	mcp_protocol_version_missing_count: 0,
	mcp_protocol_version_invalid_count: 0,
};

const toolMetrics = new Map<string, ToolMetric>();

export function incrementReadCounter(name: string, amount = 1): void {
	counters[name] = (counters[name] ?? 0) + amount;
}

export function recordToolMetric(name: string, durationMs: number, bytesRead = 0): void {
	const existing = toolMetrics.get(name) ?? {
		count: 0,
		total_duration_ms: 0,
		total_bytes_read: 0,
	};
	existing.count += 1;
	existing.total_duration_ms += durationMs;
	existing.total_bytes_read += bytesRead;
	toolMetrics.set(name, existing);
}

export function getReadObservabilitySnapshot(): Record<string, unknown> {
	return {
		counters: { ...counters },
		tool_metrics: Array.from(toolMetrics.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, metric]) => ({
				name,
				count: metric.count,
				total_duration_ms: metric.total_duration_ms,
				avg_duration_ms: metric.count > 0 ? Number((metric.total_duration_ms / metric.count).toFixed(2)) : 0,
				total_bytes_read: metric.total_bytes_read,
			})),
	};
}
