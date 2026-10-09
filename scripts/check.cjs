const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}
const files = ['electron', 'src', 'design', 'scripts', 'tests'].flatMap(d => walk(path.join(root, d)));
let failed = false;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    failed = true;
    console.error(r.stderr || r.error?.message);
  }
}
const html = fs.readFileSync(path.join(root, 'design/index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
if (new Set(ids).size !== ids.length) {
  failed = true;
  console.error('Duplicate HTML IDs');
}
console.log(`Checked ${files.length} source files and ${ids.length} HTML IDs`);
process.exit(failed ? 1 : 0);
