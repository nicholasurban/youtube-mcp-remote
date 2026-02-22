#!/usr/bin/env node
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// @ts-ignore — accessing unexported internals of @kirbah/mcp-youtube
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
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token.length !== AUTH_TOKEN!.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN!));
}

async function main(): Promise<void> {
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
    try {
      // Create fresh server per request to avoid connect() race condition
      const container = initializeContainer({ apiKey: API_KEY as string });
      const server = createMcpServer(container);
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
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
