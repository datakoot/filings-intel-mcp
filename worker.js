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
  "Access-Control-Allow-Headers": "Content-Type, X-Datakoot-Key, Authorization, Mcp-Session-Id, mcp-protocol-version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function getJSON(url, { ttl = 3600 } = {}) {
  const cache = caches.default; const ckey = new Request(url, { method: "GET" });
  const hit = await cache.match(ckey); if (hit) { try { return await hit.json(); } catch (e) {} }
  const up = dkUpstreamFor(url); if (up) { const n = await dkUpstreamCount(up); if (n !== null && n > up.limit) return dkBusy(up); }
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 404) return { _notfound: true };
  if (!r.ok) return { _error: `SEC EDGAR returned ${r.status}` };
  const txt = await r.text();
  try { await cache.put(ckey, new Response(txt, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + ttl } })); } catch (e) {}
  try { return JSON.parse(txt); } catch (e) { return { _error: "bad json from EDGAR" }; }
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
    // Annual series for one concept: full-year 10-K periods only (flow concepts ~12 months; instant concepts have no start),
    // one value per period end (latest filing wins), sorted oldest -> newest, labelled with the fiscal year the period belongs to.
    const annualSeries = (concept) => {
      const node = gaap[concept];
      if (!node || !node.units) return null;
      const unitKey = node.units.USD ? "USD" : Object.keys(node.units)[0];
      const rows = (node.units[unitKey] || []).filter((r) => r.form && /^10-K/.test(r.form) && r.end);
      const days = (r) => r.start ? (Date.parse(r.end) - Date.parse(r.start)) / 86400000 : null;
      const yearly = rows.filter((r) => { const d = days(r); return d === null || (d >= 340 && d <= 390); });
      const primaryEnd = {};
      for (const r of yearly) { if (!primaryEnd[r.accn] || r.end > primaryEnd[r.accn]) primaryEnd[r.accn] = r.end; }
      const byEnd = {};
      for (const r of yearly) { const prev = byEnd[r.end]; if (!prev || (r.filed || "") > (prev.filed || "")) byEnd[r.end] = r; }
      const fyOf = {};
      for (const r of yearly) { if (primaryEnd[r.accn] === r.end && r.fy) fyOf[r.end] = r.fy; }
      const series = Object.keys(byEnd).sort().map((end) => { const r = byEnd[end]; return { fiscal_year: fyOf[end] || null, period_start: r.start || null, period_end: end, value: r.val, form: r.form, filed: r.filed }; });
      return { unit: unitKey, series };
    };
    const REVENUE_CONCEPTS = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"];
    const freshestRevenue = () => {
      let best = null;
      for (const c of REVENUE_CONCEPTS) { const s = annualSeries(c); const last = s && s.series.slice(-1)[0]; if (last && (!best || last.period_end > best.period_end)) best = Object.assign({ concept: c, unit: s.unit }, last); }
      return best;
    };
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
      const raw = String(args.concept).trim();
      const ALIASES = { revenue: "__revenue", revenues: "__revenue", sales: "__revenue", "net income": "NetIncomeLoss", netincome: "NetIncomeLoss", profit: "NetIncomeLoss", assets: "Assets", liabilities: "Liabilities", equity: "StockholdersEquity", cash: "CashAndCashEquivalentsAtCarryingValue", eps: "EarningsPerShareDiluted" };
      let concept = ALIASES[raw.toLowerCase()] || raw;
      if (concept !== "__revenue" && !gaap[concept]) { const ci = Object.keys(gaap).find((k) => k.toLowerCase() === raw.toLowerCase()); if (ci) concept = ci; }
      let note;
      if (concept === "__revenue") {
        let best = null;
        for (const c of REVENUE_CONCEPTS) { const s = annualSeries(c); const last = s && s.series.slice(-1)[0]; if (last && (!best || last.period_end > best.last.period_end)) best = { c, s, last }; }
        if (!best) return { error: `No annual revenue reported in XBRL for ${facts.entityName}.` };
        note = `Companies report revenue under different us-gaap concepts over time; using '${best.c}', the one with the most recent annual data.`;
        concept = best.c;
      }
      const s = annualSeries(concept);
      if (!s) return { error: `Concept '${raw}' is not in ${facts.entityName}'s XBRL filings. Try revenue, NetIncomeLoss, Assets, StockholdersEquity, EarningsPerShareDiluted.` };
      if (!s.series.length) return { error: `Concept '${concept}' has no full-year 10-K values for ${facts.entityName}.` };
      const last = s.series.slice(-1)[0];
      const fresh = freshestRevenue();
      const stale = fresh && (Date.parse(fresh.period_end) - Date.parse(last.period_end)) > 400 * 86400000;
      const out = { company: facts.entityName, concept, unit: s.unit, annual_only: true, history: s.series.slice(-10) };
      if (note) out.note = note;
      if (stale) out.warning = `Latest '${concept}' value is for the period ending ${last.period_end}, but this company has reported newer annual data under other concepts (through ${fresh.period_end}). It likely stopped using this concept; for revenue ask for concept 'revenue'.`;
      return out;
    }
    const out = { company: facts.entityName, cik: ent.cik, revenue: null, latest_reported: {} };
    const rev = freshestRevenue();
    if (rev) out.revenue = { value: rev.value, unit: rev.unit, period_end: rev.period_end, fiscal_year: rev.fiscal_year, concept: rev.concept };
    let newest = "";
    for (const c of KEY_CONCEPTS) { const s = annualSeries(c); const last = s && s.series.slice(-1)[0]; if (last) { out.latest_reported[c] = { value: last.value, unit: s.unit, period_end: last.period_end, fiscal_year: last.fiscal_year, form: last.form }; if (last.period_end > newest) newest = last.period_end; } }
    for (const c of Object.keys(out.latest_reported)) { const v = out.latest_reported[c]; if (newest && (Date.parse(newest) - Date.parse(v.period_end)) > 400 * 86400000) v.stale = true; }
    out.note = "Annual (10-K) values only. 'revenue' is the most recent figure across the revenue concepts this company has used; entries marked stale are concepts the company no longer reports.";
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
      const meta = access.pro ? "" : "";
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
<div class="tier"><b>$15/mo · Pro</b><span>50,000 calls / month · no daily limit</span><span>One key unlocks all nine Datakoot servers. Full speed to 50k, then free-tier speed or top up — never cut off.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
</div></section>
</div>
<footer><a href="https://datakoot.com/" style="color:inherit">Datakoot</a> — infrastructure for the agent economy · <a href="https://github.com/datakoot">GitHub</a> · Data: U.S. SEC EDGAR (public domain)</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ router */
const __dkInner = {
  async fetch(request, env) {
    if (DK_SALT === null) DK_SALT = env.IP_SALT || "";
    if (DK_QDB === null) DK_QDB = env.QUOTA_DB || false;
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
const DK_PRO_INCLUDED = 50000;    // calls included in Pro each month
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
// --- Global upstream circuit breaker (shared across all callers, colos, IPs) ---
// Caching absorbs repeated queries; this caps how fast DISTINCT queries reach a
// rate-sensitive source, so no flood can get Datakoot blocked. Trips into an
// honest "briefly busy, retry" - never fake data. Fails open on any D1 problem.
let DK_QDB = null;
const DK_UP_LIMITS = [{ host: "data.sec.gov", key: "sec", win: 10, limit: 50 }, { host: "www.sec.gov", key: "sec", win: 10, limit: 50 }, { host: "efts.sec.gov", key: "sec", win: 10, limit: 50 }];
function dkUpstreamFor(url) {
  try { const h = new URL(url).hostname; for (const x of DK_UP_LIMITS) if (x.host === h) return x; return null; }
  catch (e) { return null; }
}
const DK_UP_SQL = "INSERT INTO upstream_rl (k, n, exp) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n";
async function dkUpstreamCount(u) {
  if (!DK_QDB) return null;
  const now = Math.floor(Date.now() / 1000); const bucket = Math.floor(now / u.win);
  try { const row = await DK_QDB.prepare(DK_UP_SQL).bind("up:" + u.key + ":" + bucket, (bucket + 1) * u.win).first();
        return row && typeof row.n === "number" ? row.n : null; }
  catch (e) { return null; }
}
function dkBusy(u) {
  return { _busy: true, _error: "Datakoot is briefly pausing calls to " + u.key.toUpperCase() +
    " to stay within its fair-use rate limit. This is a short, deliberate pause on our side, NOT an outage and NOT a statement about your query - retry in a few seconds." };
}
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
  // Internal Datakoot services (Koot, the x402 gateway) authenticate with a shared secret and are not metered, so a
  // burst through them can never drain a customer's or the founder's Pro allowance. Nothing else changes.
  if (env.DK_INTERNAL) { const _ik = request.headers.get("X-DK-Internal") || ""; if (_ik.length === String(env.DK_INTERNAL).length && _ik === String(env.DK_INTERNAL)) return { ok: true, allowed: true, pro: true, internal: true, remaining: null, limit: null, used: null, headers: {}, meta: "" }; }
  let key = (request.headers.get("Authorization") || "").trim();
  if (key.toLowerCase().indexOf("bearer ") === 0) key = key.slice(7).trim();
  if (!key) key = (request.headers.get("X-Datakoot-Key") || "").trim();

  if (key) {
    let pro = false;
    if (env.RL) { try { if ((await env.RL.get("pk:" + (await dkSha96("dk1:" + key)))) === "1") pro = true; } catch (e) {} }
    if (!pro) {
      try {
        var __dkSure = false; const vr = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, organization_id: DK_POLAR_ORG }),
        }); __dkSure = vr.ok || vr.status === 400 || vr.status === 404 || vr.status === 422;
        if (vr.ok) { const _pd = await vr.json().catch(() => null); pro = !!(_pd && (!("status" in _pd) || _pd.status === "granted")); if (pro && env.RL) { try { await env.RL.put("pk:" + (await dkSha96("dk1:" + key)), "1", { expirationTtl: 3600 }); } catch (e) {} } }
      } catch (e) { /* Polar unreachable: fall through to the invalid-key branch */ }
    }
    if (pro && __dkSure && env.RL) { try { await env.RL.put("pkok:" + (await dkSha96("dk1:" + key)), "1", { expirationTtl: 2592000 }); } catch (e) {} }
    /* Polar hiccup (429/5xx/network): honour a key that validated within 30 days. Only an explicit "no" rejects. */
    if (!pro && !__dkSure && env.RL) { try { if (await env.RL.get("pkok:" + (await dkSha96("dk1:" + key)))) pro = true; } catch (e) {} }
    if (!pro) {
      // A key that does not validate used to fall silently back to the free
      // tier, so a paying customer with a typo looked throttled for no reason.
      return { allowed: false, ok: false, pro: false, remaining: 0, limit: DK_FREE_LIMIT, meta: "",
        headers: dkHeaders(DK_FREE_LIMIT, 0),
        message: "That Datakoot API key was not recognised. Check it at https://datakoot.com/pricing, or remove the Authorization header to use the free tier (" + DK_FREE_LIMIT + " calls/day, no signup)." };
    }
    // Pro: 50,000 calls a month, no daily limit. Past the monthly bucket we do
    // NOT bill overage and never hard-wall: soft-fall-back to the free daily
    // allowance for the rest of the month, or top up.
    if (env.QUOTA_DB) {
      try {
        const used = await dkBump(env, "pro:" + (await dkSha96("dk1:" + key)), new Date().toISOString().slice(0, 7));
        if (used <= DK_PRO_INCLUDED) return DK_OPEN;
        // bucket spent -> fall through to the free daily meter below (soft fallback)
      } catch (e) { console.error("QUOTA error (pro):", e && e.message); return DK_OPEN; }
    } else {
      return DK_OPEN;
    }
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
      message: "Daily free limit reached (" + DK_FREE_LIMIT + " calls). It resets at 00:00 UTC. Keep going right now with no account: $0.002 USDC per call via x402 at https://x402.datakoot.com/filings/mcp (charged only on success). Or Datakoot Pro is " + DK_PRO_INCLUDED.toLocaleString() + " calls a month across all nine servers for $15 with no daily limit — " + DK_CHECKOUT };
  }
  const left = DK_FREE_LIMIT - n;
  return { allowed: true, ok: true, pro: false, remaining: left, limit: DK_FREE_LIMIT, message: "",
    headers: dkHeaders(DK_FREE_LIMIT, left), meta: "" };
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




