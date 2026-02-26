# YouTube Content Planner Skill — Design

**Date:** 2026-02-26
**Status:** Approved

## Overview

Claude Code skill that combines own channel analytics, competitor analysis, and trend discovery to recommend ranked video ideas with the best chances of succeeding. Uses the YouTube MCP server's 24 tools. Outputs to chat + persistent file + slush browser view.

## Skill Structure

```
~/.claude/skills/youtube-content-planner/
  SKILL.md                        # Main orchestration (SOPs)
  config/
    watchlist.json                 # Competitor channel IDs
    scoring.json                   # Ranking weights (overridable inline)
    pillars.json                   # Content pillars + target mix
  data/
    content-plan.json              # Persistent plan state across runs
```

**Triggers:** "plan my next videos", "youtube content ideas", "update content calendar", "what should I film next"

**Arguments:** Optional niche/topic, count (default 10), weight overrides (e.g., "ignore monetization")

## SOPs

### SOP-1: Full Research Run

**Trigger:** "plan my next videos", "youtube content ideas", "what should I film next"

**Step 1 — Gather own channel data** (parallel MCP calls):
- `getDayOfWeekAnalysis` — best posting days
- `getTrafficSources` — where views come from
- `getContentTypeBreakdown` — shorts vs long-form performance
- `getDemographics` + `getGeography` — audience profile
- `getChannelTopVideos` — what's already working + pillar categorization

**Step 2 — Analyze competitors** (sequential):
- Load `config/watchlist.json` (if empty, trigger SOP-3 first)
- For each watchlist channel: `getChannelTopVideos` + `getChannelStatistics`
- Then `findOutlierChannels` for the specified niche — discover emerging channels
- Extract: performing topics, underserved angles

**Step 3 — Discover trending opportunities** (parallel):
- `getAutocompleteSuggestions` for 3-5 seed queries from the niche
- `getTrendingVideos` for general pulse
- `searchVideos` for the niche to check current supply volume

**Step 4 — Score & rank:**
- Apply `config/scoring.json` weights (with any inline overrides)
- Tag each idea with its content pillar
- Pillar balance acts as tiebreaker: when two ideas score within 5 points, the one in an underrepresented pillar wins

**Step 5 — Output:**
- Chat: summary header + top 3 idea cards
- File: full results to `data/content-plan.json`
- Slush: rendered markdown with all ideas to `/tmp/slush/`

### SOP-2: Calendar Update

**Trigger:** "update content calendar", "refresh my content plan"

1. Load existing `data/content-plan.json`
2. Run lighter SOP-1 (skip own channel analytics, refresh competitor + trending only)
3. Detect published ideas by checking recent uploads via `getChannelTopVideos`
4. Re-score remaining + new ideas, merge into plan
5. Output updated plan

### SOP-3: Pillar Discovery

**Trigger:** First run with empty `config/pillars.json`, or "rediscover my content pillars"

1. `getChannelTopVideos` — pull last 50 videos
2. Claude categorizes each into clusters based on title + description patterns
3. Propose 4-6 pillars with current distribution percentages
4. Ask user to approve/edit pillar names and target mix
5. Save to `config/pillars.json`

## Scoring System

Default `config/scoring.json`:

```json
{
  "weights": {
    "competitionGap": 0.35,
    "searchSignal": 0.25,
    "engagementPotential": 0.20,
    "monetizationFit": 0.15,
    "audienceFit": 0.05
  }
}
```

| Factor | Measurement |
|---|---|
| Competition Gap | Autocomplete demand vs `searchVideos` supply count. High demand + few quality results = high score |
| Search Signal | Autocomplete variation count + trending overlap |
| Engagement Potential | Like/comment ratios on similar competitor and outlier channel videos |
| Monetization Fit | Topic alignment with known affiliate niches. Cross-reference with `affiliate-db-skill` if available |
| Audience Fit | Topic skew toward channel's audience (males 25-44, US/UK/CA) |

Each factor scored 1-10 by Claude. Final score = weighted sum normalized to 0-100.

**Inline overrides:** "ignore monetization" → `monetizationFit: 0`, weight redistributed. "prioritize monetization" → `monetizationFit: 0.30`. "only competition gap" → `competitionGap: 1.0`, rest 0.

