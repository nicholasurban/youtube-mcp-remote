# YouTube Content Planner Skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code skill that recommends ranked YouTube video ideas by combining own channel analytics, competitor analysis, trend discovery, and content pillar balance.

**Architecture:** Pure SKILL.md orchestration with SOP sections. Config files for watchlist, scoring weights, and pillars. Persistent state in data/content-plan.json. No scripts — Claude follows SOPs and calls YouTube MCP tools directly.

**Tech Stack:** Claude Code skill (SKILL.md + JSON config), YouTube MCP server (24 tools), slush renderer

---

### Task 1: Create skill directory and config files

**Files:**
- Create: `~/.claude/skills/youtube-content-planner/config/watchlist.json`
- Create: `~/.claude/skills/youtube-content-planner/config/scoring.json`
- Create: `~/.claude/skills/youtube-content-planner/config/pillars.json`
- Create: `~/.claude/skills/youtube-content-planner/data/.gitkeep`

**Step 1: Create directories**

```bash
mkdir -p ~/.claude/skills/youtube-content-planner/config
mkdir -p ~/.claude/skills/youtube-content-planner/data
```

**Step 2: Create watchlist.json**

```json
{
  "channels": []
}
```

Empty array — skill prompts user to populate on first run.

**Step 3: Create scoring.json**

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

**Step 4: Create pillars.json**

```json
{
  "pillars": []
}
```

Empty — discovered via SOP-3 on first run.

**Step 5: Create data/.gitkeep**

```bash
touch ~/.claude/skills/youtube-content-planner/data/.gitkeep
```

**Step 6: Verify structure**

```bash
find ~/.claude/skills/youtube-content-planner -type f
```

Expected:
```
config/watchlist.json
config/scoring.json
config/pillars.json
data/.gitkeep
```

**Step 7: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/
git commit -m "feat(youtube-content-planner): scaffold skill directory and config files"
```

---

### Task 2: Write SKILL.md frontmatter + overview + SOP-3 (Pillar Discovery)

This is the first SOP because it runs on first invocation (before SOP-1 can complete).

**Files:**
- Create: `~/.claude/skills/youtube-content-planner/SKILL.md`

**Step 1: Write the SKILL.md with frontmatter, overview, and SOP-3**

The frontmatter `description` must be triggering conditions only — no workflow summary. Max 1024 chars total for frontmatter.

```markdown
---
name: youtube-content-planner
description: "Use when planning YouTube content, finding video ideas, updating a content calendar, deciding what to film next, or analyzing content pillars. Triggers on: 'plan my next videos', 'youtube content ideas', 'update content calendar', 'what should I film next', 'rediscover my content pillars', 'content pillar analysis'."
---

# YouTube Content Planner

Combine own channel analytics, competitor analysis, and trend discovery to recommend ranked video ideas with the best chances of succeeding. Uses the YouTube MCP server tools.

## Config Files

All config lives in `~/.claude/skills/youtube-content-planner/config/`:

- **`watchlist.json`** — `{ "channels": [{ "id": "UCxxx", "name": "Channel Name" }] }` Competitor channels to track. Empty = prompt on first run.
- **`scoring.json`** — `{ "weights": { "competitionGap": 0.35, "searchSignal": 0.25, "engagementPotential": 0.20, "monetizationFit": 0.15, "audienceFit": 0.05 } }` Overridable inline.
- **`pillars.json`** — `{ "pillars": [{ "name": "...", "targetMix": 0.25 }] }` Empty = discover via SOP-3 first.

Persistent state: `~/.claude/skills/youtube-content-planner/data/content-plan.json`

## SOP-3: Pillar Discovery

**Trigger:** First run with empty `pillars.json`, or user says "rediscover my content pillars"

1. Call `getChannelTopVideos({ channelId: "UCYD_-2jbMxu0Lp65IlcGf5w", maxResults: 50 })` to get recent videos
2. Categorize each video into topic clusters based on title + description patterns. Look for natural groupings like: product reviews, protocols/how-to, science deep dives, personal experiments, industry news/trends, interviews, etc.
3. Count videos per cluster and compute percentage distribution
4. Propose 4-6 pillars with current distribution and suggested target mix. Present as:

```
🎯 Proposed Content Pillars:

  Current → Suggested Target
  Product Reviews:      42% → 30%
  Protocols & How-To:   28% → 25%
  Science Deep Dives:   18% → 20%
  Personal Experiments:  5% → 15%
  Industry & Trends:     7% → 10%

Adjust names or targets? (approve/edit)
```