/* ---- Datakoot agent metadata layer v2 (2026-10-03) ----
 * Wraps the server without touching tool logic:
 *  - tools/list: title, MCP annotations (read-only lookups), sharper descriptions where needed,
 *    and an outputSchema listing the fields each tool returns.
 *  - tools/call: forgiving inputs (common agent mistakes are normalised before the tool sees them)
 *    and structuredContent (the parsed JSON object) on every successful result.
 * Anything that is not a JSON tools/list or tools/call exchange passes through byte-for-byte.
 */
const __DK_EXTRA = {"company_lookup":{"outputKeys":["cik","name","tickers","exchanges","sic","industry","category","fiscal_year_end","ein","state","former_names"]},"recent_filings":{"outputKeys":["company","cik","count","filings"]},"filing_search":{"outputKeys":["query","total","results"],"params":{"query":"Words or an exact phrase to find anywhere in EDGAR filing text, e.g. \"going concern\" or a product name."}},"financials":{"outputKeys":["company","concept","unit","annual_only","history","note","cik","revenue","latest_reported"]},"insider_transactions":{"outputKeys":["company","cik","note","filings"]}};
const __DK_COUNTRIES = null;
const __DK_ACRONYMS = { cve: "CVE", epss: "EPSS", fx: "FX", dns: "DNS", us: "US", sec: "SEC", rdap: "RDAP", url: "URL", ip: "IP" };
const __DK_STATES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR", guam: "GU", "american samoa": "AS", "virgin islands": "VI", "us virgin islands": "VI", "northern mariana islands": "MP" };

