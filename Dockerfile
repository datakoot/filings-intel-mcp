# Hosted, keyless MCP server — https://filings.datakoot.com/mcp (no API key).
# This image bridges the hosted endpoint to stdio with mcp-remote so
# registries (e.g. Glama) can start it and run initialize / tools/list.
FROM node:22-alpine
RUN npm install -g mcp-remote@0.14.3
ENTRYPOINT ["mcp-remote", "https://filings.datakoot.com/mcp", "--transport", "http-only"]
