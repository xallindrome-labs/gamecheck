import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAME = `<script>
window.state = { x: 0, last: null, flag: false, beats: 0, keys: {}, dateMs: 0 };
const t0 = Date.now();
function frame(ts) {
  if (state.last !== null) state.x += 100 * ((ts - state.last) / 1000) * (state.keys.ArrowRight ? 2 : 1);
  state.last = ts;
  state.dateMs = Date.now() - t0;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setTimeout(() => { state.flag = true; }, 5000);
setInterval(() => { state.beats += 1; }, 1000);
addEventListener('keydown', (e) => { state.keys[e.key] = true; });
addEventListener('keyup', (e) => { state.keys[e.key] = false; });
</script>`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

/** Serves the given pages, and files under node_modules, on a free local port. */
export async function serve(pages: Record<string, string>): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = pages[path];
    if (page !== undefined) {
      response.setHeader('content-type', 'text/html');
      response.end(page);
      return;
    }
    if (path.startsWith('/node_modules/')) {
      try {
        const body = readFileSync(join(root, path));
        response.setHeader('content-type', TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream');
        response.end(body);
        return;
      } catch { /* not there: fall through to 404 */ }
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
