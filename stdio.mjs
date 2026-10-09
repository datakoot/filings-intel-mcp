// Runs this repo's worker.js locally as an MCP server over stdio.
// For registries (e.g. Glama) that start the server in a container and run
// initialize / tools/list. Same code as production, calling the same official
// public sources. No Cloudflare bindings locally, so the daily quota and the
// edge cache are simply off. Production lives at the URL in server.json.
import { createInterface } from 'node:readline';

// stdout carries JSON-RPC only; send every log line to stderr.
const toErr = (...a) => process.stderr.write(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
console.log = console.info = console.debug = console.warn = toErr;

// Workers' Cache API is not in Node: provide a no-op cache.
if (!globalThis.caches) {
  const nocache = { match: async () => undefined, put: async () => {}, delete: async () => false };
  globalThis.caches = { default: nocache, open: async () => nocache };
}

const { default: worker } = await import('./worker.js');
const env = {};
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); }, passThroughOnException: () => {} };

async function handle(msg) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(msg),
  });
  try {
    const res = await worker.fetch(req, env, ctx);
    let txt = (await res.text()).trim();
    if (/^(event:|data:)/.test(txt)) {
      const line = txt.split('\n').find((l) => l.startsWith('data:'));
      txt = line ? line.slice(5).trim() : '';
    }
    if (txt && msg.id !== undefined) process.stdout.write(txt + '\n');
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } }) + '\n');
    }
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  await handle(msg);
}
