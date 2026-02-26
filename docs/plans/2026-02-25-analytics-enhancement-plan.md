# YouTube MCP Server Analytics Enhancement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 8 new tools (analytics, SEO, discovery), a universal resilience layer with n8n alerting, and token optimization to the youtube-mcp-remote MCP server.

**Architecture:** New tools are registered in a new file `src/analytics-tools.ts` (analytics) and `src/discovery-tools.ts` (autocomplete + outlier channels). A shared `src/resilience.ts` module wraps every tool handler with failure tracking, n8n webhook alerts, and auto-disable. A `src/trim.ts` utility strips YouTube API bloat from all responses. The Dockerfile gets a `/data` volume mount for CSV persistence and health state.

**Tech Stack:** TypeScript, YouTube Analytics API v2, YouTube Data API v3, undocumented YouTube suggest endpoint, n8n webhooks, Express/MCP SDK (existing)

---

### Task 1: Create the resilience module

**Files:**
- Create: `src/resilience.ts`

**Step 1: Create `src/resilience.ts`**

This module provides `withResilience()` — a wrapper for any tool handler that tracks failures, alerts n8n, and auto-disables degraded tools.

```typescript
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const HEALTH_FILE = join(DATA_DIR, "tool-health.json");
const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
const FAILURE_THRESHOLD = 3;

interface ToolHealth {
  failureCount: number;
  lastFailure: string | null;
  lastError: string | null;
  degraded: boolean;
}

type HealthState = Record<string, ToolHealth>;

function loadHealth(): HealthState {
  try {
    return JSON.parse(readFileSync(HEALTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveHealth(state: HealthState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to write tool-health.json:", err);
  }
}

async function alertN8n(
  tool: string,
  error: string,
  failureCount: number,
): Promise<void> {
  if (!N8N_WEBHOOK_URL) {
    console.error(
      `[resilience] No N8N_ALERT_WEBHOOK_URL set, skipping alert for ${tool}`,
    );
    return;
  }
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool,
        error,
        failureCount,
        timestamp: new Date().toISOString(),
        serverUrl: process.env.PUBLIC_URL || "unknown",
      }),
    });
  } catch (err) {
    console.error(`[resilience] n8n alert failed for ${tool}:`, err);
  }
}

function recordSuccess(tool: string): void {
  const state = loadHealth();
  if (state[tool]?.failureCount) {
    state[tool] = {
      failureCount: 0,
      lastFailure: null,
      lastError: null,
      degraded: false,
    };
    saveHealth(state);
  }
}

function recordFailure(
  tool: string,
  error: string,
): { degraded: boolean; failureCount: number } {
  const state = loadHealth();
  const prev = state[tool] ?? {
    failureCount: 0,
    lastFailure: null,
    lastError: null,
    degraded: false,
  };
  prev.failureCount++;
  prev.lastFailure = new Date().toISOString();
  prev.lastError = error;
  if (prev.failureCount >= FAILURE_THRESHOLD) {
    prev.degraded = true;
  }
  state[tool] = prev;
  saveHealth(state);
  return { degraded: prev.degraded, failureCount: prev.failureCount };
}

function isDegraded(tool: string): boolean {
  const state = loadHealth();
  return state[tool]?.degraded === true;
}

/** Reset a tool's degraded status (for manual recovery). */
export function resetTool(tool: string): void {
  const state = loadHealth();
  delete state[tool];
  saveHealth(state);
}

/**
 * Wrap a tool handler with resilience: failure tracking, n8n alerts, auto-disable.
 * For tools with fallbacks, pass an array of handlers tried in order.
 */
export function withResilience<T>(
  toolName: string,
  handlers: Array<{ name: string; fn: (args: T) => Promise<unknown> }>,
): (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async (args: T) => {
    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];
      const key = `${toolName}:${handler.name}`;

      if (isDegraded(key) && i < handlers.length - 1) {
        continue; // Skip degraded handler if fallback exists
      }
      if (isDegraded(key) && i === handlers.length - 1) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `[DISABLED] ${toolName}: all handlers degraded after ` +
                `repeated failures. Check /data/tool-health.json or reset manually.`,
            },
          ],
        };
      }

      try {
        const result = await handler.fn(args);
        recordSuccess(key);
        return {
          content: [
            {
              type: "text" as const,
              text:
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const { degraded, failureCount } = recordFailure(key, errorMsg);
        console.error(
          `[resilience] ${key} failure #${failureCount}: ${errorMsg}`,
        );

        if (degraded) {
          await alertN8n(
            toolName,
            `${handler.name} degraded: ${errorMsg}`,
            failureCount,
          );
        }

        if (i < handlers.length - 1) continue; // Try next handler
        throw err; // Last handler failed
      }
    }

    throw new Error(`[resilience] No handlers available for ${toolName}`);
  };
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npx tsc --noEmit src/resilience.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/resilience.ts
git commit -m "feat: add resilience module with failure tracking and n8n alerts"
```

---

### Task 2: Create the token optimization utility

**Files:**
- Create: `src/trim.ts`

**Step 1: Create `src/trim.ts`**

Strips YouTube API noise from any JSON response.

```typescript
/** Keys to strip from YouTube API responses. */
const STRIP_KEYS = new Set([
  "etag",
  "kind",
  "pageInfo",
  "nextPageToken",
  "prevPageToken",
  "localized",
  "regionRestriction",
  "contentRating",
  "recordingDetails",
  "fileDetails",
  "processingDetails",
  "suggestions",
]);

