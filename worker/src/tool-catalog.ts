import catalog from './tool-catalog.json';
import { canonicalizeRepoKey } from './repo-aliases';

export type ToolGroup = {
	id: string;
	label: string;
	description: string;
	tools: string[];
};

export type PermissionPreset = {
	id: string;
	label: string;
	description: string;
	capabilities: string[];
	groupIds: string[];
};

type Catalog = {
	groups: ToolGroup[];
	permissionPresets: PermissionPreset[];
};

const toolCatalog = catalog as Catalog;

const groupsById = new Map(toolCatalog.groups.map((group) => [group.id, group]));
const presetsById = new Map(toolCatalog.permissionPresets.map((preset) => [preset.id, preset]));

const capabilityToGroupIds: Record<string, string[]> = {
	read: ['overview', 'repo_read', 'api_backend', 'observability'],
	write: ['repo_write', 'collaboration', 'preview', 'browser', 'database', 'release'],
	workflow: ['repo_write', 'verification', 'preview', 'browser', 'desktop', 'database', 'release'],
	review: ['queue'],
	workspace: ['workspace'],
	queue: ['queue'],
	self_host: ['overview'],
};

export function getToolCatalog(): Catalog {
	return toolCatalog;
}

export function listToolGroups(): ToolGroup[] {
	return toolCatalog.groups;
}

export function listPermissionPresets(): PermissionPreset[] {
	return toolCatalog.permissionPresets;
}

export function resolveToolNamesForGroups(groupIds: string[]): string[] {
	const names = new Set<string>();
	for (const groupId of groupIds) {
		const group = groupsById.get(groupId);
		if (!group) {
			continue;
		}
		for (const tool of group.tools) {
			names.add(tool);
		}
	}
	return Array.from(names).sort();
}

export function resolvePermissionBundle(input: {
	preset?: string | undefined;
	capabilities?: string[] | undefined;
	extraTools?: string[] | undefined;
}) {
	const preset = input.preset ? presetsById.get(input.preset) ?? null : null;
	if (input.preset && !preset) {
		throw new Error(`unknown permission preset: ${input.preset}`);
	}

	const requestedCapabilities = Array.from(
		new Set([...(preset?.capabilities ?? []), ...((input.capabilities ?? []).filter(Boolean))]),
	).sort();

	if (!preset && requestedCapabilities.length === 0) {
		throw new Error('permission bundle requires either a preset or at least one capability');
	}

	const unknownCapabilities = requestedCapabilities.filter((capability) => !(capability in capabilityToGroupIds));
	if (unknownCapabilities.length > 0) {
		throw new Error(`unknown permission capability: ${unknownCapabilities.join(', ')}`);
	}

	const groupIds = new Set<string>(preset?.groupIds ?? []);
	for (const capability of requestedCapabilities) {
		for (const groupId of capabilityToGroupIds[capability] ?? []) {
			groupIds.add(groupId);
		}
	}

	const resolvedGroupIds = Array.from(groupIds);
	const groups = resolvedGroupIds
		.map((groupId) => groupsById.get(groupId))
		.filter((group): group is ToolGroup => Boolean(group));
	const tools = new Set(resolveToolNamesForGroups(resolvedGroupIds));
	for (const extraTool of input.extraTools ?? []) {
		if (extraTool.trim()) {
			tools.add(extraTool.trim());
		}
	}

	return {
		preset,
		capabilities: requestedCapabilities,
		groups,
		tools: Array.from(tools).sort(),
	};
}

export function buildPermissionBundleMessage(input: {
	repos: string[];
	reason: string;
	preset?: string | undefined;
	capabilities?: string[] | undefined;
	extraTools?: string[] | undefined;
}) {
	const normalizedRepos = Array.from(new Set(input.repos.map((repo) => canonicalizeRepoKey(repo)).filter(Boolean)));
	const bundle = resolvePermissionBundle(input);
	const repoList = normalizedRepos.join(', ');
	const scopeSummary = bundle.groups.map((group) => group.label).join(', ');
	const capabilitySummary = bundle.capabilities.join(', ');

	return {
		bundle_key: [
			bundle.preset?.id ?? 'custom',
			...normalizedRepos.map((repo) => repo.replace(/[^\w/-]+/g, '-')),
			...bundle.capabilities,
		].join(':'),
		preset: bundle.preset
			? {
					id: bundle.preset.id,
					label: bundle.preset.label,
					description: bundle.preset.description,
			  }
			: null,
		repos: normalizedRepos,
		reason: input.reason,
		capabilities: bundle.capabilities,
		tool_groups: bundle.groups.map((group) => ({
			id: group.id,
			label: group.label,
			description: group.description,
			tools: group.tools,
		})),
		approved_tools: bundle.tools,
		approval_request: `Approve one MCP permission bundle for ${repoList}. Scope: ${scopeSummary}. Capabilities: ${capabilitySummary}. Reason: ${input.reason}`,
		recommended_follow_up: [
			'request the bundle near the start of the run',
			'include expected follow-up actions such as workflow reruns or branch cleanup in the same approval bundle',
			'log blocked approval waits with job_append_note if execution must pause',
		],
	};
}
