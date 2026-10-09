# Runs this server's own code (worker.js) locally as an MCP stdio server, so
# registries such as Glama can start it and run initialize / tools/list.
# Production is hosted at https://filings.datakoot.com/mcp (no API key).
FROM node:22-alpine
WORKDIR /app
COPY . .
CMD ["node", "stdio.mjs"]
