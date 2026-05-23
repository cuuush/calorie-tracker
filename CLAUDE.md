# Calorie Tracker

SvelteKit + Cloudflare Workers app for tracking food intake with AI-powered meal analysis.

## Structure

- **Routes**: `/src/routes/`
  - `+page.svelte` - Main app (track/history/chat tabs, result view)
  - `settings/+page.svelte` - User settings
  - `api/` - API endpoints (analyze, entry, history, settings, followup, chat)

- **Components**: `/src/lib/components/`
  - `TrackView.svelte` - Input UI (camera, mic, text)
  - `HistoryView.svelte` - History display
  - `ChatView.svelte` - Streaming nutrition-assistant chat
  - `DailyStats.svelte` - Stats, progress bars, charts
  - `PieChart.svelte` - Reusable pie chart
  - `EntryCard.svelte` - Individual meal entry
  - `Toast.svelte` - Global toast notifications (rendered in +layout)
  - `LoadingSkeleton.svelte` - Loading placeholder

- **Database**: Cloudflare D1
  - Schema: `/schema.sql`
  - Bindings: `wrangler.toml`

- **AI**: OpenRouter API
  - Server code: `/src/lib/server/ai.js`
  - Analysis: `/src/routes/api/analyze/+server.js`

## Key Patterns

- Svelte 5 runes (`$state`, `$derived`, `$props`, `$bindable`)
- lucide-svelte for icons

## UI Conventions

- **No `alert()`** — use the toast helper from `src/lib/toast.svelte.js` (`import { toast } from '$lib/toast.svelte.js'`) for transient notifications, or render an inline card when the message warrants more weight (e.g. AI responses, errors needing context). System modals break the visual style.
- Toast variants: `toast('msg')` (info), `toast('msg', { kind: 'error' })`, `toast('msg', { kind: 'success' })`.

# Extras
feel free to run npx wrangler, but be mindful that we have production data in DB.