/** Thumbnail sizes to keep (drop the rest). */
const KEEP_THUMBS = new Set(["medium"]);

/**
 * Recursively strip noise from a YouTube API response.
 * Returns a cleaned copy without mutating input.
 */
export function trimResponse(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(trimResponse);
  if (typeof data !== "object") return data;

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (STRIP_KEYS.has(key)) continue;

    if (key === "thumbnails" && typeof value === "object" && value !== null) {
      const thumbs = value as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const size of KEEP_THUMBS) {
        if (thumbs[size]) kept[size] = thumbs[size];
      }
      if (Object.keys(kept).length > 0) {
        result[key] = kept;
      }
      continue;
    }

    result[key] = trimResponse(value);
  }

  return result;
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npx tsc --noEmit src/trim.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/trim.ts
git commit -m "feat: add trimResponse utility for token optimization"
```

---

### Task 3: Export shared helpers from write-tools.ts

**Files:**
- Modify: `src/write-tools.ts:5-6,9`

**Step 1: Export constants and ytFetch**

Line 5: change `const YT_API` to `export const YT_API`
Line 6: change `const YT_ANALYTICS_API` to `export const YT_ANALYTICS_API`
Line 9: change `async function ytFetch` to `export async function ytFetch`

**Step 2: Import and apply trimResponse to existing tools**

Add after line 3:
```typescript
import { trimResponse } from "./trim.js";
```

Wrap `JSON.stringify(...)` calls in these tools with `trimResponse()`:
- `getChannelComments` (line 107): `JSON.stringify(trimResponse(comments), null, 2)`
- `replyToComment` (line 167): `JSON.stringify(trimResponse(body), null, 2)`
- `updateComment` (line 239): `JSON.stringify(trimResponse(body), null, 2)`
- `updateVideoMetadata` (line 339): `JSON.stringify(trimResponse(body), null, 2)`
- `getVideoAnalytics` (line 389): `JSON.stringify(trimResponse(body), null, 2)`

**Step 3: Build to verify**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/write-tools.ts
git commit -m "feat: export shared helpers, apply token optimization to existing tools"
```

---

### Task 4: Create the analytics tools

**Files:**
- Create: `src/analytics-tools.ts`

**Step 1: Create `src/analytics-tools.ts`**

Six analytics tools using YouTube Analytics API v2. Each uses `ytFetch` (from write-tools), `withResilience`, and `trimResponse`.

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ytFetch, YT_ANALYTICS_API } from "./write-tools.js";
import { withResilience } from "./resilience.js";
import { trimResponse } from "./trim.js";

