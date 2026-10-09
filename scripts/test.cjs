const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(n => /\.test\.(cjs|mjs|js)$/.test(n)).sort().map(n => path.join('tests', n));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error)
  console.error(result.error.message);
process.exit(result.status ?? 1);
