#!/usr/bin/env node
// The MCP server's SDK is an optional add-on, so a harness that only imports gamecheck's modules does not install it.
try {
  await Promise.all([import('@modelcontextprotocol/sdk/server/mcp.js'), import('zod')]);
} catch {
  console.error('gamecheck-mcp needs @modelcontextprotocol/sdk and zod beside it. Run it as\n  npx -y -p @xallindrome-labs/gamecheck -p @modelcontextprotocol/sdk -p zod gamecheck-mcp\nor install them: npm install @modelcontextprotocol/sdk zod');
  process.exit(1);
}
await import('./mcpServer.js');