5. Wait for user approval. On approval, save to `config/pillars.json`:

```json
{
  "pillars": [
    { "name": "Product Reviews", "targetMix": 0.30 },
    { "name": "Protocols & How-To", "targetMix": 0.25 }
  ]
}
```

6. Continue to SOP-1 if this was triggered as part of a full research run.
```

**Step 2: Verify the file renders correctly**

```bash
cat ~/.claude/skills/youtube-content-planner/SKILL.md | head -5
```

Expected: frontmatter with `---` delimiters and `name: youtube-content-planner`.

**Step 3: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/SKILL.md
git commit -m "feat(youtube-content-planner): add SKILL.md with frontmatter, overview, and SOP-3 pillar discovery"
```

---

### Task 3: Add SOP-1 (Full Research Run) to SKILL.md

**Files:**
- Modify: `~/.claude/skills/youtube-content-planner/SKILL.md`

**Step 1: Append SOP-1 after SOP-3 in SKILL.md**

Add the following after the SOP-3 section:

```markdown
## SOP-1: Full Research Run

**Trigger:** "plan my next videos", "youtube content ideas", "what should I film next"

**Arguments:** Optional niche/topic (e.g., "biohacking sleep"), count (default 10), weight overrides (e.g., "ignore monetization", "prioritize monetization", "only competition gap")

### Pre-flight

1. Read `config/pillars.json`. If empty, run SOP-3 first and return here.
2. Read `config/watchlist.json`. If empty, ask user: "Which competitor channels should I track? Provide channel names or IDs." Save responses to `config/watchlist.json` with `{ "id": "UCxxx", "name": "Channel Name" }` format, then continue.
3. Read `config/scoring.json` for default weights. Apply any inline overrides:
   - "ignore monetization" → set `monetizationFit: 0`, redistribute its weight proportionally to remaining factors
   - "prioritize monetization" → set `monetizationFit: 0.30`, reduce others proportionally
   - "only competition gap" → set `competitionGap: 1.0`, all others 0

### Step 1 — Gather Own Channel Data

Run these MCP calls in parallel (all use last 90 days, endDate = today):

| Call | Purpose |
|------|---------|
| `getDayOfWeekAnalysis({ startDate, endDate })` | Best posting days |
| `getTrafficSources({ startDate, endDate })` | Where views come from |
| `getContentTypeBreakdown({ startDate, endDate })` | Shorts vs long-form |
| `getDemographics({ startDate, endDate })` | Age/gender |
| `getGeography({ startDate, endDate })` | Country breakdown |
| `getChannelTopVideos({ channelId: "UCYD_-2jbMxu0Lp65IlcGf5w", maxResults: 30 })` | Recent performance + pillar categorization |

From `getChannelTopVideos` results, categorize each video into its pillar (from `config/pillars.json`) and compute current pillar distribution.

### Step 2 — Analyze Competitors

Sequential — each channel needs its own calls:

1. For each channel in `config/watchlist.json`:
   - `getChannelTopVideos({ channelId, maxResults: 10 })`
   - `getChannelStatistics({ channelIds: [channelId] })`
   - Note: top-performing topics, engagement ratios, recent upload cadence

2. Then run discovery:
   - `findOutlierChannels({ niche: "<user's niche>", maxChannels: 10 })`
   - For the top 3 outliers by outlierScore, call `getChannelTopVideos({ channelId, maxResults: 5 })`
   - Extract: what topics are these emerging channels succeeding with?

### Step 3 — Discover Trending Opportunities

Run in parallel:

1. Generate 3-5 seed queries from the niche (e.g., niche "biohacking" → "biohacking sleep", "biohacking supplements", "biohacking routine", "biohacking devices", "biohacking for beginners")
2. For each seed: `getAutocompleteSuggestions({ query: seed })`
3. `getTrendingVideos({ regionCode: "US", maxResults: 10 })` — general pulse check
4. `searchVideos({ query: "<niche>", maxResults: 20 })` — check current supply volume

Count autocomplete suggestions per seed. High suggestion count = high search demand. Cross-reference with search results to identify gaps (many suggestions but few quality videos = competition gap).

### Step 4 — Score & Rank

For each candidate video idea (synthesized from Steps 1-3):

1. **Competition Gap (1-10):** Autocomplete demand vs supply from `searchVideos`. Many suggestions + few quality results = 9-10. Saturated topic = 1-3.
2. **Search Signal (1-10):** Number of autocomplete variations + trending overlap. 10+ variations = 9-10. No autocomplete presence = 1-2.
3. **Engagement Potential (1-10):** Like/comment ratios on similar competitor videos. >5% engagement = 9-10. <1% = 1-3.
4. **Monetization Fit (1-10):** Does topic align with affiliate niches? Cross-reference with `affiliate-db-skill` if available (invoke: `affiliate({ mode: "query", fields: ["partner", "code"] })`). Direct product review = 9-10. No monetization angle = 1-2.
5. **Audience Fit (1-10):** Does topic skew toward males 25-44, US/UK/CA based on channel demographics? Strong match = 8-10. Misaligned = 1-3.

**Final score** = Σ (factor_score × weight) × 10, normalized to 0-100.

**Pillar tiebreaker:** When two ideas score within 5 points, the one in an underrepresented pillar (current% < target%) wins.

Tag each idea with its content pillar.

### Step 5 — Output

**Save to `data/content-plan.json`:**

```json
{
  "lastRun": "<ISO timestamp>",
  "channel": "UCYD_-2jbMxu0Lp65IlcGf5w",
  "runs": [
    {
      "date": "<YYYY-MM-DD>",
      "niche": "<niche>",
      "weights": { ... },
      "ideas": [
        {
          "rank": 1,
          "title": "Topic Title",
          "score": 87,
          "pillar": "Personal Experiments",
          "scores": { "competitionGap": 9, "searchSignal": 8, "engagementPotential": 7, "monetizationFit": 8, "audienceFit": 6 },
          "referenceVideos": [{ "title": "...", "channel": "...", "videoId": "...", "views": 142000, "engagement": 0.051 }],
          "suggestedAngle": "...",
          "status": "new"
        }
      ]
    }
  ]
}
```

**Render full output to `/tmp/slush/youtube-content-plan.md`** with summary header + all idea cards, then run `slush /tmp/slush/youtube-content-plan.md`.

Summary header format:

```
═══════════════════════════════════════════════════
  YOUTUBE CONTENT PLANNER — <date>
  Channel: High Performance Longevity (@outliyr)
  Niche: <niche>
  Ideas: <N> | New: <n> | Refreshed: <n>

  📈 Your Channel (last 90d):
     Top Traffic: <source1> (<pct>%) → <source2> (<pct>%) → <source3> (<pct>%)
     Best Day: <day> (<avg views> avg views)
     Content Split: Long-form <pct>% watch time | Shorts <pct>% views
     Audience: <gender_pct>% male, <age_range> dominant, <top_countries>

  🎯 Pillar Balance (last 90d → target):
     <pillar>: <current>% → <target>% <indicator>

  🔍 Competitor Watchlist: <N> channels scanned
  🆕 Discovery: <N> outlier channels found
  📊 Weights: Gap <pct>% | Search <pct>% | Engage <pct>% | Money <pct>% | Fit <pct>%
