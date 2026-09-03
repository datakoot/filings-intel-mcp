/**
 * Filings Intel MCP — Datakoot
 * Keyless Model Context Protocol server giving AI agents live access to SEC EDGAR:
 * company lookup, recent filings, full-text filing search, XBRL financial facts, and
 * insider (Form 3/4/5) transactions.
 *
 * Data source: SEC EDGAR (U.S. government, public domain).
 *   - Ticker->CIK map   https://www.sec.gov/files/company_tickers.json
 *   - Submissions       https://data.sec.gov/submissions/CIK##########.json
 *   - Company facts     https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
 *   - Full-text search  https://efts.sec.gov/LATEST/search-index?q=...
 * SEC fair-access rules: a descriptive User-Agent with contact info, and <=10 req/sec.
 *
 * Cloudflare Worker (module). Bindings: KV namespace "RL" (rate-limit day counter).
 */

const POLAR_ORG = "7f455043-0b15-4a1c-b7a0-9c06c9f3b95e";
const CHECKOUT = "https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf";
const FREE_LIMIT = 100;
// SEC REQUIRES a descriptive User-Agent with contact info or it returns 403.
const UA = "Datakoot-Filings-Intel/1.0 (contact@datakoot.com; +https://datakoot.com)";
const SERVER = { name: "filings-intel", version: "1.0.0" };
const ARCHIVE = "https://www.sec.gov/Archives/edgar/data";

/* ------------------------------------------------------------------ helpers */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function getJSON(url, { ttl = 3600 } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (r.status === 404) return { _notfound: true };
  if (!r.ok) return { _error: `SEC EDGAR returned ${r.status}` };
  try { return await r.json(); } catch { return { _error: "bad json from EDGAR" }; }
}
const pad10 = (cik) => String(cik).replace(/\D/g, "").padStart(10, "0");

/* checkAccess() was removed on 2026-09-02. It was defined but never called —
 * dkGate() is the live paywall — and it still held the old licence test
 * `d.status === "granted" || d.valid || d.id`, whose `|| d.id` clause accepts a
 * REVOKED key, because Polar returns the key object for revoked keys too.
 * Dead code that would silently reinstate a fixed billing hole if anyone ever
 * re-pointed a call site at it. */
/* ------------------------------------------------------------- data layer */
// Resolve a ticker, company name, or raw CIK to { cik, ticker, title }.
async function resolveEntity(query) {
  const q = String(query || "").trim();
  if (/^\d{1,10}$/.test(q)) return { cik: pad10(q), ticker: null, title: null };
  const map = await getJSON("https://www.sec.gov/files/company_tickers.json", { ttl: 86400 });
  if (map._error || map._notfound) return null;
  const rows = Object.values(map);
  const upper = q.toUpperCase();
  let hit = rows.find((r) => r.ticker && r.ticker.toUpperCase() === upper);
  if (!hit) {
    const lower = q.toLowerCase();
    hit = rows.find((r) => r.title && r.title.toLowerCase() === lower) ||
          rows.find((r) => r.title && r.title.toLowerCase().includes(lower));
  }
  if (!hit) return null;
  return { cik: pad10(hit.cik_str), ticker: hit.ticker, title: hit.title };
}
async function submissions(cik) { return getJSON(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { ttl: 3600 }); }

