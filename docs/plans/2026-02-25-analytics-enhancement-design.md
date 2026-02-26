# YouTube MCP Server Enhancement — Analytics & Resilience

**Date:** 2026-02-25
**Status:** Approved

## Overview

Add 8 new tools to the youtube-mcp-remote server: 7 analytics/discovery tools and 1 SEO tool. Add a universal resilience layer (self-annealing + n8n alerts) and token optimization across all responses.

## New Tools

| Tool | API | Quota Cost | Auth |
|------|-----|-----------|------|
| `getDemographics` | Analytics v2 (`ageGroup,gender` dimension) | 0 | OAuth |
| `getGeography` | Analytics v2 (`country` dimension) | 0 | OAuth |
| `getTrafficSources` | Analytics v2 (`insightTrafficSourceType` dimension) | 0 | OAuth |
| `getRetentionCurve` | Analytics v2 (`audienceWatchRatio`, `relativeRetentionPerformance`) | 0 | OAuth |
| `getDayOfWeekAnalysis` | Analytics v2 (`day` dimension, aggregated client-side) | 0 | OAuth |
| `getContentTypeBreakdown` | Analytics v2 (`creatorContentType` dimension) | 0 | OAuth |
| `getAutocompleteSuggestions` | Undocumented endpoint → Data API → web scrape | 0 → 100 → 0 | None → API key → None |
| `findOutlierChannels` | Data API (`search.list` + `channels.list`) | ~200-400 | API key |

## Autocomplete Fallback Chain

1. **Undocumented suggest endpoint** (`suggestqueries.google.com/complete/search?client=youtube&q=...`) — free, 0 quota
2. **Official YouTube Data API `search.list`** — 100 quota per call, reliable
3. If 1+2 fail → **notify n8n webhook**, then fall back to **web search `site:youtube.com {query}`** extracting title patterns
4. If all three fail → **self-disable** tool, log, notify n8n again

## Resilience Layer (All Tools)

```
Every tool call
  → try primary
  → on failure: increment failure counter in /data/tool-health.json
  → if counter < 3: return error normally
  → if counter = 3: POST to n8n webhook, mark tool as degraded
  → if degraded + has fallback: try fallback chain
  → if degraded + no fallback: return "tool disabled" message
  → on success: reset counter to 0
```

`/data/tool-health.json` — bind-mounted from ops server host. Tracks per-tool failure count, last failure timestamp, degraded status.

## Token Optimization

`trimResponse()` utility applied to all tool responses (existing + new):
- Strip: `etag`, `kind`, `pageInfo`, nested `thumbnails` variants, `localized` duplicates
- Flatten nested structures where possible

## findOutlierChannels — CSV Persistence

- Path: `/data/outlier-channels.csv` (bind-mounted from ops server host)
- Columns: `timestamp, niche, channelId, channelName, subscribers, totalViews, videoCount, avgViewsPerVideo, engagementRatio, outlierScore, isNew`
- `isNew` = true if channelId not in previous scans for that niche

## n8n Webhook

- New workflow on n8n instance
- Trigger: Webhook (POST)
- Payload: `{ tool, error, failureCount, timestamp, serverUrl }`
- Action: Send notification
- URL stored as `N8N_ALERT_WEBHOOK_URL` env var in Coolify

## Infrastructure Changes

- Coolify: Add persistent volume bind mount (host path TBD → container `/data/`)
- Env var: Add `N8N_ALERT_WEBHOOK_URL`
- No new npm dependencies — all tools use native `fetch`
- No OAuth scope changes — existing scopes cover everything