═══════════════════════════════════════════════════
```

Pillar indicators: `✓` (within 5%), `⚠️ over` (>5% above target), `⚠️ under` (>5% below target), `↗` (slightly under)

Idea card format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 #<rank> — "<title>"
Score: <score>/100 | Pillar: <pillar>

Competition Gap [<weight>%]: <score>/10 — <explanation>
Search Signal [<weight>%]: <score>/10 — <explanation>
Engagement [<weight>%]: <score>/10 — <explanation>
Monetization [<weight>%]: <score>/10 — <explanation>
Audience Fit [<weight>%]: <score>/10 — <explanation>

📎 Reference Videos:
  • "<title>" by <channel> (<views> views, <engagement>% engagement)
  • "<title>" by <channel> (<views> views, <engagement>% engagement)

💡 Suggested Angle: <what makes YOUR video different>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**In chat:** Show summary header + top 3 idea cards only. Tell user full results are in the browser (slush).
```

**Step 2: Verify SKILL.md length is reasonable**

```bash
wc -l ~/.claude/skills/youtube-content-planner/SKILL.md
```

Skill files can be longer for SOP-based skills (comment-responder is 500+ lines). Target: under 400 lines total when complete.

**Step 3: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/SKILL.md
git commit -m "feat(youtube-content-planner): add SOP-1 full research run"
```

---

### Task 4: Add SOP-2 (Calendar Update) to SKILL.md

**Files:**
- Modify: `~/.claude/skills/youtube-content-planner/SKILL.md`

**Step 1: Append SOP-2 after SOP-1**

```markdown
## SOP-2: Calendar Update

