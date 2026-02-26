import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ytFetch, YT_ANALYTICS_API } from "./write-tools.js";
import { withResilience } from "./resilience.js";
import { trimResponse } from "./trim.js";

export function registerAnalyticsTools(server: McpServer): void {
  // ─── getDemographics ────────────────────────────────────────────────────────
  server.registerTool(
    "getDemographics",
    {
      description:
        "Get viewer demographics (age group and gender breakdown) for a channel or specific video. " +
        "Returns viewerPercentage grouped by ageGroup and gender.",
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by specific video ID (omit for channel-wide)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{ startDate: string; endDate: string; videoId?: string }>(
      "getDemographics",
      [
        {
          name: "analyticsApi",
          fn: async (args) => {
            const url = new URL(`${YT_ANALYTICS_API}/reports`);
            url.searchParams.set("ids", "channel==MINE");
            url.searchParams.set("dimensions", "ageGroup,gender");
            url.searchParams.set("metrics", "viewerPercentage");
            url.searchParams.set("startDate", args.startDate);
            url.searchParams.set("endDate", args.endDate);
            if (args.videoId)
              url.searchParams.set("filters", `video==${args.videoId}`);
            return trimResponse(await ytFetch(url.toString()));
          },
        },
      ],
    ),
  );

  // ─── getGeography ───────────────────────────────────────────────────────────
  server.registerTool(
    "getGeography",
    {
      description:
        "Get geographic breakdown of viewers by country. " +
        "Returns views, watch time, and subscribers gained sorted by views descending.",
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by specific video ID (omit for channel-wide)"),
        maxResults: z
          .number()
          .min(1)
          .max(250)
          .default(25)
          .describe("Max countries to return (default 25)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{
      startDate: string;
      endDate: string;
      videoId?: string;
      maxResults: number;
    }>("getGeography", [
      {
        name: "analyticsApi",
        fn: async (args) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set("dimensions", "country");
          url.searchParams.set(
            "metrics",
            "views,estimatedMinutesWatched,subscribersGained",
          );
          url.searchParams.set("sort", "-views");
          url.searchParams.set("startDate", args.startDate);
          url.searchParams.set("endDate", args.endDate);
          url.searchParams.set("maxResults", String(args.maxResults));
          if (args.videoId)
            url.searchParams.set("filters", `video==${args.videoId}`);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getTrafficSources ──────────────────────────────────────────────────────
  server.registerTool(
    "getTrafficSources",
    {
      description:
        "Get traffic source breakdown showing where viewers found your content. " +
        "Returns views and watch time by traffic source type (search, suggested, browse, etc.).",
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
        videoId: z
          .string()
          .optional()
          .describe("Filter by specific video ID (omit for channel-wide)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{ startDate: string; endDate: string; videoId?: string }>(
      "getTrafficSources",
      [
        {
          name: "analyticsApi",
          fn: async (args) => {
            const url = new URL(`${YT_ANALYTICS_API}/reports`);
            url.searchParams.set("ids", "channel==MINE");
            url.searchParams.set("dimensions", "insightTrafficSourceType");
            url.searchParams.set(
              "metrics",
              "views,estimatedMinutesWatched",
            );
            url.searchParams.set("sort", "-views");
            url.searchParams.set("startDate", args.startDate);
            url.searchParams.set("endDate", args.endDate);
            if (args.videoId)
              url.searchParams.set("filters", `video==${args.videoId}`);
            return trimResponse(await ytFetch(url.toString()));
          },
        },
      ],
    ),
  );

  // ─── getRetentionCurve ──────────────────────────────────────────────────────
  server.registerTool(
    "getRetentionCurve",
    {
      description:
        "Get audience retention curve for a specific video. " +
        "Returns audienceWatchRatio and relativeRetentionPerformance at each " +
        "point in the video timeline (elapsedVideoTimeRatio 0.0–1.0). " +
        "Uses a wide date range to capture all-time data.",
      inputSchema: {
        videoId: z
          .string()
          .min(1)
          .describe("YouTube video ID (required)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{ videoId: string }>("getRetentionCurve", [
      {
        name: "analyticsApi",
        fn: async (args) => {
          const url = new URL(`${YT_ANALYTICS_API}/reports`);
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
          url.searchParams.set(
            "metrics",
            "audienceWatchRatio,relativeRetentionPerformance",
          );
          url.searchParams.set("startDate", "2020-01-01");
          url.searchParams.set(
            "endDate",
            new Date().toISOString().slice(0, 10),
          );
          url.searchParams.set("filters", `video==${args.videoId}`);
          return trimResponse(await ytFetch(url.toString()));
        },
      },
    ]),
  );

  // ─── getDayOfWeekAnalysis ───────────────────────────────────────────────────
  server.registerTool(
    "getDayOfWeekAnalysis",
    {
      description:
        "Analyze channel performance by day of week. Fetches daily metrics then " +
        "aggregates client-side into 7-day averages. Helps identify optimal publishing days. " +
        "Returns an array of 7 objects with day name, sample count, and average metrics.",
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{ startDate: string; endDate: string }>(
      "getDayOfWeekAnalysis",
      [
        {
          name: "analyticsApi",
          fn: async (args) => {
            const url = new URL(`${YT_ANALYTICS_API}/reports`);
            url.searchParams.set("ids", "channel==MINE");
            url.searchParams.set("dimensions", "day");
            url.searchParams.set(
              "metrics",
              "views,estimatedMinutesWatched,subscribersGained,likes,shares",
            );
            url.searchParams.set("startDate", args.startDate);
            url.searchParams.set("endDate", args.endDate);

            const raw = (await ytFetch(url.toString())) as {
              rows?: Array<[string, number, number, number, number, number]>;
            };

            const DAY_NAMES = [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ];

            // Accumulate totals per day of week (0=Sunday..6=Saturday)
            const buckets = Array.from({ length: 7 }, () => ({
              count: 0,
              views: 0,
              watchTime: 0,
              subs: 0,
              likes: 0,
              shares: 0,
            }));

            for (const row of raw.rows ?? []) {
              const [dateStr, views, watchTime, subs, likes, shares] = row;
              const dayIndex = new Date(dateStr + "T00:00:00Z").getUTCDay();
              const b = buckets[dayIndex];
              b.count += 1;
              b.views += views;
              b.watchTime += watchTime;
              b.subs += subs;
              b.likes += likes;
              b.shares += shares;
            }

            return buckets.map((b, i) => ({
              day: DAY_NAMES[i],
              daysInRange: b.count,
              avgViews: b.count ? Math.round(b.views / b.count) : 0,
              avgWatchTimeMinutes: b.count
                ? Math.round((b.watchTime / b.count) * 100) / 100
                : 0,
              avgSubscribersGained: b.count
                ? Math.round((b.subs / b.count) * 100) / 100
                : 0,
              avgLikes: b.count
                ? Math.round((b.likes / b.count) * 100) / 100
                : 0,
              avgShares: b.count
                ? Math.round((b.shares / b.count) * 100) / 100
                : 0,
            }));
          },
        },
      ],
    ),
  );

  // ─── getContentTypeBreakdown ────────────────────────────────────────────────
  server.registerTool(
    "getContentTypeBreakdown",
    {
      description:
        "Get performance breakdown by content type (videos, shorts, live streams, etc.). " +
        "Returns views, watch time, subscribers gained, and likes for each creator content type.",
      inputSchema: {
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withResilience<{ startDate: string; endDate: string }>(
      "getContentTypeBreakdown",
      [
        {
          name: "analyticsApi",
          fn: async (args) => {
            const url = new URL(`${YT_ANALYTICS_API}/reports`);
            url.searchParams.set("ids", "channel==MINE");
            url.searchParams.set("dimensions", "creatorContentType");
            url.searchParams.set(
              "metrics",
              "views,estimatedMinutesWatched,subscribersGained,likes",
            );
            url.searchParams.set("startDate", args.startDate);
            url.searchParams.set("endDate", args.endDate);
            return trimResponse(await ytFetch(url.toString()));
          },
        },
      ],
    ),
  );
}