// Zip EDGAR's parallel "recent" arrays into filing objects.
function zipFilings(recent, cik) {
  if (!recent || !recent.form) return [];
  const out = [];
  for (let i = 0; i < recent.form.length; i++) {
    const acc = recent.accessionNumber[i];
    const accNoDash = acc.replace(/-/g, "");
    const doc = recent.primaryDocument[i];
    out.push({
      form: recent.form[i],
      filed: recent.filingDate[i],
      period: recent.reportDate ? recent.reportDate[i] : null,
      accession: acc,
      description: recent.primaryDocDescription ? recent.primaryDocDescription[i] : null,
      url: doc ? `${ARCHIVE}/${Number(String(cik).replace(/\D/g, ""))}/${accNoDash}/${doc}` : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------- tools */
const DK_AD = {"*.limit":"Maximum number of results to return."};
function dkDescribe(ts) { try { for (const t of ts) { const p = ((t.inputSchema || {}).properties) || {}; for (const k of Object.keys(p)) { const d = DK_AD[t.name + "." + k] || DK_AD["*." + k]; if (d && p[k] && !p[k].description) p[k].description = d; } } } catch (e) {} return ts; }
const TOOLS = [
  {
    name: "company_lookup",
    description: "Resolve a stock ticker or company name to its SEC identity: CIK number, official name, ticker(s), exchange(s), industry (SIC), and fiscal year end. Start here before other Filings Intel calls.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Ticker (e.g. AAPL), company name, or CIK" } }, required: ["query"] },
  },
  {
    name: "recent_filings",
    description: "List a company's most recent SEC filings (10-K annual reports, 10-Q quarterly, 8-K material events, S-1 IPO registrations, etc.) with filing dates and direct document links. Optionally filter by form type.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Ticker, name, or CIK" }, form_type: { type: "string", description: "Optional filter, e.g. 10-K, 10-Q, 8-K, 4" }, limit: { type: "integer", default: 15 } }, required: ["query"] },
  },
  {
    name: "filing_search",
    description: "Full-text search across all EDGAR filings for a keyword or phrase (e.g. a risk factor, product name, or executive). Returns matching filings with company, form type, and date. Optionally restrict to a form type.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search phrase" }, form_type: { type: "string", description: "Optional form filter, e.g. 8-K" }, limit: { type: "integer", default: 10 } }, required: ["query"] },
  },
  {
    name: "financials",
    description: "Get reported financial facts for a company from XBRL data in its filings: revenue, net income, total assets, liabilities, equity, EPS, and cash — most recent reported values, or the full history of one specific us-gaap concept.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Ticker, name, or CIK" }, concept: { type: "string", description: "Optional specific us-gaap concept, e.g. Revenues, NetIncomeLoss, Assets" } }, required: ["query"] },
  },
  {
    name: "insider_transactions",
    description: "List recent insider ownership filings (Form 3/4/5) for a company — the filings officers, directors, and 10% owners submit when they buy or sell shares. Returns the filings with dates and links.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Ticker, name, or CIK" }, limit: { type: "integer", default: 15 } }, required: ["query"] },
  },
];

const KEY_CONCEPTS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "Assets", "Liabilities", "StockholdersEquity", "CashAndCashEquivalentsAtCarryingValue", "EarningsPerShareBasic", "EarningsPerShareDiluted"];

