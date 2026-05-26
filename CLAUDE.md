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

## Testing

- **Every new feature, endpoint, or behavioral change must include tests.** Cover the happy path plus at least one edge case (invalid input, missing data, auth boundary). Bug fixes should add a regression test that would have caught the bug. If something is genuinely untestable (e.g. pure UI animation), note why in the PR — but server logic, utilities, and data flows are always testable.
- **Run `npx vite build` before pushing** to catch Svelte compile errors (e.g. `{@const}` placement, template syntax). Unit tests don't compile `.svelte` files so they won't catch these.
- **Run `npm run test:unit` before pushing** and ensure all tests pass. Don't leave broken or skipped tests behind.
- **Unit/integration**: Vitest (`npm run test:unit`). Tests live alongside source as `*.test.js`.
- **E2E**: Playwright (`npm test` runs both).
- **Real Cloudflare bindings**: Tests use `getPlatformProxy({ persist: false })` from `wrangler` for real D1/R2/KV backed by in-memory Miniflare. No hand-rolled mocks for storage.
- **LLM mocking**: Only OpenRouter HTTP calls are mocked. Use helpers in `src/tests/mocks/llm.js` (`createTextStreamChunks`, `createToolCallStreamChunks`, `mockFetchSSE`).
- **Test setup**: `src/tests/setup.js` exports `getTestPlatform()`, `applySchema()`, `resetAll()`, `seedSettings()`, `seedEntry()`. Each test file owns its own proxy lifecycle (call `getPlatformProxy` in `beforeAll`, `dispose()` in `afterAll`).
- **Chat pure functions** are in `src/routes/api/chat/utils.js` (extracted for testability). The `+server.js` imports from it.
- **Client chat history** builder is in `src/lib/chat-history.js` (extracted from ChatView.svelte).

### Gotchas

- **D1 `db.exec()` chokes on SQL comments** — strip `--` comments before calling exec, or split on `;` and use `db.prepare(stmt).run()` per statement.
- **`getPlatformProxy()` needs Node.js** — always use `environment: 'node'` in vitest config. It spawns Miniflare as a child process.
- **`getPlatformProxy()` startup is ~1-2s** — set `testTimeout: 15000` and `hookTimeout: 30000` in vite config.
- **`persist: false`** gives fresh in-memory D1/R2/KV. Use `resetDatabase()` in `beforeEach` to clean between tests (DELETE rows, don't re-create tables).
- **`svelte-check` has hundreds of pre-existing errors** — don't be alarmed, they're not from your changes. Compare counts before/after.

# Extras
feel free to run npx wrangler, but be mindful that we have production data in DB.