import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getYouTubeAccessToken } from "./youtube-token.js";

const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2";

/** Call the YouTube API with an OAuth Bearer token. Returns parsed JSON or throws. */
async function ytFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getYouTubeAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  // 204 No Content (delete, moderate, markAsSpam)
  if (res.status === 204) return { success: true };
  const body = await res.json();
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } })?.error?.message ??
      JSON.stringify(body);
    throw new Error(`YouTube API error (${res.status}): ${msg}`);
  }
  return body;
}

export function registerWriteTools(server: McpServer): void {
  const apiKey = process.env.YOUTUBE_API_KEY!;

  // ─── getChannelComments ─────────────────────────────────────────────────────
  // Read-only but uses allThreadsRelatedToChannelId — not available on upstream tool
  server.registerTool(
    "getChannelComments",
    {
      description:
        "Fetch recent comments across ALL videos on a YouTube channel. " +
        "Uses allThreadsRelatedToChannelId to scan the full channel history, not just recent uploads. " +
        "Returns newest comments first. Use this for channel-wide comment review workflows.",
      inputSchema: {
        channelId: z
          .string()
          .min(1)
          .describe(
            "YouTube channel ID, e.g. UCt2RCBuOT5lEutDk7l9LZRw"
          ),
        maxResults: z
          .number()
          .min(1)
          .max(100)
          .default(100)
          .describe("Max comments to return (1–100, default: 100)"),
        order: z
          .enum(["time", "relevance"])
          .default("time")
          .describe("Sort: 'time' (newest first) or 'relevance'"),
        commentDetail: z
          .enum(["SNIPPET", "FULL"])
          .default("FULL")
          .describe("'SNIPPET' truncates at 200 chars; 'FULL' returns complete text"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ channelId, maxResults, order, commentDetail }) => {
      const url = new URL(`${YT_API}/commentThreads`);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("allThreadsRelatedToChannelId", channelId);
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set("order", order);
      url.searchParams.set("key", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(
          `YouTube API error (${res.status}): ${err?.error?.message ?? "unknown"}`
        );
      }

      const data = (await res.json()) as { items?: Record<string, unknown>[] };
      const comments = (data.items ?? []).map((thread) => {
        const s = (thread.snippet as Record<string, unknown>)
          ?.topLevelComment as Record<string, unknown> | undefined;
        const snippet = s?.snippet as Record<string, unknown> | undefined;
        return {
          commentId: thread.id ?? "",
          videoId: (thread.snippet as Record<string, unknown>)?.videoId ?? "",
          author: snippet?.authorDisplayName ?? "",
          authorChannelId:
            (snippet?.authorChannelId as Record<string, unknown>)?.value ?? "",
          text:
            commentDetail === "SNIPPET"
              ? String(snippet?.textDisplay ?? "").substring(0, 200)
              : (snippet?.textDisplay ?? ""),
          publishedAt: snippet?.publishedAt ?? "",
          likeCount: snippet?.likeCount ?? 0,
          replyCount:
            (thread.snippet as Record<string, unknown>)?.totalReplyCount ?? 0,
        };
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(comments, null, 2) },
        ],
      };
    }
  );

  // ─── deleteComment ──────────────────────────────────────────────────────────
  server.registerTool(
    "deleteComment",
    {
      description:
        "Permanently delete a YouTube comment (top-level or reply) on your channel. " +
        "This action is irreversible. Use commentId from getVideoComments or getChannelComments.",
      inputSchema: {
        commentId: z
          .string()
          .min(1)
          .describe("Comment ID to delete"),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ commentId }) => {
      const url = new URL(`${YT_API}/comments`);
      url.searchParams.set("id", commentId);
      await ytFetch(url.toString(), { method: "DELETE" });
      return {
        content: [
          { type: "text" as const, text: `Comment ${commentId} deleted.` },
        ],
      };
    }
  );

  // ─── replyToComment ─────────────────────────────────────────────────────────
  server.registerTool(
    "replyToComment",
    {
      description:
        "Post a reply to a YouTube comment as the channel owner. " +
        "parentId is the top-level commentId from getVideoComments or getChannelComments.",
      inputSchema: {
        parentId: z
          .string()
          .min(1)
          .describe("The commentId of the top-level comment to reply to"),
        text: z.string().min(1).describe("Text content of the reply"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ parentId, text }) => {
      const url = new URL(`${YT_API}/comments`);
      url.searchParams.set("part", "snippet");
      const body = await ytFetch(url.toString(), {
        method: "POST",
        body: JSON.stringify({
          snippet: { parentId, textOriginal: text },
        }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    }
  );

  // ─── moderateComment ────────────────────────────────────────────────────────
  server.registerTool(
    "moderateComment",
    {
      description:
        "Set moderation status of a YouTube comment. " +
        "'heldForReview' queues it for manual review, 'published' approves it, " +
        "'rejected' hides it. Optionally ban the author from commenting on all your videos.",
      inputSchema: {
        commentId: z.string().min(1).describe("Comment ID to moderate"),
        status: z
          .enum(["heldForReview", "published", "rejected"])
          .describe("Target moderation status"),
        banAuthor: z
          .boolean()
          .default(false)
          .describe(
            "If true, prevent the author from commenting on any of your videos"
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ commentId, status, banAuthor }) => {
      const url = new URL(`${YT_API}/comments/setModerationStatus`);
      url.searchParams.set("id", commentId);
      url.searchParams.set("moderationStatus", status);
      if (banAuthor) url.searchParams.set("banAuthor", "true");
      await ytFetch(url.toString(), { method: "POST" });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Comment ${commentId} moderation set to '${status}'` +
              (banAuthor ? " (author banned)." : "."),
          },
        ],
      };
    }
  );

  // ─── updateComment ──────────────────────────────────────────────────────────
  server.registerTool(
    "updateComment",
    {
      description:
        "Edit the text of an existing comment or reply that you (the channel owner) already posted.",
      inputSchema: {
        commentId: z
          .string()
          .min(1)
          .describe("ID of the comment/reply to edit"),
        text: z.string().min(1).describe("New text content"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ commentId, text }) => {
      const url = new URL(`${YT_API}/comments`);
      url.searchParams.set("part", "snippet");
      const body = await ytFetch(url.toString(), {
        method: "PUT",
        body: JSON.stringify({
          id: commentId,
          snippet: { textOriginal: text },
        }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    }
  );

  // ─── markAsSpam ─────────────────────────────────────────────────────────────
  server.registerTool(
    "markAsSpam",
    {
      description:
        "Flag a YouTube comment as spam or abuse. Reported comments are reviewed by YouTube.",
      inputSchema: {
        commentId: z
          .string()
          .min(1)
          .describe("Comment ID to flag as spam"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ commentId }) => {
      const url = new URL(`${YT_API}/comments/markAsSpam`);
      url.searchParams.set("id", commentId);
      await ytFetch(url.toString(), { method: "POST" });
      return {
        content: [
          {
            type: "text" as const,
            text: `Comment ${commentId} flagged as spam.`,
          },
        ],
      };
    }
  );

  // ─── updateVideoMetadata ─────────────────────────────────────────────────────
  server.registerTool(
    "updateVideoMetadata",
    {
      description:
        "Update a YouTube video's title, description, tags, or category. " +
        "Only provided fields are changed — omitted fields keep their current values. " +
        "Ideal for bulk-updating descriptions to add affiliate links.",
      inputSchema: {
        videoId: z
          .string()
          .min(1)
          .describe("11-character YouTube video ID"),
        title: z
          .string()
          .optional()
          .describe("New video title (omit to keep current)"),
        description: z
          .string()
          .optional()
          .describe("New video description (omit to keep current)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("New tags array (omit to keep current)"),
        categoryId: z
          .string()
          .optional()
          .describe("YouTube category ID (omit to keep current)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ videoId, title, description, tags, categoryId }) => {
      // Fetch current snippet first — videos.update requires the full snippet
      const token = await getYouTubeAccessToken();
      const getUrl = new URL(`${YT_API}/videos`);
      getUrl.searchParams.set("part", "snippet");
      getUrl.searchParams.set("id", videoId);

      const getRes = await fetch(getUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!getRes.ok)
        throw new Error(`Failed to fetch video ${videoId}: ${getRes.status}`);

      const getData = (await getRes.json()) as {
        items?: { snippet: Record<string, unknown> }[];
      };
      const current = getData.items?.[0]?.snippet;
      if (!current) throw new Error(`Video ${videoId} not found`);

      const updatedSnippet = {
        ...current,
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(tags !== undefined && { tags }),
        ...(categoryId !== undefined && { categoryId }),
      };

      const putUrl = new URL(`${YT_API}/videos`);
      putUrl.searchParams.set("part", "snippet");
      const body = await ytFetch(putUrl.toString(), {
        method: "PUT",
        body: JSON.stringify({ id: videoId, snippet: updatedSnippet }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    }
  );

  // ─── getVideoAnalytics ───────────────────────────────────────────────────────
  server.registerTool(
    "getVideoAnalytics",
    {
      description:
        "Fetch YouTube Analytics for a specific video or channel-wide. " +
        "Returns metrics like views, watch time, subscribers gained, likes, shares. " +
        "Requires yt-analytics.readonly OAuth scope (already configured).",
      inputSchema: {
        videoId: z
          .string()
          .optional()
          .describe("Filter by specific video ID (omit for channel-wide totals)"),
        metrics: z
          .array(z.string())
          .default([
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "subscribersGained",
            "likes",
            "shares",
            "comments",
          ])
          .describe("Analytics metrics to fetch"),
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format"),
        dimensions: z
          .string()
          .default("day")
          .describe("Grouping dimension: 'day', 'month', 'video', etc."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ videoId, metrics, startDate, endDate, dimensions }) => {
      const url = new URL(`${YT_ANALYTICS_API}/reports`);
      url.searchParams.set("ids", "channel==MINE");
      url.searchParams.set("metrics", metrics.join(","));
      url.searchParams.set("startDate", startDate);
      url.searchParams.set("endDate", endDate);
      url.searchParams.set("dimensions", dimensions);
      if (videoId) url.searchParams.set("filters", `video==${videoId}`);

      const body = await ytFetch(url.toString());
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    }
  );
}
