const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const out = path.join(root, 'tmp', packaged ? 'smoke-packaged' : 'smoke');
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, SYBL_SMOKE_DIR: out, APPDATA: out };
if (packaged) env.SYBL_SMOKE_APP_ROOT = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(require('electron'), [path.join(__dirname, 'smoke-main.cjs')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => {
  console.error('Smoke test timeout');
  child.kill();
}, 60000);
child.on('error', e => {
  console.error(e.message);
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on('exit', code => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
