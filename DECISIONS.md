# Decisions

---

## Pause / Resume trade-offs

### In-flight job window
`cancelDelayedJobs` removes jobs from BullMQ's delayed queue, but there is an unavoidable race window: a job can dequeue between the API returning and the removal completing. The fix for this is the `sequence_status` guard added in `processor.ts` — even if a job fires during that window, the worker re-checks the sequence status from the DB and skips the send. The two defences are complementary.

### Resume re-scheduling from "now"
On resume, all pending emails are re-scheduled starting from `now + step.delay_days` rather than their original `scheduled_at`. This means a sequence paused for three days will resume with the full configured delays from now, not from when it was originally scheduled. This matches the assignment spec ("delay_days measured from now, not from the original schedule") and avoids blasting a backlog of overdue emails the moment the user clicks Resume.

### Budget enforcement on resume
The `remainingBudget()` check is applied only to emails whose newly computed `scheduled_at` falls within today (before midnight UTC). Emails landing on future days are enqueued unconstrained — they will be rate-checked again when the worker actually processes them via `checkAndIncrement`. This keeps today's send volume bounded without over-constraining future sends.

Skipped emails (budget exhausted for today) remain in `status='pending'` in the DB. They can be picked up by another Resume tomorrow, or the user can re-schedule the sequence. A better long-term solution would be a background sweeper that automatically re-enqueues pending emails when budget resets — noted as future work.

### cancelDelayedJobs approach
Switched from a full delayed-queue scan (`getDelayed(0, 5000)`) to a targeted lookup: query the DB for this sequence's pending emails, then remove each BullMQ job by deterministic ID (`se-<id>`). This is correct regardless of queue depth and avoids the silent truncation at 5001 jobs.

---

## Mailbox Quota UI

### Refresh strategy: 30-second polling
Quota data changes only when the worker sends emails (rate-limited to `hourly_limit` per hour). An interval of 30 seconds gives reasonably fresh data without hammering the server. SSE or WebSockets would give real-time updates but are overkill for data that changes at most ~10 times per hour per mailbox. If the app scaled to many concurrent users, a WebSocket broadcast from the worker on each successful send would be the right upgrade.

### Staleness tolerance
A 30-second stale quota snapshot is acceptable: the worst case is seeing `used=9` when the real value is `10` — the next interval corrects it. The rate limiter itself is authoritative (Redis, not the UI), so quota display being slightly stale has no correctness impact.

### Per-mailbox quota fetch
The API exposes `GET /mailboxes/:id/quota` (one mailbox at a time). All quotas are fetched in parallel with `Promise.all`, minimising total latency. A single bulk endpoint (`GET /mailboxes/quotas`) would be cleaner but wasn't part of the spec.

### ≥80% warning threshold
At 80% usage, the progress bar turns amber and a ⚠️ icon appears. At 100%, it turns red with a 🔴 icon. This mirrors standard infrastructure monitoring conventions (warn → alert).

---

## Test framework choice

**vitest** — reasons:
- Native ESM support without extra config, aligns with the project's `"type": "module"` frontend and TypeScript-first backend.
- Near-zero setup: no `babel.config.js`, no `jest.config.js` transformers.
- API is a drop-in superset of Jest, so it's familiar.
- Fast: runs tests in parallel via worker threads.

Alternative considered: `node:test` (built-in). Rejected because mock/spy support is immature and the assertion library is more verbose.

---

## What I'd change with another day

1. **Rate-limit retry logic.** When a job is rate-limited, BullMQ marks it failed (default `attempts: 1`, no retry). The worker resets `status='pending'` in the DB, so the email isn't lost, but it will never fire again unless the user manually pauses/resumes. A proper fix: configure BullMQ with exponential backoff retries (e.g. `{ attempts: 5, backoff: { type: 'fixed', delay: 3600000 } }`) so rate-limited jobs retry automatically after the rate window resets.

2. **Bulk quota endpoint.** Replace the N parallel `GET /mailboxes/:id/quota` calls with a single `GET /mailboxes/quotas` endpoint to reduce frontend round-trips.

3. **Resume skipped-budget emails.** Add a background job (cron or BullMQ repeatable) that runs after midnight UTC and re-enqueues any `status='pending'` emails that were skipped due to budget exhaustion.

4. **Sequence status optimistic update.** The Sequences list re-fetches from the server after every action (schedule/pause/resume). An optimistic UI update would make the UX feel snappier.

5. **Tests for the worker retry path.** The rate-limit → fail → pending inconsistency is a code path worth covering with an integration test.

---

## Frontend implementation

### Tech stack
React 18 + Vite 5 + TypeScript 5, react-router-dom v6. Vite was chosen because it starts in milliseconds (vs CRA's seconds), has first-class TypeScript support, and the proxy config (`vite.config.ts`) requires a single `server.proxy` entry to forward `/api` to `localhost:4000` — no extra package needed.

### Authentication
JWT stored in `localStorage`, sent as `Authorization: Bearer <token>` on every request. A `RequireAuth` wrapper in `App.tsx` gates all routes — unauthenticated users are redirected to `/login`. Register page added so new users can create accounts without a seed script.

### Dark theme
`--bg: #0f172a`, `--surface: #1e293b`, `--primary: #6366f1` as CSS custom properties. `color-scheme: dark` on all native inputs/selects ensures browser-rendered controls (dropdowns, date pickers) respect the theme without requiring custom replacements.

### Scheduling new prospects onto an active sequence
Once a sequence is `active`, the draft-only Schedule button disappears. We added "Schedule New" logic: compute `scheduledProspectIds` from the already-loaded `emails` state, diff against `seq.prospects`, and show a "Schedule New" button only when there are active prospects not yet in the queue. The backend was made idempotent (finding 9 above) so calling the schedule endpoint again is safe — it only inserts rows for the new prospects.

### Send Logs section
`GET /sequences/:id/logs` was added to surface the `send_logs` table (which the worker was already writing to) in the UI. The table JOIN returns denormalised rows (prospect email/name, step subject/order, mailbox email) so the frontend can display a readable log without extra round-trips. Logs refresh on Schedule/Pause/Resume and have a manual Refresh button.

### Steps table body column
The steps table was restructured to show the email body inline (with `white-space: pre-line` to preserve line breaks), matching the Adminer database view the spec referenced. Steps are now displayed full-width above prospects so the body column has room to wrap.

---

## Consciously not fixed

- **Broad CORS** (`app.use(cors())`): Allows any origin. For a local dev tool this is acceptable; tightening it requires knowing the deployed frontend origin, which depends on deployment config outside this repo.
- **`attempts` counter incremented on rate-limit rejections:** The counter increments before the rate-limit check, so it grows faster than actual send attempts. This inflates the metric but doesn't cause incorrect behaviour. Fixing it would change the semantics of `attempts` (currently "processing attempts" vs "send attempts") — left as-is to avoid changing observable behaviour without a spec decision.
- **No pagination on logs/scheduled-emails:** Both endpoints accept `limit`/`offset` query params but the frontend fetches the first 200 rows only. For long-running sequences this is fine as a first pass; virtual scrolling or cursor-based pagination would be the production fix.
