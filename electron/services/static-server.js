const http = require('http');
const fs = require('fs');
const path = require('path');
function startStaticServer({ port = 39110 } = {}) {
  const root = path.resolve(__dirname, '..', '..', 'design');
  const engine = path.resolve(__dirname, '..', '..', 'src');
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  const handler = (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath.includes('\0'))
        throw Error();
    }
    catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    let file;
    if (urlPath.startsWith('/engine/')) {
      const name = urlPath.slice('/engine/'.length);
      if (!['target-policy.mjs', 'task-policy.mjs'].includes(name)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      file = path.join(engine, name);
    }
    else {
      file = path.resolve(root, `.${urlPath === '/' ? '/index.html' : urlPath}`);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'" });
      res.end(data);
    });
  };
  return new Promise((resolve, reject) => {
    const listen = selected => {
      const server = http.createServer(handler);
      server.once('error', e => {
        if (e.code === 'EADDRINUSE' && selected !== 0)
          listen(0);
        else
          reject(e);
      });
      server.listen(selected, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    };
    listen(port);
  });
}
module.exports = { startStaticServer };
