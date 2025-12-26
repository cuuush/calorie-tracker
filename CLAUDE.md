# Calorie Tracker

SvelteKit + Cloudflare Workers app for tracking food intake with AI-powered meal analysis.

## Structure

- **Routes**: `/src/routes/`
  - `+page.svelte` - Main app (track/history tabs, result view)
  - `settings/+page.svelte` - User settings
  - `api/` - API endpoints (analyze, entry, history, settings, followup)

- **Components**: `/src/lib/components/`
  - `TrackView.svelte` - Input UI (camera, mic, text)
  - `HistoryView.svelte` - History display
  - `DailyStats.svelte` - Stats, progress bars, charts
  - `PieChart.svelte` - Reusable pie chart
  - `EntryCard.svelte` - Individual meal entry
  - `LoadingSkeleton.svelte` - Loading placeholder

- **Database**: Cloudflare D1
  - Schema: `/schema.sql`
  - Migrations: `/migrations/`
  - Bindings: `wrangler.toml`

- **AI**: OpenRouter API
  - Server code: `/src/lib/server/ai.js`
  - Analysis: `/src/routes/api/analyze/+server.js`

## Key Patterns

- Svelte 5 runes (`$state`, `$derived`, `$props`, `$bindable`)
- lucide-svelte for icons