async function runTool(name, args) {
  if (name === "filing_search") {
    const limit = Math.min(args.limit || 10, 25);
    let url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + args.query + '"')}`;
    if (args.form_type) url += `&forms=${encodeURIComponent(args.form_type)}`;
    const d = await getJSON(url, { ttl: 900 });
    if (d._error || d._notfound || !d.hits) return { error: "search unavailable or no results" };
    const hits = (d.hits.hits || []).slice(0, limit).map((h) => {
      const s = h._source || {};
      return { company: (s.display_names || [])[0] || null, form: s.form || s.root_form, filed: s.file_date, cik: (s.ciks || [])[0], id: h._id };
    });
    return { query: args.query, total: d.hits.total && d.hits.total.value, results: hits };
  }

  const ent = await resolveEntity(args.query);
  if (!ent) return { error: `Could not resolve '${args.query}' to a SEC filer. Try a ticker (AAPL), full company name, or CIK.` };

  if (name === "company_lookup") {
    const s = await submissions(ent.cik);
    if (s._error || s._notfound) return { cik: ent.cik, ticker: ent.ticker, title: ent.title, note: "resolved from ticker map; full profile unavailable" };
    return {
      cik: ent.cik, name: s.name, tickers: s.tickers, exchanges: s.exchanges,
      sic: s.sic, industry: s.sicDescription, category: s.category,
      fiscal_year_end: s.fiscalYearEnd, ein: s.ein, state: s.stateOfIncorporation,
      former_names: (s.formerNames || []).map((f) => f.name),
    };
  }
  if (name === "recent_filings") {
    const s = await submissions(ent.cik);
    if (s._error || s._notfound || !s.filings) return { error: "filings unavailable" };
    let all = zipFilings(s.filings.recent, ent.cik);
    if (args.form_type) { const f = args.form_type.toUpperCase(); all = all.filter((x) => x.form && x.form.toUpperCase() === f); }
    return { company: s.name, cik: ent.cik, count: all.length, filings: all.slice(0, Math.min(args.limit || 15, 50)) };
  }
  if (name === "insider_transactions") {
    const s = await submissions(ent.cik);
    if (s._error || s._notfound || !s.filings) return { error: "filings unavailable" };
    const all = zipFilings(s.filings.recent, ent.cik).filter((x) => ["3", "4", "5"].includes(x.form));
    return { company: s.name, cik: ent.cik, note: "Form 3/4/5 = insider ownership & transactions", filings: all.slice(0, Math.min(args.limit || 15, 50)) };
  }
  if (name === "financials") {
    const facts = await getJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${ent.cik}.json`, { ttl: 3600 });
    if (facts._error || facts._notfound || !facts.facts) return { error: "no XBRL financial facts available for this company" };
    const gaap = facts.facts["us-gaap"] || {};
    const latestOf = (concept) => {
      const node = gaap[concept];
      if (!node || !node.units) return null;
      const unitKey = Object.keys(node.units)[0];
      const rows = node.units[unitKey] || [];
      const annual = rows.filter((r) => r.form === "10-K" && r.fy);
      const pick = (annual.length ? annual : rows).slice(-1)[0];
      return pick ? { value: pick.val, unit: unitKey, period_end: pick.end, fiscal_year: pick.fy, form: pick.form } : null;
    };
    if (args.concept) {
      const node = gaap[args.concept];
      if (!node) return { error: `Concept '${args.concept}' not reported. Try Revenues, NetIncomeLoss, Assets, StockholdersEquity, EarningsPerShareBasic.` };
      const unitKey = Object.keys(node.units)[0];
      const history = (node.units[unitKey] || []).filter((r) => r.form === "10-K").map((r) => ({ fy: r.fy, period_end: r.end, value: r.val })).slice(-8);
      return { company: facts.entityName, concept: args.concept, unit: unitKey, history };
    }
    const out = { company: facts.entityName, cik: ent.cik, latest_reported: {} };
    for (const c of KEY_CONCEPTS) { const v = latestOf(c); if (v) out.latest_reported[c] = v; }
    return out;
  }
  return { error: "unknown tool" };
}

/* --------------------------------------------------------------- MCP core */
function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMCP(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(rpcErr(null, -32700, "Parse error")); }
  const { id, method, params } = body || {};
  console.log("DKPULSE " + (method || "?") + " " + ((params && params.name) || "-"));

  if (method === "initialize") {
    return json(rpc(id, {
      protocolVersion: dkProto(params),
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions: "Filings Intel: SEC EDGAR access for AI agents — company lookup, recent filings, full-text filing search, XBRL financials, and insider (Form 4) transactions. Start with company_lookup to get a CIK.",
    }));
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202, headers: CORS });
  if (method === "ping") return json(rpc(id, {}));
  if (method === "tools/list") return json(rpc(id, { tools: dkDescribe(TOOLS) }));

  if (method === "tools/call") {
    const access = await dkGate(request, env);
    if (!access.ok) {
      return json(rpc(id, { content: [{ type: "text", text: access.message }], isError: true }), 200, access.headers);
    }
    const tname = params && params.name;
    const args = (params && params.arguments) || {};
    if (!TOOLS.find((t) => t.name === tname)) return json(rpcErr(id, -32602, `Unknown tool: ${tname}`)); { const _s = (TOOLS.find((t) => t.name === tname).inputSchema || {}).properties || {}; const _rq = ((TOOLS.find((t) => t.name === tname) || {}).inputSchema || {}).required || []; const _bad = Object.keys(args).filter((k) => !(k in _s)).map((k) => "unexpected '" + k + "'").concat(_rq.filter((k) => args[k] === undefined || args[k] === null || args[k] === "").map((k) => "missing required '" + k + "'")); if (_bad.length) return json(rpcErr(id, -32602, "Bad arguments for " + tname + ": " + _bad.join(", ") + ". Valid: " + (Object.keys(_s).join(", ") || "none") + ". The call was refused rather than ignoring them, because ignoring an argument returns a confident answer to a different question than the one asked.")); }
    try {
      const out = await runTool(tname, args);
      const meta = access.pro ? "" : `\n\n(${access.remaining} free calls left today)`;
      return json(rpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) + meta }], isError: !!(out && out.error) }), 200, access.headers);
    } catch (e) {
      return json(rpc(id, { content: [{ type: "text", text: "Error: " + (e && e.message || String(e)) }], isError: true }));
    }
  }
  return json(rpcErr(id, -32601, `Method not found: ${method}`));
}