**Trigger:** "update content calendar", "refresh my content plan"

1. Read `data/content-plan.json`. If no previous runs exist, redirect to SOP-1 instead.

2. Run lighter data refresh (skip own channel analytics):
   - For each watchlist channel: `getChannelTopVideos({ channelId, maxResults: 10 })`
   - `findOutlierChannels({ niche: "<previous niche>", maxChannels: 10 })`
   - `getAutocompleteSuggestions` for previous seed queries
   - `searchVideos({ query: "<niche>", maxResults: 20 })`

3. Detect published ideas:
   - `getChannelTopVideos({ channelId: "UCYD_-2jbMxu0Lp65IlcGf5w", maxResults: 20 })`
   - Match recent uploads against existing ideas by title similarity
   - Auto-update matched ideas: `status: "new"` or `"planned"` → `"published"`

4. Re-score remaining `new` and `planned` ideas with refreshed data. Generate new ideas from fresh competitor/trending data. Merge into existing run.

5. Output updated plan (same format as SOP-1 Step 5). Highlight status changes:
   - `✅ Published` — ideas that were filmed and uploaded
   - `🆕 New` — freshly discovered ideas
   - `📌 Planned` — previously identified, still viable
```

**Step 2: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/SKILL.md
git commit -m "feat(youtube-content-planner): add SOP-2 calendar update"
```

---

### Task 5: Add error handling and common mistakes section

**Files:**
- Modify: `~/.claude/skills/youtube-content-planner/SKILL.md`

**Step 1: Append error handling and common mistakes at the end of SKILL.md**

```markdown
## Weight Override Examples

| User says | Effect |
|-----------|--------|
| "ignore monetization" | `monetizationFit: 0`, redistribute 0.15 proportionally to remaining 4 factors |
| "prioritize monetization" | `monetizationFit: 0.30`, reduce others proportionally |
| "only competition gap matters" | `competitionGap: 1.0`, all others 0 |
| "equal weights" | All 5 factors set to 0.20 |
| No override | Use `config/scoring.json` defaults |

Redistribution formula: when zeroing a factor, add its weight proportionally. E.g., zeroing monetization (0.15): each remaining factor gets `original_weight + (original_weight / sum_of_remaining) × 0.15`.

## Error Handling

| Error | Recovery |
|-------|----------|
| YouTube MCP server unreachable | Tell user: "YouTube MCP server not responding. Check if youtube-mcp.auto.outliyr.com is up." |
| `getChannelTopVideos` returns empty for competitor | Skip that channel, note in output: "⚠️ No data for Channel X" |
| `findOutlierChannels` returns no results | Skip discovery section, note: "No outlier channels found for this niche" |
| `getAutocompleteSuggestions` fails all handlers | Note: "⚠️ Autocomplete unavailable — scoring competition gap from search results only" |
| `config/watchlist.json` malformed | Ask user to fix or repopulate. Don't crash. |
| `data/content-plan.json` malformed | Start fresh — create new empty state |
| `affiliate-db-skill` not available | Score monetization based on general niche knowledge instead of partner database |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Suggesting topics the channel already covered | Always check `getChannelTopVideos` results and `data/content-plan.json` published ideas before recommending |
| All ideas in the same pillar | Apply pillar tiebreaker. If still lopsided, explicitly diversify the final list |
| Scores all cluster around 50-60 | Spread the range — use the full 1-10 scale. Anchor: 1 = worst possible, 10 = perfect opportunity |
| Vague "suggested angle" | Be specific: "Focus on 30-day personal experiment format" not "Make it unique" |
| Too many MCP calls for competitors | Cap at 5 watchlist + 3 outlier deep-dives. Don't fetch top videos for all 10 outliers. |
```

