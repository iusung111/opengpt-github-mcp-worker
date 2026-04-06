import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const routerSource = fs.readFileSync(path.join(root, 'worker/src/index.ts'), 'utf8');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'worker/config/chatgpt-mcp-contract.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const redirectTarget = contract.canonical_runtime_expectations.root_redirect;
assert(routerSource.includes('url.pathname === \'/\''), 'root canonicalization branch is missing');
assert(routerSource.includes(`/gui/`), `root redirect target mismatch: expected ${redirectTarget}`);

for (const runtimePath of contract.canonical_runtime_expectations.runtime_owned_prefixes) {
  assert(routerSource.includes(runtimePath), `missing runtime-owned route check for ${runtimePath}`);
}

for (const staticPath of contract.canonical_runtime_expectations.static_gui_paths_delegate_to_asset_layer) {
  assert(!routerSource.includes(`url.pathname === '${staticPath}'`), `static GUI path should remain delegated to the asset layer: ${staticPath}`);
}

console.log(JSON.stringify({ ok: true, checked: 'runtime_route_canonicalization' }, null, 2));