/* ----------------------------------------------------------------- landing */
const CSS = `:root{--bg:#0b0e14;--panel:#111725;--border:#1e2636;--text:#e6edf3;--muted:#8b98a9;--accent:#4ade80;--accent2:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.6}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:50;background:#0b0e14;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:18px;padding:12px 20px}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:19px}.logo svg{display:block}
nav{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap;font-size:14px}nav a{color:var(--muted)}nav a:hover{color:var(--text)}
.hero{padding:64px 0 32px}.hero h1{font-size:44px;line-height:1.1;margin:0 0 14px}.hero .accent{color:var(--accent)}
.sub{font-size:19px;color:var(--muted);max-width:640px}
.section{padding:28px 0;border-top:1px solid var(--border)}
.grid{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:760px){.grid{grid-template-columns:1fr 1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;min-width:0}
.card h3{margin:0 0 6px;font-size:16px}.card code{color:var(--accent);font-size:13px}.card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.cmd{display:flex;align-items:center;gap:8px;background:#0a0d13;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:14px 0;overflow-x:auto}
.cmd code{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--text);white-space:nowrap}
.tiers{display:grid;grid-template-columns:1fr;gap:14px}@media(min-width:760px){.tiers{grid-template-columns:1fr 1fr 1fr}}
.tier{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px}.tier b{font-size:18px}.tier span{display:block;color:var(--muted);font-size:14px;margin-top:4px}
.btn{display:inline-block;background:var(--accent);color:#06210f;font-weight:700;padding:10px 18px;border-radius:8px;margin-top:8px}
footer{border-top:1px solid var(--border);padding:32px 20px;color:var(--muted);font-size:14px;text-align:center}`;

const MARK = `<svg width="26" height="26" viewBox="-34 -34 68 68" style="vertical-align:-4px"><g stroke="#4ade80" stroke-width="5" fill="none" stroke-linejoin="round"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15"/></g><g fill="#4ade80"><circle cx="0" cy="-12" r="6"/><circle cx="-11" cy="8" r="6"/><circle cx="11" cy="8" r="6"/></g></svg>`;

