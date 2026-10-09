// Keep build caches in the workspace; reuse the runtime already installed by npm ci.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(root, 'tmp', 'builder-cache');
const env = { ...process.env, ELECTRON_BUILDER_CACHE: cache };
function build() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', '--x64', ...process.argv.slice(2)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => {
        process.stdout.write(chunk);
        output = (output + chunk.toString()).slice(-2 * 1024 * 1024);
      });
    child.on('error', reject);
    child.on('exit', code => resolve({ code: code ?? 1, output }));
  });
}
(async () => {
  let result = await build();
  // Older builder archives include macOS symlinks. Windows rcedit does not need those files.
  if (result.code && process.platform === 'win32' && /Cannot create symbolic link/.test(result.output) && /winCodeSign/.test(result.output)) {
    const folder = path.join(cache, 'winCodeSign');
    const archives = fs.readdirSync(folder).filter(n => n.endsWith('.7z')).map(n => path.join(folder, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const vendor = path.join(folder, 'winCodeSign-2.6.0');
    fs.mkdirSync(vendor, { recursive: true });
    if (archives.length) {
      const unpack = spawnSync(path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'), ['x', '-y', '-bd', archives[0], `-o${vendor}`, '-xr!darwin'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
      if (unpack.status === 0)
        result = await build();
    }
  }
  process.exitCode = result.code;
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
