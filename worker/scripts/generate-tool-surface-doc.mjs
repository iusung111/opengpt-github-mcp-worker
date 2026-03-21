import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const catalogPath = path.join(root, 'worker', 'src', 'tool-catalog.json');
const outputDir = path.join(root, 'docs');
const outputPath = path.join(outputDir, 'TOOL_SURFACE.md');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const lines = [
	'# Tool Surface',
	'',
	'Generated from `worker/src/tool-catalog.json`.',
	'',
	'## Groups',
	'',
];

for (const group of catalog.groups) {
	lines.push(`### ${group.label}`);
	lines.push('');
	lines.push(group.description);
	lines.push('');
	for (const tool of group.tools) {
		lines.push(`- \`${tool}\``);
	}
	lines.push('');
}

lines.push('## Permission Presets');
lines.push('');

for (const preset of catalog.permissionPresets) {
	lines.push(`### ${preset.label}`);
	lines.push('');
	lines.push(`- preset id: \`${preset.id}\``);
	lines.push(`- description: ${preset.description}`);
	lines.push(`- capabilities: ${preset.capabilities.map((item) => `\`${item}\``).join(', ')}`);
	lines.push(`- group ids: ${preset.groupIds.map((item) => `\`${item}\``).join(', ')}`);
	lines.push('');
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${path.relative(root, outputPath)}`);