function landing(host) {
  const ep = `https://${host}/mcp`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Filings Intel MCP — SEC EDGAR for your AI agent | Datakoot</title>
<meta name="description" content="Keyless MCP server giving AI agents live SEC EDGAR access: company lookup, recent filings, full-text filing search, XBRL financials, and insider transactions.">
<style>${CSS}</style></head><body>
<header><a href="https://datakoot.com/" style="color:inherit"><div class="logo">${MARK}Data<span style="color:var(--accent)">koot</span></div></a>
<nav><a href="https://datakoot.com/">Datakoot</a><a href="#tools">Tools</a><a href="#start">Quick start</a><a href="#pricing">Pricing</a><a href="https://github.com/datakoot">GitHub</a></nav></header>
<div class="wrap">
<section class="hero"><h1>Give your agent the <span class="accent">public record</span>.</h1>
<p class="sub">Filings Intel puts SEC EDGAR at your agent's fingertips: resolve any ticker, pull the latest 10-K or 8-K, search the full text of every filing, read reported financials, and track insider trades. Public-domain data, no API keys.</p></section>

<section class="section" id="tools"><h2>Tools</h2><div class="grid">
<div class="card"><h3><code>company_lookup</code></h3><p>Ticker or name → CIK, exchange, industry, fiscal year.</p></div>
<div class="card"><h3><code>recent_filings</code></h3><p>Latest 10-K / 10-Q / 8-K / S-1 with document links.</p></div>
<div class="card"><h3><code>filing_search</code></h3><p>Full-text search across all EDGAR filings.</p></div>
<div class="card"><h3><code>financials</code></h3><p>Revenue, net income, assets, EPS from XBRL data.</p></div>
<div class="card"><h3><code>insider_transactions</code></h3><p>Form 3/4/5 insider buys and sells.</p></div>
</div></section>

<section class="section" id="start"><h2>Quick start</h2>
<p class="sub">One line, no key. Works with Claude, Cursor, and any MCP client.</p>
<div class="cmd"><code>claude mcp add --transport http filings-intel ${ep}</code></div>
<p style="color:var(--muted);font-size:14px">Or point any MCP client at <code>${ep}</code></p></section>

<section class="section" id="pricing"><h2>Pricing</h2><div class="tiers">
<div class="tier"><b>Free</b><span>100 calls / day</span><span>Every tool, no key.</span></div>
<div class="tier"><b>$15/mo · Pro</b><span>10,000 calls / month</span><span>1 seat · one key unlocks all nine Datakoot servers · then $5 per 1,000, capped at $100.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
<div class="tier"><b>$49/mo · Team</b><span>50,000 calls / month</span><span>Up to 5 seats · then $5 per 1,000.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
</div></section>
</div>
<footer><a href="https://datakoot.com/" style="color:inherit">Datakoot</a> — infrastructure for the agent economy · <a href="https://github.com/datakoot">GitHub</a> · Data: U.S. SEC EDGAR (public domain)</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(request, env) {
    if (DK_SALT === null) DK_SALT = env.IP_SALT || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/.well-known/owners.json")) return json({ $schema: "https://verifymcp.io/schemas/owners.json", owners: ["hello@datakoot.com"] });
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      if (request.method === "POST") return handleMCP(request, env);
      return json({ error: "POST JSON-RPC to this endpoint (MCP streamable HTTP)" }, 405);
    }
    if (url.pathname === "/health") return json({ ok: true, server: SERVER });
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(landing(url.host), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    }
    return new Response("Not found", { status: 404, headers: CORS });
  },
};


/* ==================== Datakoot call metering (D1) =========================
 * Supersedes the older KV gate above, which is now unused.
 *
 * KV caches reads at the edge and is eventually consistent, so a
 * read-modify-write counter loses increments under any real concurrency —
 * measured against production on 2026-08-29: seven consecutive calls moved
 * the counter by three, and once moved it backwards. D1 does the read, the
 * increment and the return in ONE statement inside ONE transaction, so no
 * increment can be lost. Proven on security-intel in production the same day:
 * 731 calls fired, 731 counted, and every call past 100 refused — no leaks,
 * no false refusals.
 *
 * Binding QUOTA_DB -> database "datakoot-quota", table:
 *   quota(k TEXT PRIMARY KEY, period TEXT NOT NULL,
 *         n INTEGER NOT NULL, updated INTEGER NOT NULL DEFAULT 0)
 * One row per caller, reused across periods, so the table grows with the
 * number of distinct callers rather than with time.
 *
 * dkGate() returns { allowed, ok, pro, remaining, limit, message, headers, meta }.
 * `ok` mirrors `allowed`; `pro` is true whenever the call is not metered against
 * the free allowance, so a caller-facing meter line reads correctly either way.
 * ========================================================================= */
