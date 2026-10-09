const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
if (process.argv.includes('--dev'))
  env.NODE_ENV = 'development';
const child = spawn(require('electron'), [root], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', e => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
