/**
 * Discovery tools — getAutocompleteSuggestions (3-tier fallback) and
 * findOutlierChannels (CSV tracking for niche research).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { YT_API } from "./write-tools.js";
import { withResilience } from "./resilience.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CSV_PATH = join(DATA_DIR, "outlier-channels.csv");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a value for CSV: wrap in quotes, double-escape internal quotes. */
function csvEscape(val: string): string {
  return `"${val.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Tool 1: getAutocompleteSuggestions
// ---------------------------------------------------------------------------

interface AutocompleteArgs {
  query: string;
  language: string;
}

/** Handler 1 — undocumented Google suggest endpoint (JSONP). */
async function suggestEndpoint(args: AutocompleteArgs): Promise<unknown> {
  const url = `https://suggestqueries.google.com/complete/search?client=youtube&q=${encodeURIComponent(args.query)}&hl=${encodeURIComponent(args.language)}&ds=yt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Suggest endpoint returned ${res.status}`);
  const text = await res.text();

  // JSONP response looks like: window.google.ac.h([...])
  // Strip everything before the first '[' and after the last ']'
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Failed to parse JSONP response");
  const jsonStr = text.substring(start, end + 1);
  const parsed = JSON.parse(jsonStr) as unknown[];

  // The inner structure is [ query, [ [suggestion, 0, ...], ... ] ]
  const suggestionsArr = parsed[1];
  if (!Array.isArray(suggestionsArr)) throw new Error("Unexpected suggest response structure");

  const suggestions: string[] = suggestionsArr.map(
    (item: unknown) => (item as unknown[])[0] as string,
  );

  if (suggestions.length === 0) throw new Error("No suggestions returned");

  return { query: args.query, source: "suggestEndpoint", suggestions };
}

/** Handler 2 — YouTube Data API search (extract video titles). */
async function dataApiSearch(args: AutocompleteArgs): Promise<unknown> {
  const apiKey = process.env.YOUTUBE_API_KEY!;
  const url = `${YT_API}/search?part=snippet&q=${encodeURIComponent(args.query)}&type=video&maxResults=15&order=relevance&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube API error (${res.status}): ${err?.error?.message ?? "unknown"}`);
  }
  const data = (await res.json()) as { items?: { snippet: { title: string } }[] };
  const titles = (data.items ?? []).map((item) => item.snippet.title);
  if (titles.length === 0) throw new Error("No results from Data API search");

  return { query: args.query, source: "dataApiSearch", suggestions: titles };
}