const DK_FREE_LIMIT = 100;        // anonymous, keyless, per UTC day
const DK_PRO_INCLUDED = 10000;    // calls included in Pro each month
const DK_OVERAGE_PER = 1000;      // then $5 per 1,000
const DK_CHECKOUT = "https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf";
const DK_POLAR_ORG = "7f455043-0b15-4a1c-b7a0-9c06c9f3b95e";
const DK_BUMP_SQL =
  "INSERT INTO quota (k, period, n, updated) VALUES (?1, ?2, 1, ?3) " +
  "ON CONFLICT(k) DO UPDATE SET " +
  "n = CASE WHEN quota.period = excluded.period THEN quota.n + 1 ELSE 1 END, " +
  "period = excluded.period, updated = excluded.updated RETURNING n";

async function dkBump(env, k, period) {
  const row = await env.QUOTA_DB.prepare(DK_BUMP_SQL).bind(k, period, Math.floor(Date.now() / 1000)).first();
  const n = row && row.n;
  if (typeof n !== "number") throw new Error("quota: no row returned");
    await dkDaily(env, k, period);
  return n;
}

/* Identify a caller without storing an identity.
 *
 * This is an HMAC, not a plain hash, and the key is a 256-bit secret held only
 * in the Worker's environment (IP_SALT). That distinction matters: a plain
 * SHA-256 of an IPv4 address is reversible by anyone who has the code, because
 * there are only 4.3 billion addresses to try. Keyed, it is not reversible
 * without the secret — which is never stored beside the data it protects.
 *
 * If IP_SALT is ever unset the function still works, unkeyed, so a missing
 * secret degrades privacy rather than taking the service down.
 */
let DK_SALT = null, DK_KEY = null;
async function dkMacKey() {
  if (!DK_KEY) {
    DK_KEY = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(DK_SALT || "dk1-unsalted"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  return DK_KEY;
}
async function dkSha96(s) {
  const b = await crypto.subtle.sign("HMAC", await dkMacKey(), new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* Headers so a developer can watch the meter instead of guessing. */
function dkHeaders(limit, remaining) {
  if (limit == null) return {};
  const t = new Date();
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining == null ? limit : remaining),
    "X-RateLimit-Reset": String(Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) / 1000)),
  };
}

/* Unmetered: a valid Pro key, or metering that could not run. Never blocked. */
const DK_OPEN = { allowed: true, ok: true, pro: true, remaining: null, limit: null, message: "", headers: {}, meta: "" };

