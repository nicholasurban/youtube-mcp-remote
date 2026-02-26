# YouTube MCP Remote

Remote [Model Context Protocol](https://modelcontextprotocol.io/) server for YouTube — 25 tools spanning read, write, analytics, and discovery. Extends [@kirbah/mcp-youtube](https://github.com/kirbah/mcp-youtube) with custom modules for channel management, YouTube Analytics API, and content research.

**Endpoint:** `https://youtube-mcp.auto.outliyr.com/mcp`
**Transport:** Streamable HTTP (MCP SDK)
**Auth:** Static Bearer token (Claude Code) or OAuth 2.1 with PKCE (Claude.ai / iOS)

## Tools (25)

### Read (9) — from @kirbah/mcp-youtube

| Tool | Description |
|------|-------------|
| `searchVideos` | Search YouTube videos by query with filters |
| `getVideoDetails` | Get video metadata (title, description, stats) |
| `getVideoComments` | Fetch comments on a specific video |
| `getTranscripts` | Get video transcripts/captions |
| `getChannelStatistics` | Channel-level stats (subs, views, video count) |
| `getChannelTopVideos` | Top-performing videos for a channel |
| `getTrendingVideos` | Currently trending videos by region/category |
| `getVideoCategories` | List YouTube video categories |
| `findConsistentOutlierChannels` | Find channels with outsized engagement |

### Write (8) — custom

| Tool | Description |
|------|-------------|
| `getChannelComments` | All recent comments across a channel (uses `allThreadsRelatedToChannelId`) |
| `replyToComment` | Post a reply as channel owner |
| `updateComment` | Edit your own comment/reply |
| `deleteComment` | Delete your own comment/reply |
| `moderateComment` | Set moderation status (publish/reject/hold) + optional author ban |
| `markAsSpam` | Flag a comment as spam |
| `updateVideoMetadata` | Update title, description, tags, category |
| `getVideoAnalytics` | YouTube Analytics API — views, watch time, subs, likes by dimension |

### Analytics (6) — custom, YouTube Analytics API v2

All analytics tools query `channel==MINE` (bound to the OAuth token's channel).

| Tool | Description |
|------|-------------|
| `getDemographics` | Viewer age/gender breakdown |
| `getGeography` | Views, watch time, subs by country |
| `getTrafficSources` | Where viewers found your content (search, suggested, browse, etc.) |
| `getRetentionCurve` | Audience retention at each point in a video's timeline |
| `getDayOfWeekAnalysis` | Performance aggregated by day of week (optimal publish days) |
| `getContentTypeBreakdown` | Performance by content type (videos, shorts, live) |

### Discovery (2) — custom

| Tool | Description |
|------|-------------|
| `getAutocompleteSuggestions` | YouTube autocomplete with 3-tier fallback (Google suggest → Data API search → web scrape) |
| `findOutlierChannels` | Find high-engagement channels in a niche with CSV tracking |

## Architecture

```
Express app
  ├─ POST /mcp          ← MCP endpoint (auth-gated)
  ├─ GET  /health       ← health check
  └─ OAuth 2.1 routes   ← /authorize, /token, /register (for Claude.ai)

Per-request:
  createMcpServer(@kirbah/mcp-youtube)   ← 9 upstream read tools
    + registerWriteTools()                ← 8 write + analytics tools
    + registerAnalyticsTools()            ← 6 analytics tools
    + registerDiscoveryTools()            ← 2 discovery tools
    → StreamableHTTPServerTransport
```

### Resilience layer

All custom tools are wrapped with `withResilience()`:

- **Fallback chains** — handlers tried in order (e.g. autocomplete: suggest endpoint → API search → web scrape)
- **Failure tracking** — 3 consecutive failures = handler marked degraded, skipped for future calls
- **n8n alerting** — webhook POST on degradation (Slack notification via n8n workflow)
- **Self-healing** — degraded handlers can be reset; state persists to `/data/tool-health.json`
- **Graceful degradation** — if all handlers for a tool are degraded, returns `[DISABLED]` instead of crashing

### Token optimization

All responses pass through `trimResponse()` which strips: `etag`, `kind`, `pageInfo`, `nextPageToken`, `localized`, `regionRestriction`, `contentRating`, excess thumbnail sizes (keeps only `medium`). Reduces typical response size by 40-60%.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Static Bearer token for Claude Code auth |
| `YOUTUBE_API_KEY` | Yes | YouTube Data API v3 key |
| `MCP_OAUTH_CLIENT_ID` | Yes | OAuth client ID (for Claude.ai/iOS) |
| `MCP_OAUTH_CLIENT_SECRET` | Yes | OAuth client secret |
| `PUBLIC_URL` | Yes | Public URL of the server (e.g. `https://youtube-mcp.auto.outliyr.com`) |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID (for YouTube API access) |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Google OAuth refresh token (determines which channel analytics query) |
| `N8N_ALERT_WEBHOOK_URL` | No | n8n webhook URL for resilience alerts |
| `DATA_DIR` | No | Persistent data directory (default: `/data`) |
| `PORT` | No | Server port (default: `3000`) |

## Development

```bash
npm install
npm run dev     # tsx watch mode
npm run build   # TypeScript compile
npm start       # production
```

## Deployment

Deployed via Coolify (Docker) to the ops server. Coolify watches the `main` branch of `nicholasurban/youtube-mcp-remote` and auto-builds on push.

```bash
# Register in Claude Code
claude mcp add -t http -s user \
  -H "Authorization: Bearer <token>" \
  -- youtube-remote "https://youtube-mcp.auto.outliyr.com/mcp"
```

Persistent data (tool health state, outlier channel CSV) stored in Docker volume mounted at `/data`.