**Step 2: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/SKILL.md
git commit -m "feat(youtube-content-planner): add weight overrides, error handling, common mistakes"
```

---

### Task 6: Test SOP-3 (Pillar Discovery) end-to-end

**Files:**
- No new files — testing existing skill

**Step 1: Invoke the skill with pillar discovery trigger**

In a Claude Code session (or this one), invoke the skill:
```
/youtube-content-planner rediscover my content pillars
```

Or test manually by following SOP-3 steps:
1. Call `getChannelTopVideos({ channelId: "UCYD_-2jbMxu0Lp65IlcGf5w", maxResults: 50 })`
2. Categorize the videos into clusters
3. Verify the proposed pillars make sense
4. Approve and verify `config/pillars.json` was saved correctly

**Step 2: Verify pillars.json was populated**

```bash
cat ~/.claude/skills/youtube-content-planner/config/pillars.json
```

Expected: 4-6 pillars with `name` and `targetMix` fields, targetMix values sum to ~1.0.

**Step 3: Commit updated config**

```bash
cd ~/.claude/skills
git add youtube-content-planner/config/pillars.json
git commit -m "feat(youtube-content-planner): populate initial content pillars from channel analysis"
```

---

### Task 7: Test SOP-1 (Full Research Run) end-to-end

**Files:**
- No new files — testing existing skill

**Step 1: Populate watchlist with test competitors**

Add 3-5 competitor channels to `config/watchlist.json`. Candidates for the biohacking niche:
- Thomas DeLauer: `UC70SrI3VkT1MXALRtf0pcHg`
- What I've Learned: `UCqYPhGiB9tkShZorfgcL2lA`
- Andrew Huberman: `UC2D2CMWXMOVWx7giW1n3LIg`

Save to `config/watchlist.json`:
```json
{
  "channels": [
    { "id": "UC70SrI3VkT1MXALRtf0pcHg", "name": "Thomas DeLauer" },
    { "id": "UCqYPhGiB9tkShZorfgcL2lA", "name": "What I've Learned" },
    { "id": "UC2D2CMWXMOVWx7giW1n3LIg", "name": "Andrew Huberman" }
  ]
}
```

**Step 2: Run full research**

Invoke: `plan my next 5 videos about biohacking`

Follow SOP-1 through all 5 steps. Verify:
- All parallel MCP calls in Step 1 return data
- Competitor analysis in Step 2 runs for each watchlist channel
- Autocomplete + trending in Step 3 returns suggestions
- Scoring in Step 4 produces ranked ideas with pillar tags
- Output in Step 5 shows summary header + top 3 cards in chat + full output in slush

**Step 3: Verify data persistence**

```bash
cat ~/.claude/skills/youtube-content-planner/data/content-plan.json | python3 -m json.tool | head -20
```

Expected: valid JSON with `lastRun`, `channel`, `runs[0].ideas` array.

**Step 4: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/
git commit -m "feat(youtube-content-planner): verify full research run with real data"
```

---

### Task 8: Test SOP-2 (Calendar Update) end-to-end

**Files:**
- No new files — testing existing skill

**Step 1: Invoke calendar update**

Run: `update content calendar`

Verify:
- Loads previous `data/content-plan.json`
- Runs lighter refresh (no channel analytics calls)
- Detects any published ideas by matching recent uploads
- Re-scores and merges
- Output shows status indicators (✅ Published, 🆕 New, 📌 Planned)

**Step 2: Verify updated state**

```bash
cat ~/.claude/skills/youtube-content-planner/data/content-plan.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Runs: {len(d[\"runs\"])}'); print(f'Latest ideas: {len(d[\"runs\"][-1][\"ideas\"])}')"
```

Expected: 2 runs, latest run has merged ideas.

**Step 3: Commit**

```bash
cd ~/.claude/skills
git add youtube-content-planner/
git commit -m "feat(youtube-content-planner): verify calendar update with real data"
```

---

### Task 9: Test weight overrides

**Step 1: Test "ignore monetization"**

Run: `plan my next 5 videos about biohacking, ignore monetization`

Verify:
- Monetization weight is 0 in the output header
- Other weights are redistributed proportionally
- Ideas still ranked sensibly

**Step 2: Test "only competition gap"**

Run: `plan my next 5 videos about biohacking, only competition gap matters`

Verify:
- Only competition gap weight shows in header
- Ranking reflects pure competition gap scores

**Step 3: No commit needed** — these are stateless verification runs.

---

### Task 10: Final review, push, and deploy

**Step 1: Verify final skill structure**

```bash
find ~/.claude/skills/youtube-content-planner -type f | sort
```

Expected:
```
config/pillars.json
config/scoring.json
config/watchlist.json
data/.gitkeep
data/content-plan.json
SKILL.md
```

**Step 2: Verify SKILL.md size**

```bash
wc -l ~/.claude/skills/youtube-content-planner/SKILL.md
```

Target: under 400 lines.

**Step 3: Final commit and push**

```bash
cd ~/.claude/skills
git add youtube-content-planner/
git status
git push origin main
```

**Step 4: Verify skill appears in Claude Code**

Start a new Claude Code session and check that `youtube-content-planner` appears in the available skills list. The description should trigger on phrases like "plan my next videos".
