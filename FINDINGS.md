# Findings

---

### 1. `computeNextSendTime` computes duration in seconds, not milliseconds

- **File / line:** `backend/src/sequences/service.ts:120`
- **Severity:** High
- **What's wrong:** `delayDays * 24 * 60 * 60` produces a value in **seconds**. JavaScript `Date.getTime()` works in milliseconds, so adding this to a timestamp produces a time only ~16 minutes in the future instead of the intended number of days.
- **Why it's a bug (when does it manifest?):** Every time `computeNextSendTime` is called — specifically by the `resumeSequence` code path — emails are re-scheduled to roughly 16 minutes per "day" of configured delay, not the real delay.
- **Fix:** Added `* 1000`: `delayDays * 24 * 60 * 60 * 1000`.
- **How I verified:** Unit arithmetic: `1 * 24 * 60 * 60 = 86400` (seconds, not ms). `86400 * 1000 = 86_400_000` (1 day in ms, correct).

---

### 2. TOCTOU race condition in `checkAndIncrement`

- **File / line:** `backend/src/mailboxes/rateLimiter.ts:53–67`
- **Severity:** High
- **What's wrong:** The function reads both Redis counters, checks them against limits, then increments — as three separate round-trips. With `concurrency: 4` workers, four workers can all read the same count (say 9 of 10), all pass the limit check, and all increment, yielding a final count of 13 — 30% over the configured limit.
- **Why it's a bug (when does it manifest?):** Under any concurrent load. With 4 workers and a tight hourly limit (e.g. `hourly_limit=5`), the limit can be blown by up to 4× in a single second.
- **Fix:** Replaced the read-check-increment sequence with a single Lua script (`CHECK_AND_INCREMENT`) executed atomically via `redis.eval`. Redis executes Lua scripts serially — no other command can interleave — eliminating the race entirely.
- **How I verified:** Code review. The Lua script reads both counters, checks both limits, and only increments if both pass, all in one atomic operation.

---

### 3. `checkAndIncrement` daily counter not rolled back when hourly limit blocks

- **File / line:** `backend/src/mailboxes/rateLimiter.ts:61–65`
- **Severity:** Medium
- **What's wrong:** In the original code, `INCR` for the daily counter happens first. If the code then had to reject on an hourly limit, the daily counter would have been incremented even though no email was sent — silently burning daily quota.
- **Why it's a bug (when does it manifest?):** Whenever hourly throttling kicks in: the daily count grows faster than actual sends, causing the daily limit to be hit prematurely.
- **Fix:** Addressed by the same Lua script fix (#2): the atomic script checks both limits *before* incrementing either counter.
- **How I verified:** Lua script logic: returns `'hourly'` before any `INCR` call if the hourly limit would be breached.

---

### 4. `readQuota` initialises Redis keys with no TTL (slow memory leak)

- **File / line:** `backend/src/mailboxes/rateLimiter.ts:87, 92`
- **Severity:** Low
- **What's wrong:** `redis.set(dKey, 0)` and `redis.set(hKey, 0)` have no expiry argument. Keys set this way never expire. Key names encode date/hour (e.g. `rl:daily:1:2024-06-10`), so they accumulate without bound — one per mailbox per day/hour, forever.
- **Why it's a bug (when does it manifest?):** Redis memory grows steadily over time as quota pages are viewed. Never cleaned up without a manual `FLUSHDB`.
- **Fix:** Added `'EX', 86400` and `'EX', 3600` respectively, matching the TTL used by `checkAndIncrement`.
- **How I verified:** Code review; confirmed `redis.set(key, '0', 'EX', 86400)` syntax is valid for ioredis.

---

### 5. Worker processes emails from paused sequences

- **File / line:** `backend/src/worker/processor.ts:51–53`
- **Severity:** High
- **What's wrong:** The processor's SQL query joins the `sequences` table and fetches `sequence_status`, but the code never checks that field. If a sequence is paused after its jobs are already in the BullMQ delayed queue, those jobs will still fire and send emails — the pause has no effect on already-enqueued work.
- **Why it's a bug (when does it manifest?):** Any time a sequence is paused. `cancelDelayedJobs` removes jobs from BullMQ, but there is a window between the API returning and all jobs being cancelled. Jobs that fire in that window bypass the pause entirely.
- **Fix:** Added an explicit check: if `row.sequence_status !== 'active'`, mark the email `skipped`, log it, and return early — same pattern as the `prospect_status` check above it.
- **How I verified:** Code review; confirmed the fix mirrors the existing `prospect_status !== 'active'` guard.

---

### 6. `cancelDelayedJobs` silently misses jobs beyond index 5000

- **File / line:** `backend/src/sequences/scheduler.ts:110`
- **Severity:** Medium
- **What's wrong:** `sendQueue.getDelayed(0, 5000)` returns at most 5001 jobs (indices 0–5000). For sequences with more than 5000 total delayed jobs across all sequences, jobs beyond that range are never inspected or cancelled. The pause appears to succeed but emails keep going out.
- **Why it's a bug (when does it manifest?):** Any deployment with a large backlog (many sequences × many prospects × many steps). Common in production after a few weeks of use.
- **Fix:** Rewrote `cancelDelayedJobs` to query the DB for pending `scheduled_emails` belonging to the sequence, then remove each BullMQ job by its deterministic ID (`se-<id>`). This is O(n) in the sequence's own emails, not O(total queue size), and misses nothing.
- **How I verified:** Reviewed job creation: each job is added with `jobId: \`se-${result.insertId}\``. `sendQueue.getJob(id)` looks up by that exact ID, so removal is reliable regardless of queue depth.

---

### 7. `GET /:id/steps` calls `getSteps` twice (double DB query)

- **File / line:** `backend/src/sequences/routes.ts:53, 58`
- **Severity:** Low
- **What's wrong:** `getSteps(seq.id)` is called once to check for empty results, and then called *again* to build the response — two identical SQL queries per request.
- **Why it's a bug (when does it manifest?):** Every call to `GET /sequences/:id/steps`. Negligible on small data; wasteful at scale.
- **Fix:** Stored the first call's result in `sequences_steps` and reused it in `res.json(sequences_steps)`.
- **How I verified:** Code diff — single `getSteps` call, result reused.