async function dkGate(request, env) {
  let key = (request.headers.get("Authorization") || "").trim();
  if (key.toLowerCase().indexOf("bearer ") === 0) key = key.slice(7).trim();
  if (!key) key = (request.headers.get("X-Datakoot-Key") || "").trim();

  if (key) {
    let pro = false;
    if (env.RL) { try { if ((await env.RL.get("pk:" + (await dkSha96("dk1:" + key)))) === "1") pro = true; } catch (e) {} }
    if (!pro) {
      try {
        const vr = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, organization_id: DK_POLAR_ORG }),
        });
        if (vr.ok) { const _pd = await vr.json().catch(() => null); pro = !!(_pd && (!("status" in _pd) || _pd.status === "granted")); if (pro && env.RL) { try { await env.RL.put("pk:" + (await dkSha96("dk1:" + key)), "1", { expirationTtl: 3600 }); } catch (e) {} } }
      } catch (e) { /* Polar unreachable: fall through to the invalid-key branch */ }
    }
    if (!pro) {
      // A key that does not validate used to fall silently back to the free
      // tier, so a paying customer with a typo looked throttled for no reason.
      return { allowed: false, ok: false, pro: false, remaining: 0, limit: DK_FREE_LIMIT, meta: "",
        headers: dkHeaders(DK_FREE_LIMIT, 0),
        message: "That Datakoot API key was not recognised. Check it at https://datakoot.com/pricing, or remove the Authorization header to use the free tier (" + DK_FREE_LIMIT + " calls/day, no signup)." };
    }
    // Pro is metered but never blocked: overage is billed, not refused.
    if (env.QUOTA_DB) {
      try { await dkBump(env, "pro:" + (await dkSha96("dk1:" + key)), new Date().toISOString().slice(0, 7)); }
      catch (e) { console.error("QUOTA error (pro):", e && e.message); }
    }
    return DK_OPEN;
  }

  if (!env.QUOTA_DB) {
    // Fail OPEN so a misconfiguration never takes the API down — but say so.
    console.error("DATAKOOT METERING DISABLED: env.QUOTA_DB is not bound");
    return DK_OPEN;
  }
  let n;
  try {
    n = await dkBump(env, "ip:" + (await dkSha96("dk1:" + (request.headers.get("CF-Connecting-IP") || "anon"))), new Date().toISOString().slice(0, 10));
  } catch (e) {
    console.error("DATAKOOT METERING ERROR, failing open:", e && e.message);
    return DK_OPEN;
  }
  // The Nth call writes n = N, so call DK_FREE_LIMIT is the last one allowed
  // and call DK_FREE_LIMIT + 1 is the first one refused.
  if (n > DK_FREE_LIMIT) {
    return { allowed: false, ok: false, pro: false, remaining: 0, limit: DK_FREE_LIMIT, meta: "",
      headers: dkHeaders(DK_FREE_LIMIT, 0),
      message: "Daily free limit reached (" + DK_FREE_LIMIT + " calls). It resets at 00:00 UTC. Datakoot Pro includes " + DK_PRO_INCLUDED.toLocaleString() + " calls a month across all nine servers for $15, then $5 per " + DK_OVERAGE_PER.toLocaleString() + " — " + DK_CHECKOUT };
  }
  const left = DK_FREE_LIMIT - n;
  return { allowed: true, ok: true, pro: false, remaining: left, limit: DK_FREE_LIMIT, message: "",
    headers: dkHeaders(DK_FREE_LIMIT, left), meta: "\n\n(" + left + " free calls left today)" };
}

/* MCP protocol negotiation.
 *
 * Echo back the version the client asked for when we speak it, otherwise answer
 * with the newest one we do. These servers answered a hardcoded "2024-11-05" to
 * every client, which meant no client could rely on structuredContent or
 * outputSchema — both introduced in 2025-06-18. Same list and same behaviour as
 * base-intel and domain-intel, which already did this correctly.
 */
const DK_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
function dkProto(params) {
  const want = params && params.protocolVersion;
  return DK_PROTOCOL_VERSIONS.indexOf(want) !== -1 ? want : DK_PROTOCOL_VERSIONS[0];
}

/* Retention analytics.
 *
 * `quota` keeps ONE row per caller and overwrites it when the day rolls over,
 * so it can only ever show a caller's most recent active day. That makes the
 * most valuable question — did anyone come back tomorrow? — structurally
 * unanswerable. `daily` keeps one row per caller PER DAY instead.
 *
 * It stores exactly what `quota` stores: the same keyed, non-reversible caller
 * identifier, a date, a count. No queries, no addresses, nothing new about
 * anyone. The 04:17 retention job prunes it on the same 90-day clock, so the
 * privacy policy stays true.
 *
 * Wrapped so it can never break a caller's request: if this write fails the
 * call still succeeds and metering is unaffected. It is analytics, not billing.
 */
const DK_DAILY_SQL =
  "INSERT INTO daily (k, period, n, updated) VALUES (?1, ?2, 1, ?3) " +
  "ON CONFLICT(k, period) DO UPDATE SET n = daily.n + 1, updated = excluded.updated";
async function dkDaily(env, k, period) {
  try {
    await env.QUOTA_DB.prepare(DK_DAILY_SQL)
      .bind(k, period, Math.floor(Date.now() / 1000)).run();
  } catch (e) { /* never let analytics break a paying or free call */ }
}