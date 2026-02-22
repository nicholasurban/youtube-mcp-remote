#!/usr/bin/env node
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// @ts-ignore — package internals
import { createMcpServer } from "@kirbah/mcp-youtube/dist/server.js";
// @ts-ignore
import { initializeContainer } from "@kirbah/mcp-youtube/dist/container.js";

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const API_KEY = process.env.YOUTUBE_API_KEY;
const PORT = Number(process.env.PORT || "3000");

if (!AUTH_TOKEN) {
  console.error("ERROR: MCP_AUTH_TOKEN required");
  process.exit(1);
}
if (!API_KEY) {
  console.error("ERROR: YOUTUBE_API_KEY required");
  process.exit(1);
}

function validateToken(req: express.Request): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  return auth.replace(/^Bearer\s+/i, "") === AUTH_TOKEN;
}

async function main(): Promise<void> {
  const container = initializeContainer({ apiKey: API_KEY as string });
  const server = createMcpServer(container);

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    if (!validateToken(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(PORT, () => {
    console.error(`YouTube MCP server on http://0.0.0.0:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