function __dkTitle(name) {
  return String(name).split("_").map((w) => __DK_ACRONYMS[w] || (w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}
function __dkDecorate(tool) {
  if (!tool || typeof tool !== "object" || !tool.name) return tool;
  const x = __DK_EXTRA[tool.name] || {};
  const title = tool.title || __dkTitle(tool.name);
  const out = Object.assign({}, tool, { title });
  if (x.description) out.description = x.description;
  if (x.params && out.inputSchema && out.inputSchema.properties) {
    const props = Object.assign({}, out.inputSchema.properties);
    for (const k of Object.keys(x.params)) if (props[k]) props[k] = Object.assign({}, props[k], { description: x.params[k] });
    out.inputSchema = Object.assign({}, out.inputSchema, { properties: props });
  }
  if (!out.outputSchema && Array.isArray(x.outputKeys) && x.outputKeys.length) {
    const p = {}; for (const k of x.outputKeys) p[k] = {};
    out.outputSchema = { type: "object", properties: p, additionalProperties: true };
  }
  out.annotations = Object.assign({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, tool.annotations || {});
  return out;
}

const __dkTrim = (v) => (typeof v === "string" ? v.trim() : v);
function __dkIsoDate(v) {
  if (typeof v !== "string") return v;
  const s = v.trim(); let m;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
  if ((m = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/))) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  return s;
}
function __dkCve(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  return /^\d{4}-\d{4,}$/.test(s) ? "CVE-" + s : s;
}
function __dkCountry(v) {
  if (typeof v !== "string" || !__DK_COUNTRIES) return v;
  const s = v.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const hit = __DK_COUNTRIES[s.toLowerCase()];
  return hit || s;
}
function __dkNormalize(name, a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return a;
  const o = Object.assign({}, a);
  for (const k of Object.keys(o)) o[k] = __dkTrim(o[k]);
  if ((name === "cve_lookup" || name === "known_exploited" || name === "epss_score") && o.cve_id) o.cve_id = __dkCve(o.cve_id);
  if (name === "epss_score" && o.cve_ids) {
    const list = Array.isArray(o.cve_ids) ? o.cve_ids : String(o.cve_ids).split(",");
    o.cve_ids = list.map(__dkCve);
  }
  if (typeof o.ecosystem === "string") {
    o.ecosystem = o.ecosystem.toLowerCase();
    if (o.ecosystem === "npm" && typeof o.name === "string" && !o.name.startsWith("@")) o.name = o.name.toLowerCase();
  }
  if (o.country) o.country = __dkCountry(o.country);
  if (Array.isArray(o.countries)) o.countries = o.countries.map(__dkCountry);
  if (name === "fx_historical" && o.date) o.date = __dkIsoDate(o.date);
  if (name === "fx_timeseries") { if (o.start) o.start = __dkIsoDate(o.start); if (o.end) o.end = __dkIsoDate(o.end); }
  if (name === "weather_alerts" && typeof o.area === "string") { const st = __DK_STATES[o.area.toLowerCase()]; o.area = st || (/^[a-z]{2}$/i.test(o.area) ? o.area.toUpperCase() : o.area); }
  if (name === "tx_status" && typeof o.hash === "string" && /^[0-9a-fA-F]{64}$/.test(o.hash)) o.hash = "0x" + o.hash;
  return o;
}
function __dkTitleCase(s) {
  return String(s).trim().replace(/\s+/g, " ").split(" ").map((w) => (/^[a-z]{2}$/i.test(w) && w === w.toLowerCase() && w.length === 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

function __dkWithBody(request, body) {
  const h = new Headers(request.headers); h.delete("content-length");
  return new Request(request.url, { method: "POST", headers: h, body: JSON.stringify(body) });
}
async function __dkJson(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try { return await res.clone().json(); } catch (e) { return null; }
}
function __dkRespond(res, body) {
  const h = new Headers(res.headers); h.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: h });
}
function __dkAddStructured(body) {
  const r = body && body.result;
  if (!r || r.isError || r.structuredContent !== undefined || !Array.isArray(r.content) || !r.content[0] || r.content[0].type !== "text") return false;
  try {
    const parsed = JSON.parse(r.content[0].text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { r.structuredContent = parsed; return true; }
  } catch (e) {}
  return false;
}

async function __dkWrappedFetch(request, env, ctx) {
  let msg = null;
  if (request.method === "POST") {
    try { const peek = await request.clone().json(); if (peek && !Array.isArray(peek)) msg = peek; } catch (e) { msg = null; }
  }
  const method = msg && msg.method;
  if (method !== "tools/list" && method !== "tools/call") return __dkInner.fetch(request, env, ctx);

  if (method === "tools/list") {
    const res = await __dkInner.fetch(request, env, ctx);
    const body = await __dkJson(res);
    if (!body || !body.result || !Array.isArray(body.result.tools)) return res;
    body.result.tools = body.result.tools.map(__dkDecorate);
    return __dkRespond(res, body);
  }

  // tools/call
  const name = msg.params && msg.params.name;
  let req = request;
  try {
    const args = (msg.params && msg.params.arguments) || {};
    const norm = __dkNormalize(name, args);
    if (JSON.stringify(norm) !== JSON.stringify(args)) req = __dkWithBody(request, Object.assign({}, msg, { params: Object.assign({}, msg.params, { arguments: norm }) }));
  } catch (e) { req = request; }
  let res = await __dkInner.fetch(req, env, ctx);
  // Per-tool usage counter (which tools callers actually use). Counts tool + server per UTC day, plus whether a key was sent
  // (keyed 1 = Pro key incl. our demos; 2 = internal Datakoot service such as Koot or the x402 gateway; 0 = anonymous free callers). Nothing else about the caller.
  if (env.QUOTA_DB && ctx && typeof name === "string" && name.length < 64) ctx.waitUntil((async () => {
    try {
      await env.QUOTA_DB.prepare("CREATE TABLE IF NOT EXISTS tool_calls (day TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, keyed INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, server, tool, keyed))").run();
      await env.QUOTA_DB.prepare("INSERT INTO tool_calls (day, server, tool, keyed, n) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT(day, server, tool, keyed) DO UPDATE SET n = n + 1").bind(new Date().toISOString().slice(0, 10), new URL(request.url).hostname.split(".")[0], name, request.headers.get("X-DK-Internal") ? 2 : /^Bearer\s+\S/.test(request.headers.get("Authorization") || "") ? 1 : 0).run();
    } catch (e) { console.error("tool_usage count failed:", e && e.message); }
  })());
  let body = await __dkJson(res);
  // geocode: the Census place gazetteer is case-sensitive; retry once with proper capitalisation.
  if (name === "geocode" && body && body.result && body.result.isError) {
    const addr = msg.params && msg.params.arguments && msg.params.arguments.address;
    const fixed = typeof addr === "string" ? __dkTitleCase(addr) : null;
    if (fixed && fixed !== addr) {
      const res2 = await __dkInner.fetch(__dkWithBody(request, Object.assign({}, msg, { params: Object.assign({}, msg.params, { arguments: Object.assign({}, msg.params.arguments, { address: fixed }) }) })), env, ctx);
      const body2 = await __dkJson(res2);
      if (body2 && body2.result && !body2.result.isError) { res = res2; body = body2; }
    }
  }
  if (!body) return res;
  return __dkAddStructured(body) ? __dkRespond(res, body) : res;
}

// Datakoot key shim (2026-10-04): lets a client send the Pro key as "X-Datakoot-Key: <key>"
// (e.g. Smithery, which can forward a header but can't add a "Bearer " prefix). An explicit
// X-Datakoot-Key wins over any other Authorization value. Everything downstream is unchanged.
const __dkKeyShim = (request) => {
  try {
    const k = (request.headers.get("X-Datakoot-Key") || "").trim();
    if (k && /^[A-Za-z0-9._-]{8,200}$/.test(k)) {
      const h = new Headers(request.headers);
      h.set("Authorization", "Bearer " + k);
      h.delete("X-Datakoot-Key");
      return new Request(request, { headers: h });
    }
  } catch (_) {}
  return request;
};


// Datakoot provenance (2026-10-08): every successful tools/call answer carries
// provenance = { served_at, upstream[], publisher, may_be_cached }, and tools/list
// advertises the field in each tool's outputSchema. Tools whose outputSchema forbids
// extra properties get it in result._meta["com.datakoot/provenance"] instead, so no
// published contract is broken. Pure decoration: on any error the original response
// is returned untouched.
const __DK_STRICT = new Set(["fx_rates", "fx_historical", "fx_currencies"]);
const __DK_PROV_SCHEMA = {
  type: "object",
  description: "Where this answer came from. served_at is when Datakoot answered (UTC); upstream lists the official sources consulted. Datakoot may serve a briefly cached copy, so the source's own observation can be older than served_at.",
  properties: {
    served_at: { type: "string", format: "date-time" },
    upstream: { type: "array", items: { type: "string" } },
    publisher: { type: "string" },
    may_be_cached: { type: "boolean" }
  }
};
function __dkUpstream(n, a) {
  a = a || {};
  const eco = String(a.ecosystem || "").toLowerCase();
  const reg = eco === "npm" ? "npm registry (registry.npmjs.org)"
    : (eco === "pypi" || eco === "pip") ? "PyPI (pypi.org)"
    : (eco === "cargo" || eco === "crates" || eco === "crates.io") ? "crates.io" : null;
  const DEPS = "deps.dev (Open Source Insights)";
  switch (n) {
    case "cve_lookup": return ["NIST National Vulnerability Database (NVD)", "CISA Known Exploited Vulnerabilities catalog", "FIRST EPSS"];
    case "known_exploited": return ["CISA Known Exploited Vulnerabilities catalog"];
    case "epss_score": return ["FIRST EPSS"];
    case "package_vulnerabilities": case "audit_dependencies": return ["OSV.dev"];
    case "package_info": case "package_versions": case "package_search": return reg ? [reg] : ["npm registry", "PyPI", "crates.io"];
    case "package_downloads": return eco === "npm" ? ["npm downloads API (api.npmjs.org)"] : (reg ? [reg] : ["npm downloads API", "crates.io"]);
    case "package_dependencies": return [DEPS].concat(reg ? [reg] : []);
    case "package_health": return (reg ? [reg] : []).concat([DEPS]);
    case "company_lookup": case "recent_filings": case "filing_search": case "financials": case "insider_transactions": return ["SEC EDGAR"];
    case "country_indicator": case "country_profile": case "compare_countries": return ["World Bank Open Data"];
    case "us_series": return /retail/i.test(String(a.series || "")) ? ["US Census Bureau (Advance Monthly Retail Trade)"] : ["US Bureau of Labor Statistics"];
    case "list_indicators": return ["World Bank Open Data", "US Bureau of Labor Statistics", "US Census Bureau"];
    case "fx_rates": case "fx_convert": case "fx_historical": case "fx_timeseries": case "fx_currencies": return ["European Central Bank reference rates (via the Frankfurter API)"];
    case "geocode": return ["US Census Geocoder", "US Census TIGERweb"];
    case "weather_forecast": case "weather_current": case "weather_alerts": return ["US National Weather Service (api.weather.gov)"];
    case "earthquakes": return ["USGS Earthquake Hazards Program"];
    case "elevation": return ["USGS Elevation Point Query Service (3DEP)"];
    case "domain_intel": return ["RDAP (via rdap.org bootstrap)"];
    case "dns_lookup": return ["Cloudflare DNS over HTTPS"];
    case "email_deliverability": return ["DNS records (via Cloudflare DNS over HTTPS)"];
    case "tech_stack": return ["The target website itself"];
    case "subdomains": return ["Certificate Transparency logs (crt.sh, Cert Spotter)"];
    case "domain_report": return ["RDAP (via rdap.org bootstrap)", "Cloudflare DNS over HTTPS", "The target website itself"];
    case "search_documents": case "document": case "recent_documents": case "executive_orders": case "agencies": return ["Federal Register API (federalregister.gov)"];
    case "address_report": case "token_info": case "token_balance": case "gas_now": case "tx_status": return ["Base mainnet public JSON-RPC"];
  }
  return [];
}
async function __dkProvenance(request, run) {
  if (request.method !== "POST") return run(request);
  let msgs;
  try { msgs = JSON.parse(await request.clone().text()); } catch (_) { return run(request); }
  const arr = Array.isArray(msgs) ? msgs : [msgs];
  const calls = new Map(); let wantsList = false;
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    if (m.method === "tools/call" && m.params && typeof m.params.name === "string") calls.set(JSON.stringify(m.id), m.params);
    if (m.method === "tools/list") wantsList = true;
  }
  if (!calls.size && !wantsList) return run(request);
  const res = await run(request);
  try {
    if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
    const out = JSON.parse(await res.clone().text());
    const outs = Array.isArray(out) ? out : [out];
    const now = new Date().toISOString();
    let changed = false;
    for (const o of outs) {
      if (!o || !o.result || typeof o.result !== "object") continue;
      const r = o.result;
      if (Array.isArray(r.tools)) {
        for (const t of r.tools) {
          const os = t && t.outputSchema;
          if (!os || os.type !== "object" || os.additionalProperties === false || __DK_STRICT.has(t.name)) continue;
          os.properties = os.properties || {};
          if (!os.properties.provenance) { os.properties.provenance = __DK_PROV_SCHEMA; changed = true; }
        }
      }
      const p = calls.get(JSON.stringify(o.id));
      const sc = r.structuredContent;
      if (!p || r.isError || !sc || typeof sc !== "object" || Array.isArray(sc)) continue;
      const prov = { served_at: now, upstream: __dkUpstream(p.name, p.arguments), publisher: "Datakoot (datakoot.com)", may_be_cached: true };
      if (__DK_STRICT.has(p.name)) {
        r._meta = Object.assign({}, r._meta, { "com.datakoot/provenance": prov });
        changed = true;
      } else if (!("provenance" in sc)) {
        const before = JSON.stringify(sc, null, 2);
        r.structuredContent = Object.assign({}, sc, { provenance: prov });
        if (Array.isArray(r.content)) {
          for (const c of r.content) {
            if (c && c.type === "text" && c.text === before) c.text = JSON.stringify(r.structuredContent, null, 2);
          }
        }
        changed = true;
      }
    }
    if (!changed) return res;
    const h = new Headers(res.headers); h.delete("content-length");
    return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers: h });
  } catch (_) { return res; }
}

export default Object.assign({}, __dkInner, { fetch: (request, env, ctx) => __dkProvenance(request, (r) => __dkWrappedFetch(__dkKeyShim(r), env, ctx)) });


