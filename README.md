# Filings Intel MCP — by Datakoot

SEC EDGAR for AI agents — as MCP tools your agent can call mid-task to research a US public company's filings, financials and insider activity. No API keys.

## Tools

| Tool | What it does | Source |
|---|---|---|
| `company_lookup` | Find a company's CIK and metadata by name or ticker | SEC EDGAR |
| `recent_filings` | List a company's most recent filings, filterable by form type (10-K, 8-K, ...) | SEC EDGAR |
| `filing_search` | Full-text search across EDGAR filings | SEC EDGAR |
| `financials` | Key XBRL financial facts (revenue, net income, assets, ...) for a company | SEC EDGAR |
| `insider_transactions` | Recent Form 3/4/5 insider buys and sells | SEC EDGAR |

No API keys required.

## Quick start

```
claude mcp add --transport http filings-intel https://filings.datakoot.com/mcp
```

Or point any MCP client at `https://filings.datakoot.com/mcp`.

## Data & attribution

All data comes from the [SEC EDGAR](https://www.sec.gov/edgar) system (US Securities and Exchange Commission), which is US-government public domain. Requests are made with an identifying User-Agent per SEC's fair-access policy. Informational only — not investment advice.

Part of [Datakoot](https://datakoot.com) — keyless intelligence APIs for AI agents.