export function registerAnalyticsTools(server: McpServer): void {
  // ─── getDemographics ─────────────────────────────────────────────
  server.registerTool(
    "getDemographics",
    {
      description:
        "Get audience demographics (age group and gender) for your channel. " +
        "Returns viewer percentage by age range (13-17 through 65+) and gender.",
      inputSchema: {
        startDate: z.string().describe("Start date YYYY-MM-DD"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by video ID (omit for channel-wide)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getDemographics", [
      {
        name: "analyticsApi",
        fn: async ({
          startDate,
          endDate,
          videoId,
        }: {
          startDate: string;
          endDate: string;
          videoId?: string;
        }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set("metrics", "viewerPercentage");
          url.searchParams.set("dimensions", "ageGroup,gender");
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          if (videoId) url.searchParams.set("filters", `video==${videoId}`);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getGeography ────────────────────────────────────────────────
  server.registerTool(
    "getGeography",
    {
      description:
        "Get views by country for your channel. " +
        "Returns views, watch time, and subscribers gained per country.",
      inputSchema: {
        startDate: z.string().describe("Start date YYYY-MM-DD"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by video ID (omit for channel-wide)"),
        maxResults: z
          .number()
          .default(25)
          .describe("Max countries to return (default 25)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getGeography", [
      {
        name: "analyticsApi",
        fn: async ({
          startDate,
          endDate,
          videoId,
          maxResults,
        }: {
          startDate: string;
          endDate: string;
          videoId?: string;
          maxResults: number;
        }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set(
            "metrics",
            "views,estimatedMinutesWatched,subscribersGained",
          );
          url.searchParams.set("dimensions", "country");
          url.searchParams.set("sort", "-views");
          url.searchParams.set("maxResults", String(maxResults));
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          if (videoId) url.searchParams.set("filters", `video==${videoId}`);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getTrafficSources ──────────────────────────────────────────
  server.registerTool(
    "getTrafficSources",
    {
      description:
        "Get traffic source breakdown for your channel. " +
        "Shows where viewers find your videos: YouTube search, suggested, " +
        "external, browse features, etc.",
      inputSchema: {
        startDate: z.string().describe("Start date YYYY-MM-DD"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by video ID (omit for channel-wide)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getTrafficSources", [
      {
        name: "analyticsApi",
        fn: async ({
          startDate,
          endDate,
          videoId,
        }: {
          startDate: string;
          endDate: string;
          videoId?: string;
        }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set(
            "metrics",
            "views,estimatedMinutesWatched",
          );
          url.searchParams.set("dimensions", "insightTrafficSourceType");
          url.searchParams.set("sort", "-views");
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          if (videoId) url.searchParams.set("filters", `video==${videoId}`);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getRetentionCurve ──────────────────────────────────────────
  server.registerTool(
    "getRetentionCurve",
    {
      description:
        "Get audience retention curve for a specific video. " +
        "Returns audienceWatchRatio (what % of viewers watch at each point) " +
        "and relativeRetentionPerformance (vs similar-length videos, >1.0 = above avg).",
      inputSchema: {
        videoId: z.string().min(1).describe("YouTube video ID (required)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getRetentionCurve", [
      {
        name: "analyticsApi",
        fn: async ({ videoId }: { videoId: string }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set(
            "metrics",
            "audienceWatchRatio,relativeRetentionPerformance",
          );
          url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
          url.searchParams.set("filters", `video==${videoId}`);
          url.searchParams.set("startDate", "2020-01-01");
          url.searchParams.set(
            "endDate",
            new Date().toISOString().slice(0, 10),
          );
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getDayOfWeekAnalysis ───────────────────────────────────────
  server.registerTool(
    "getDayOfWeekAnalysis",
    {
      description:
        "Get average performance by day of week for your channel. " +
        "Helps determine best day to publish. Uses at least 90 days of data " +
        "for meaningful results.",
      inputSchema: {
        startDate: z
          .string()
          .describe("Start date YYYY-MM-DD (use 90+ days for meaningful data)"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getDayOfWeekAnalysis", [
      {
        name: "analyticsApi",
        fn: async ({
          startDate,
          endDate,
        }: {
          startDate: string;
          endDate: string;
        }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set(
            "metrics",
            "views,estimatedMinutesWatched,subscribersGained,likes,shares",
          );
          url.searchParams.set("dimensions", "day");
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);

          const raw = (await ytFetch(url.toString())) as {
            columnHeaders: Array<{ name: string }>;
            rows: Array<Array<string | number>>;
          };

          const dayNames = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ];
          const buckets: Record<
            number,
            {
              count: number;
              views: number;
              watchTime: number;
              subs: number;
              likes: number;
              shares: number;
            }
          > = {};
          for (let d = 0; d < 7; d++) {
            buckets[d] = {
              count: 0,
              views: 0,
              watchTime: 0,
              subs: 0,
              likes: 0,
              shares: 0,
            };
          }

          for (const row of raw.rows ?? []) {
            const dateStr = row[0] as string;
            const dow = new Date(dateStr + "T12:00:00Z").getUTCDay();
            const b = buckets[dow];
            b.count++;
            b.views += Number(row[1]) || 0;
            b.watchTime += Number(row[2]) || 0;
            b.subs += Number(row[3]) || 0;
            b.likes += Number(row[4]) || 0;
            b.shares += Number(row[5]) || 0;
          }

          return dayNames.map((name, i) => {
            const b = buckets[i];
            const n = b.count || 1;
            return {
              day: name,
              daysInRange: b.count,
              avgViews: Math.round(b.views / n),
              avgWatchTimeMinutes: Math.round(b.watchTime / n),
              avgSubscribersGained: +(b.subs / n).toFixed(1),
              avgLikes: Math.round(b.likes / n),
              avgShares: Math.round(b.shares / n),
            };
          });
        },
      },
    ]),
  );

  // ─── getContentTypeBreakdown ────────────────────────────────────
  server.registerTool(
    "getContentTypeBreakdown",
    {
      description:
        "Compare Shorts vs long-form vs live content on your channel. " +
        "Returns views, watch time, and subscribers gained per content type.",
      inputSchema: {
        startDate: z.string().describe("Start date YYYY-MM-DD"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getContentTypeBreakdown", [
      {
        name: "analyticsApi",
        fn: async ({
          startDate,
          endDate,
        }: {
          startDate: string;
          endDate: string;
        }) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set(
            "metrics",
            "views,estimatedMinutesWatched,subscribersGained,likes",
          );
          url.searchParams.set("dimensions", "creatorContentType");
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/analytics-tools.ts
git commit -m "feat: add 6 analytics tools (demographics, geography, traffic, retention, day-of-week, content type)"
```

---

### Task 5: Create the discovery tools (autocomplete + outlier channels)

**Files:**
- Create: `src/discovery-tools.ts`

**Step 1: Create `src/discovery-tools.ts`**

Two tools: `getAutocompleteSuggestions` (3-tier fallback) and `findOutlierChannels` (CSV tracking).

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YT_API } from "./write-tools.js";
import { withResilience } from "./resilience.js";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CSV_PATH = join(DATA_DIR, "outlier-channels.csv");

export function registerDiscoveryTools(server: McpServer): void {
  const apiKey = process.env.YOUTUBE_API_KEY!;

  // ─── getAutocompleteSuggestions ──────────────────────────────────
  server.registerTool(
    "getAutocompleteSuggestions",
    {
      description:
        "Get YouTube search autocomplete suggestions for a keyword. " +
        "Shows what people actually search for. Useful for SEO keyword research. " +
        "Uses undocumented endpoint with official API and web scrape fallbacks.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Keyword or phrase to get suggestions for"),
        language: z
          .string()
          .default("en")
          .describe("Language code (default: en)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("getAutocompleteSuggestions", [
      {
        name: "suggestEndpoint",
        fn: async ({
          query,
          language,
        }: {
          query: string;
          language: string;
        }) => {
          const url = new URL(
            "https://suggestqueries.google.com/complete/search",
          );
          url.searchParams.set("client", "youtube");
          url.searchParams.set("q", query);
          url.searchParams.set("hl", language);
          url.searchParams.set("ds", "yt");

          const res = await fetch(url.toString(), {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!res.ok)
            throw new Error(`Suggest endpoint error: ${res.status}`);

          const text = await res.text();
          // JSONP: window.google.ac.h([...])
          const jsonStr = text
            .replace(/^[^[]*/, "")
            .replace(/][^]]*$/, "]");
          const parsed = JSON.parse(jsonStr) as [
            string,
            Array<[string]>,
          ];
          const suggestions = (parsed[1] ?? []).map((item) => item[0]);

          if (suggestions.length === 0)
            throw new Error(
              "Empty suggestions, endpoint may have changed",
            );
          return { query, source: "suggestEndpoint", suggestions };
        },
      },
      {
        name: "dataApiSearch",
        fn: async ({
          query,
        }: {
          query: string;
          language: string;
        }) => {
          const url = new URL(`${YT_API}/search`);
          url.searchParams.set("part", "snippet");
          url.searchParams.set("q", query);
          url.searchParams.set("type", "video");
          url.searchParams.set("maxResults", "15");
          url.searchParams.set("order", "relevance");
          url.searchParams.set("key", apiKey);

          const res = await fetch(url.toString());
          if (!res.ok)
            throw new Error(`Data API search error: ${res.status}`);
          const data = (await res.json()) as {
            items?: Array<{ snippet?: { title?: string } }>;
          };

          const titles = (data.items ?? [])
            .map((i) => i.snippet?.title ?? "")
            .filter(Boolean);
          return { query, source: "dataApiSearch", suggestions: titles };
        },
      },
      {
        name: "webScrape",
        fn: async ({
          query,
        }: {
          query: string;
          language: string;
        }) => {
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          const res = await fetch(searchUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
          });
          if (!res.ok)
            throw new Error(`YouTube web scrape error: ${res.status}`);
          const html = await res.text();

          const match = html.match(
            /var ytInitialData = ({.*?});<\/script>/s,
          );
          if (!match)
            throw new Error(
              "Could not parse YouTube search results page",
            );

          const titles: string[] = [];
          const titlePattern =
            /"title":\s*\{"runs":\s*\[\{"text":\s*"([^"]+)"/g;
          let m: RegExpExecArray | null;
          while (
            (m = titlePattern.exec(match[1])) !== null &&
            titles.length < 15
          ) {
            titles.push(m[1]);
          }

          if (titles.length === 0)
            throw new Error("No titles extracted from web scrape");
          return { query, source: "webScrape", suggestions: titles };
        },
      },
    ]),
  );

  // ─── findOutlierChannels ────────────────────────────────────────
  server.registerTool(
    "findOutlierChannels",
    {
      description:
        "Find channels that consistently outperform in a niche. " +
        "Searches YouTube for channels, pulls stats, ranks by engagement " +
        "ratio (views/subscribers), flags outliers. Results appended to CSV " +
        "for tracking over time. New channels are flagged.",
      inputSchema: {
        niche: z
          .string()
          .min(1)
          .describe("Niche/topic (e.g., 'biohacking', 'sleep optimization')"),
        maxChannels: z
          .number()
          .default(20)
          .describe("Max channels to analyze (default 20)"),
        minSubscribers: z
          .number()
          .default(1000)
          .describe("Minimum subscriber count (default 1000)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience("findOutlierChannels", [
      {
        name: "dataApi",
        fn: async ({
          niche,
          maxChannels,
          minSubscribers,
        }: {
          niche: string;
          maxChannels: number;
          minSubscribers: number;
        }) => {
          // Search for channels
          const searchUrl = new URL(`${YT_API}/search`);
          searchUrl.searchParams.set("part", "snippet");
          searchUrl.searchParams.set("q", niche);
          searchUrl.searchParams.set("type", "channel");
          searchUrl.searchParams.set(
            "maxResults",
            String(Math.min(maxChannels, 50)),
          );
          searchUrl.searchParams.set("order", "relevance");
          searchUrl.searchParams.set("key", apiKey);

          const searchRes = await fetch(searchUrl.toString());
          if (!searchRes.ok)
            throw new Error(`Channel search error: ${searchRes.status}`);
          const searchData = (await searchRes.json()) as {
            items?: Array<{
              snippet?: { channelId?: string; title?: string };
            }>;
          };

          const channelIds = (searchData.items ?? [])
            .map((i) => i.snippet?.channelId)
            .filter((id): id is string => !!id);

          if (channelIds.length === 0)
            return { niche, channels: [], message: "No channels found" };

          // Get stats (batch up to 50)
          const statsUrl = new URL(`${YT_API}/channels`);
          statsUrl.searchParams.set("part", "statistics,snippet");
          statsUrl.searchParams.set("id", channelIds.join(","));
          statsUrl.searchParams.set("key", apiKey);

          const statsRes = await fetch(statsUrl.toString());
          if (!statsRes.ok)
            throw new Error(`Channel stats error: ${statsRes.status}`);
          const statsData = (await statsRes.json()) as {
            items?: Array<{
              id: string;
              snippet?: { title?: string };
              statistics?: {
                subscriberCount?: string;
                viewCount?: string;
                videoCount?: string;
              };
            }>;
          };

          // Calculate engagement ratios
          const channels = (statsData.items ?? [])
            .map((ch) => {
              const subs = Number(ch.statistics?.subscriberCount ?? 0);
              const views = Number(ch.statistics?.viewCount ?? 0);
              const videos = Number(ch.statistics?.videoCount ?? 0);
              const avgViewsPerVideo =
                videos > 0 ? Math.round(views / videos) : 0;
              const engagementRatio =
                subs > 0 ? +(views / subs).toFixed(2) : 0;
              return {
                channelId: ch.id,
                channelName: ch.snippet?.title ?? "",
                subscribers: subs,
                totalViews: views,
                videoCount: videos,
                avgViewsPerVideo,
                engagementRatio,
              };
            })
            .filter((ch) => ch.subscribers >= minSubscribers)
            .sort((a, b) => b.engagementRatio - a.engagementRatio);

          // Outlier scoring
          const ratios = channels
            .map((c) => c.engagementRatio)
            .sort((a, b) => a - b);
          const median =
            ratios.length > 0
              ? ratios[Math.floor(ratios.length / 2)]
              : 1;

          const scored = channels.map((ch) => ({
            ...ch,
            outlierScore:
              median > 0
                ? +(ch.engagementRatio / median).toFixed(2)
                : 0,
          }));

          // Check CSV for previously seen channels
          let previousIds = new Set<string>();
          try {
            const csv = readFileSync(CSV_PATH, "utf-8");
            for (const line of csv.split("\n")) {
              if (
                line.includes(`,${niche},`) ||
                line.includes(`,"${niche}",`)
              ) {
                const cols = line.split(",");
                if (cols[2]) previousIds.add(cols[2]);
              }
            }
          } catch {
            // No CSV yet
          }

          const results = scored.map((ch) => ({
            ...ch,
            isNew: !previousIds.has(ch.channelId),
          }));

          // Append to CSV
          try {
            mkdirSync(DATA_DIR, { recursive: true });
            try {
              readFileSync(CSV_PATH);
            } catch {
              writeFileSync(
                CSV_PATH,
                "timestamp,niche,channelId,channelName,subscribers," +
                  "totalViews,videoCount,avgViewsPerVideo," +
                  "engagementRatio,outlierScore,isNew\n",
              );
            }
            const now = new Date().toISOString();
            for (const ch of results) {
              const escapedNiche = `"${niche.replace(/"/g, '""')}"`;
              const escapedName = `"${ch.channelName.replace(/"/g, '""')}"`;
              const line = [
                now,
                escapedNiche,
                ch.channelId,
                escapedName,
                ch.subscribers,
                ch.totalViews,
                ch.videoCount,
                ch.avgViewsPerVideo,
                ch.engagementRatio,
                ch.outlierScore,
                ch.isNew,
              ].join(",");
              appendFileSync(CSV_PATH, line + "\n");
            }
          } catch (err) {
            console.error("[findOutlierChannels] CSV write error:", err);
          }

          return {
            niche,
            medianEngagementRatio: median,
            channelCount: results.length,
            newChannels: results.filter((c) => c.isNew).length,
            channels: results,
          };
        },
      },
    ]),
  );
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/discovery-tools.ts
git commit -m "feat: add getAutocompleteSuggestions (3-tier fallback) and findOutlierChannels (CSV tracking)"
```

---

### Task 6: Wire everything into index.ts

**Files:**
- Modify: `src/index.ts:11-12,59-61`

**Step 1: Add imports after line 11**

```typescript
import { registerAnalyticsTools } from "./analytics-tools.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
```

**Step 2: Register new tools after line 60 (`registerWriteTools(server);`)**

```typescript
      registerAnalyticsTools(server);
      registerDiscoveryTools(server);
```

**Step 3: Full build**

Run: `cd /Users/urbs/Documents/Apps/mcp-servers/youtube-mcp-remote && npm run build`
Expected: Clean compile, `dist/` contains all new files

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire analytics and discovery tools into MCP server"
```

---

### Task 7: Update Dockerfile for /data volume

**Files:**
- Modify: `Dockerfile`

**Step 1: Add DATA_DIR env and volume**

After line 16 (`ENV PORT=3000`), add:
```dockerfile
ENV DATA_DIR=/data
VOLUME /data
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add /data volume for persistent CSV and health state"
```

---

### Task 8: Create n8n webhook workflow for tool alerts

**Files:** None (n8n API calls)

**Step 1: Create workflow using n8n-mcp**

Create a workflow named "YouTube MCP Tool Alert" with:
- **Node 1:** Webhook (typeVersion 1.1, method POST, path `youtube-mcp-tool-alert`)
  - Set `webhookId` as TOP-LEVEL node property (not in parameters — per n8n gotcha)
- **Node 2:** Slack message to `#workflow-logs` (channel ID `C0AGHT1NL91`)
  - Credential: `Y05hVvTEmh6ZsKYb`
  - typeVersion 2.4, select "channel", channelId with `__rl` format
  - Message format (preserve newlines):
    ```
    :warning: YouTube MCP Tool Alert
    Tool: {{ $json.tool }}
    Error: {{ $json.error }}
    Failures: {{ $json.failureCount }}
    Timestamp: {{ $json.timestamp }}
    ```

Settings: `{"executionOrder": "v1", "timezone": "America/Chicago", "saveDataErrorExecution": "all", "saveDataSuccessExecution": "all"}`

**Step 2: Activate the workflow**

`POST /api/v1/workflows/{id}/activate`

**Step 3: Test webhook**

```bash
curl -X POST https://auto.outliyr.com/webhook/youtube-mcp-tool-alert \
  -H "Content-Type: application/json" \
  -d '{"tool":"test","error":"manual test","failureCount":1,"timestamp":"2026-02-25T00:00:00Z","serverUrl":"test"}'
```

Expected: Slack message in `#workflow-logs`

---

### Task 9: Configure Coolify (env var + volume mount)

**Step 1: Add env var in Coolify**

`N8N_ALERT_WEBHOOK_URL=https://auto.outliyr.com/webhook/youtube-mcp-tool-alert`

**Step 2: Create host directory on ops server**

SSH to ops server and create: `mkdir -p /opt/youtube-mcp-data`

**Step 3: Configure bind mount in Coolify**

Host: `/opt/youtube-mcp-data` → Container: `/data`

**Step 4: Push to main, deploy, verify**

```bash
git push origin main
# Wait for Coolify auto-deploy
curl https://youtube-mcp.auto.outliyr.com/health
```

Expected: `{"status":"ok"}`

---

### Task 10: End-to-end verification

**Step 1: Test each new tool**

1. `getDemographics` — startDate 90 days ago, endDate today
2. `getGeography` — same range
3. `getTrafficSources` — same range
4. `getRetentionCurve` — a known video ID
5. `getDayOfWeekAnalysis` — 90 day range
6. `getContentTypeBreakdown` — 90 day range
7. `getAutocompleteSuggestions` — query "biohacking"
8. `findOutlierChannels` — niche "biohacking", maxChannels 10

**Step 2: Verify persistence**

- Check `/data/tool-health.json` exists on ops server
- Check `/data/outlier-channels.csv` has rows

**Step 3: Verify token optimization**

Compare `getVideoAnalytics` response size before/after — should be smaller.

**Step 4: Verify n8n alerting**

Trigger a manual failure (or temporarily point suggestEndpoint at a broken URL) and confirm Slack notification arrives.

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/resilience.ts` | CREATE | Failure tracking, n8n alerts, auto-disable wrapper |
| `src/trim.ts` | CREATE | Token optimization — strips YouTube API noise |
| `src/analytics-tools.ts` | CREATE | 6 analytics tools (demographics, geography, traffic, retention, day-of-week, content type) |
| `src/discovery-tools.ts` | CREATE | getAutocompleteSuggestions (3 fallbacks) + findOutlierChannels (CSV) |
| `src/write-tools.ts` | MODIFY | Export ytFetch/constants, apply trimResponse |
| `src/index.ts` | MODIFY | Import and register new tool modules |
| `Dockerfile` | MODIFY | Add /data volume + DATA_DIR env |
| n8n workflow | CREATE | Webhook alert to Slack #workflow-logs |
| Coolify config | MODIFY | Add N8N_ALERT_WEBHOOK_URL env + /data bind mount |
