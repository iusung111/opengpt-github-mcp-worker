import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const catalogPath = path.join(root, 'worker', 'src', 'tool-catalog.json');
const outputDir = path.join(root, 'docs');
const outputPath = path.join(outputDir, 'TOOL_SURFACE.md');
const checkOnly = process.argv.includes('--check');

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
const nextContent = `${lines.join('\n')}\n`;
if (checkOnly) {
	const currentContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
	if (currentContent !== nextContent) {
		console.error(`docs/TOOL_SURFACE.md is out of date. Run: npm run docs:tool-surface`);
		process.exit(1);
	}
	console.log(`Verified ${path.relative(root, outputPath)}`);
	process.exit(0);
}

fs.writeFileSync(outputPath, nextContent);
console.log(`Wrote ${path.relative(root, outputPath)}`);