/** Handler 3 — scrape youtube.com search results page for ytInitialData. */
async function webScrape(args: AutocompleteArgs): Promise<unknown> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`YouTube web scrape returned ${res.status}`);
  const html = await res.text();

  // Extract ytInitialData JSON from the page
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) throw new Error("Could not find ytInitialData in page");

  const ytData = JSON.parse(match[1]) as Record<string, unknown>;

  // Navigate the nested structure to find video titles
  const titles: string[] = [];
  const jsonStr = JSON.stringify(ytData);
  const titleMatches = jsonStr.matchAll(/"title":\{"runs":\[\{"text":"([^"]+?)"\}/g);
  for (const m of titleMatches) {
    if (m[1] && !titles.includes(m[1])) {
      titles.push(m[1]);
    }
    if (titles.length >= 15) break;
  }

  if (titles.length === 0) throw new Error("No titles found in web scrape");

  return { query: args.query, source: "webScrape", suggestions: titles };
}

// ---------------------------------------------------------------------------
// Tool 2: findOutlierChannels
// ---------------------------------------------------------------------------

interface OutlierArgs {
  niche: string;
  maxChannels: number;
  minSubscribers: number;
}

interface ChannelStats {
  channelId: string;
  channelName: string;
  subscribers: number;
  totalViews: number;
  videoCount: number;
  avgViewsPerVideo: number;
  engagementRatio: number;
  outlierScore: number;
  isNew: boolean;
}

async function findOutliersHandler(args: OutlierArgs): Promise<unknown> {
  const apiKey = process.env.YOUTUBE_API_KEY!;
  const maxResults = Math.min(args.maxChannels, 50);

  // Step 1: Search for channels
  const searchUrl = `${YT_API}/search?part=snippet&q=${encodeURIComponent(args.niche)}&type=channel&maxResults=${maxResults}&order=relevance&key=${apiKey}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) {
    const err = (await searchRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube search error (${searchRes.status}): ${err?.error?.message ?? "unknown"}`);
  }
  const searchData = (await searchRes.json()) as {
    items?: { snippet: { channelId: string } }[];
  };
  const channelIds = (searchData.items ?? []).map((item) => item.snippet.channelId);
  if (channelIds.length === 0) throw new Error("No channels found for niche");

  // Step 2: Get channel statistics in a single batch
  const statsUrl = `${YT_API}/channels?part=statistics,snippet&id=${channelIds.join(",")}&key=${apiKey}`;
  const statsRes = await fetch(statsUrl);
  if (!statsRes.ok) {
    const err = (await statsRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube channels error (${statsRes.status}): ${err?.error?.message ?? "unknown"}`);
  }
  const statsData = (await statsRes.json()) as {
    items?: {
      id: string;
      snippet: { title: string };
      statistics: {
        subscriberCount: string;
        viewCount: string;
        videoCount: string;
      };
    }[];
  };

  // Step 3: Calculate per-channel metrics
  let channels: ChannelStats[] = (statsData.items ?? []).map((ch) => {
    const subscribers = parseInt(ch.statistics.subscriberCount, 10) || 0;
    const totalViews = parseInt(ch.statistics.viewCount, 10) || 0;
    const videoCount = parseInt(ch.statistics.videoCount, 10) || 0;
    const avgViewsPerVideo = videoCount > 0 ? totalViews / videoCount : 0;
    const engagementRatio = subscribers > 0 ? totalViews / subscribers : 0;
    return {
      channelId: ch.id,
      channelName: ch.snippet.title,
      subscribers,
      totalViews,
      videoCount,
      avgViewsPerVideo,
      engagementRatio,
      outlierScore: 0,
      isNew: true,
    };
  });

  // Step 4: Filter by minSubscribers, sort by engagementRatio descending
  channels = channels
    .filter((ch) => ch.subscribers >= args.minSubscribers)
    .sort((a, b) => b.engagementRatio - a.engagementRatio);

  // Step 5: Calculate median engagement ratio and outlier scores
  let medianEngagementRatio = 0;
  if (channels.length > 0) {
    const sorted = [...channels].sort((a, b) => a.engagementRatio - b.engagementRatio);
    const mid = Math.floor(sorted.length / 2);
    medianEngagementRatio =
      sorted.length % 2 === 0
        ? (sorted[mid - 1].engagementRatio + sorted[mid].engagementRatio) / 2
        : sorted[mid].engagementRatio;

    for (const ch of channels) {
      ch.outlierScore = medianEngagementRatio > 0 ? ch.engagementRatio / medianEngagementRatio : 0;
    }
  }

  // Step 6: Read existing CSV to find previously seen channelIds for this niche
  const previousIds = new Set<string>();
  try {
    const csv = readFileSync(CSV_PATH, "utf-8");
    const lines = csv.split("\n").slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      // CSV columns: timestamp,niche,channelId,...
      const cols = parseCSVLine(line);
      if (cols.length >= 3 && cols[1] === args.niche) {
        previousIds.add(cols[2]);
      }
    }
  } catch {
    // File doesn't exist yet — all channels are new
  }

  for (const ch of channels) {
    ch.isNew = !previousIds.has(ch.channelId);
  }

  // Step 7: Append results to CSV
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const header = "timestamp,niche,channelId,channelName,subscribers,totalViews,videoCount,avgViewsPerVideo,engagementRatio,outlierScore,isNew";
  if (!existsSync(CSV_PATH)) {
    writeFileSync(CSV_PATH, header + "\n", "utf-8");
  }

  const timestamp = new Date().toISOString();
  const csvLines = channels.map(
    (ch) =>
      `${timestamp},${csvEscape(args.niche)},${ch.channelId},${csvEscape(ch.channelName)},${ch.subscribers},${ch.totalViews},${ch.videoCount},${Math.round(ch.avgViewsPerVideo)},${ch.engagementRatio.toFixed(2)},${ch.outlierScore.toFixed(2)},${ch.isNew}`,
  );
  if (csvLines.length > 0) {
    appendFileSync(CSV_PATH, csvLines.join("\n") + "\n", "utf-8");
  }

  // Step 8: Return results
  const newChannels = channels.filter((ch) => ch.isNew).length;

  return {
    niche: args.niche,
    medianEngagementRatio: Math.round(medianEngagementRatio * 100) / 100,
    channelCount: channels.length,
    newChannels,
    channels,
  };
}

/** Simple CSV line parser that handles quoted fields with escaped quotes. */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDiscoveryTools(server: McpServer): void {
  // ─── getAutocompleteSuggestions ──────────────────────────────────────────────
  const autocompleteFn = withResilience<AutocompleteArgs>(
    "getAutocompleteSuggestions",
    [
      { name: "suggestEndpoint", fn: suggestEndpoint },
      { name: "dataApiSearch", fn: dataApiSearch },
      { name: "webScrape", fn: webScrape },
    ],
  );

  server.registerTool(
    "getAutocompleteSuggestions",
    {
      description:
        "Get YouTube autocomplete suggestions for a query. Uses a 3-tier fallback: " +
        "Google suggest endpoint -> YouTube Data API search -> web scrape. " +
        "Great for keyword research and content ideation.",
      inputSchema: {
        query: z.string().min(1).describe("Search query to get suggestions for"),
        language: z.string().default("en").describe("Language code (default: en)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, language }) => {
      return autocompleteFn({ query, language });
    },
  );

  // ─── findOutlierChannels ────────────────────────────────────────────────────
  const outlierFn = withResilience<OutlierArgs>("findOutlierChannels", [
    { name: "findOutliers", fn: findOutliersHandler },
  ]);

  server.registerTool(
    "findOutlierChannels",
    {
      description:
        "Find outlier YouTube channels in a niche — channels with unusually high engagement " +
        "relative to subscriber count. Results are tracked in a CSV for longitudinal analysis. " +
        "Channels seen before for the same niche are marked isNew=false.",
      inputSchema: {
        niche: z.string().min(1).describe("Niche or topic to search for channels"),
        maxChannels: z
          .number()
          .default(20)
          .describe("Maximum channels to analyze (capped at 50)"),
        minSubscribers: z
          .number()
          .default(1000)
          .describe("Minimum subscriber count to include (default: 1000)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ niche, maxChannels, minSubscribers }) => {
      return outlierFn({ niche, maxChannels, minSubscribers });
    },
  );
}