## Output Format

### Summary Header

```
═══════════════════════════════════════════════════
  YOUTUBE CONTENT PLANNER — 2026-02-26
  Channel: High Performance Longevity (@outliyr)
  Niche: biohacking
  Ideas: 10 | New: 7 | Refreshed: 3

  📈 Your Channel (last 90d):
     Top Traffic: YT Search (40%) → Shorts (25%) → Subscribers (20%)
     Best Day: Saturday (348 avg views)
     Content Split: Long-form 70% watch time | Shorts 30% views
     Audience: 86% male, 25-44 dominant, US/UK/CA

  🎯 Pillar Balance (last 90d → target):
     Product Reviews:      42% → 30% ⚠️ over
     Protocols & How-To:   28% → 25% ✓
     Science Deep Dives:   18% → 20% ✓
     Personal Experiments:  5% → 15% ⚠️ under
     Industry & Trends:     7% → 10% ↗

  🔍 Competitor Watchlist: 5 channels scanned
  🆕 Discovery: 3 outlier channels found
  📊 Weights: Gap 35% | Search 25% | Engage 20% | Money 15% | Fit 5%
═══════════════════════════════════════════════════
```

### Idea Cards

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 #1 — "Topic Title Here"
Score: 87/100 | Pillar: Personal Experiments

Competition Gap [35%]: 9/10 — Only 2 quality videos exist, high autocomplete demand
Search Signal [25%]: 8/10 — 6 autocomplete variations, trending adjacent
Engagement [20%]: 7/10 — Similar videos avg 4.2% like ratio
Monetization [15%]: 8/10 — Direct affiliate fit (Apollo Neuro, etc.)
Audience Fit [5%]: 6/10 — Skews male 25-44

📎 Reference Videos:
  • "Video Title" by Channel (142K views, 5.1% engagement)
  • "Video Title" by Channel (89K views, 3.8% engagement)

💡 Suggested Angle: What YOUR video should do differently
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Chat shows top 3 cards. Full output goes to slush.

## Persistent State

`data/content-plan.json`:

```json
{
  "lastRun": "2026-02-26T12:00:00Z",
  "channel": "UCYD_-2jbMxu0Lp65IlcGf5w",
  "runs": [
    {
      "date": "2026-02-26",
      "niche": "biohacking",
      "weights": { "competitionGap": 0.35, "searchSignal": 0.25, "engagementPotential": 0.20, "monetizationFit": 0.15, "audienceFit": 0.05 },
      "ideas": [
        {
          "rank": 1,
          "title": "Topic Title",
          "score": 87,
          "pillar": "Personal Experiments",
          "scores": { "competitionGap": 9, "searchSignal": 8, "engagementPotential": 7, "monetizationFit": 8, "audienceFit": 6 },
          "referenceVideos": [{ "title": "...", "channel": "...", "views": 142000, "engagement": 0.051 }],
          "suggestedAngle": "...",
          "status": "new"
        }
      ]
    }
  ]
}
```

Status flow: `new` → `planned` → `filmed` → `published`

## Config Files

### `config/watchlist.json`

```json
{
  "channels": []
}
```

Empty on install. Populated on first run (skill prompts) or manually.

### `config/pillars.json`

```json
{
  "pillars": []
}
```

Empty on install. Discovered via SOP-3 on first run.

## MCP Tools Used

| Tool | SOP | Purpose |
|---|---|---|
| `getDayOfWeekAnalysis` | 1 | Best posting days |
| `getTrafficSources` | 1 | Traffic source breakdown |
| `getContentTypeBreakdown` | 1 | Shorts vs long-form |
| `getDemographics` | 1 | Age/gender breakdown |
| `getGeography` | 1 | Country breakdown |
| `getChannelTopVideos` | 1,2,3 | Own + competitor top videos |
| `getChannelStatistics` | 1 | Competitor channel stats |
| `findOutlierChannels` | 1 | Discover emerging channels |
| `getAutocompleteSuggestions` | 1 | Search demand signals |
| `getTrendingVideos` | 1 | General trending pulse |
| `searchVideos` | 1 | Supply check for niche |
