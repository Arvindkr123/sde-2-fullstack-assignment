import { pool } from '../config/db';
import { Queue } from 'bullmq';
import { bullConnection } from '../config/redis';
import { getSteps, getProspects, setSequenceStatus, type Step } from './service';
import { remainingBudget } from '../mailboxes/rateLimiter';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export const SEND_QUEUE = 'email-send';
export const sendQueue = new Queue(SEND_QUEUE, { connection: bullConnection });

interface ScheduleOpts {
  sequenceId: number;
  /** When to start scheduling from. Defaults to now. */
  from?: Date;
}

interface ScheduleResult {
  scheduled: number;
  skipped: number;
}

/**
 * Schedule a sequence: for each (prospect, step) pair, create a
 * `scheduled_emails` row and enqueue a delayed BullMQ job.
 */
export async function scheduleSequence(opts: ScheduleOpts): Promise<ScheduleResult> {
  const { sequenceId, from = new Date() } = opts;

  const steps = await getSteps(sequenceId);
  const prospects = await getProspects(sequenceId);
  const mailboxId = await pickMailboxForSequence(sequenceId);

  // Skip prospects that already have scheduled emails so re-calling on an
  // active sequence only queues newly-added prospects, not duplicates.
  const [existingRows] = await pool.execute<RowDataPacket[]>(
    'SELECT DISTINCT prospect_id FROM scheduled_emails WHERE sequence_id = ?',
    [sequenceId],
  );
  const alreadyScheduled = new Set((existingRows as RowDataPacket[]).map(r => r.prospect_id as number));

  let scheduled = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    if (prospect.status !== 'active') {
      skipped++;
      continue;
    }
    if (alreadyScheduled.has(prospect.id)) {
      skipped++;
      continue;
    }

    // Walk every step for this prospect, accumulating delays from the start time.
    let cursor = from.getTime();
    for (let i = 0; i < steps.length; i++) {
      try {
        const step = steps[i];
        cursor += step.delay_days * 24 * 60 * 60 * 1000;
        const scheduledAt = new Date(cursor);

        const [result] = await pool.execute<ResultSetHeader>(
          `INSERT INTO scheduled_emails
             (sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts)
           VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
          [sequenceId, step.id, prospect.id, mailboxId, scheduledAt],
        );

        const delay = Math.max(0, scheduledAt.getTime() - Date.now());
        await sendQueue.add(
          'send',
          { scheduledEmailId: result.insertId },
          { delay, jobId: `se-${result.insertId}` },
        );
        scheduled++;
      } catch (err) {
        console.error(
          `[scheduler] step skipped for prospect ${prospect.id} at index ${i}:`,
          (err as Error).message,
        );
        skipped++;
      }
    }
  }

  // Only transition draft→active; don't disturb an already-active/paused sequence.
  const [seqRows] = await pool.execute<RowDataPacket[]>(
    'SELECT status FROM sequences WHERE id = ? LIMIT 1',
    [sequenceId],
  );
  if ((seqRows[0] as RowDataPacket)?.status === 'draft') {
    await setSequenceStatus(sequenceId, 'active');
  }

  return { scheduled, skipped };
}

/**
 * Resume a paused sequence: re-schedule all pending emails from "now",
 * cascading step delays per prospect. Respects the mailbox's remaining daily
 * budget — emails that would exceed today's quota are skipped (they can be
 * resumed again tomorrow or the user can re-schedule).
 */
export async function resumeSequence(sequenceId: number): Promise<ScheduleResult> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT se.id, se.prospect_id, se.mailbox_id, ss.delay_days, ss.step_order
       FROM scheduled_emails se
       JOIN sequence_steps ss ON ss.id = se.step_id
      WHERE se.sequence_id = ? AND se.status = 'pending'
      ORDER BY se.prospect_id ASC, ss.step_order ASC`,
    [sequenceId],
  );

  type PendingRow = { id: number; prospect_id: number; mailbox_id: number; delay_days: number; step_order: number };
  const emails = rows as PendingRow[];
  if (emails.length === 0) return { scheduled: 0, skipped: 0 };

  // Group pending emails by prospect so we can cascade delays correctly.
  const byProspect = new Map<number, PendingRow[]>();
  for (const email of emails) {
    const list = byProspect.get(email.prospect_id) ?? [];
    list.push(email);
    byProspect.set(email.prospect_id, list);
  }

  // Cache remaining daily budget per mailbox to avoid N+1 Redis calls.
  // We only gate emails landing "today" — future-dated emails don't burn today's quota.
  const budgetCache = new Map<number, number>();
  const endOfToday = new Date();
  endOfToday.setUTCHours(23, 59, 59, 999);

  let scheduled = 0;
  let skipped = 0;
  const now = Date.now();

  for (const [, prospectEmails] of byProspect) {
    let cursor = now;
    for (const email of prospectEmails) {
      cursor += email.delay_days * 24 * 60 * 60 * 1000;
      const scheduledAt = new Date(cursor);

      // Budget check only for sends landing today so we don't accidentally
      // queue more than the mailbox can deliver before midnight.
      if (scheduledAt <= endOfToday) {
        if (!budgetCache.has(email.mailbox_id)) {
          const budget = await remainingBudget(email.mailbox_id);
          budgetCache.set(email.mailbox_id, budget?.daily ?? 0);
        }
        const remaining = budgetCache.get(email.mailbox_id)!;
        if (remaining <= 0) {
          skipped++;
          continue;
        }
        budgetCache.set(email.mailbox_id, remaining - 1);
      }

      await pool.execute(
        'UPDATE scheduled_emails SET scheduled_at = ? WHERE id = ?',
        [scheduledAt, email.id],
      );
      const delay = Math.max(0, scheduledAt.getTime() - Date.now());
      await sendQueue.add(
        'send',
        { scheduledEmailId: email.id },
        { delay, jobId: `se-${email.id}` },
      );
      scheduled++;
    }
  }

  return { scheduled, skipped };
}

async function pickMailboxForSequence(sequenceId: number): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT mailbox_id FROM sequences WHERE id = ? LIMIT 1',
    [sequenceId],
  );
  if (rows.length === 0 || !rows[0].mailbox_id) {
    throw new Error('no mailbox available for sequence');
  }
  return rows[0].mailbox_id as number;
}

/**
 * Cancel all pending BullMQ jobs for a sequence. Looks up pending
 * scheduled_email IDs from the DB and removes their jobs by deterministic ID
 * (`se-<id>`), avoiding a full scan of the delayed queue.
 */
export async function cancelDelayedJobs(sequenceId: number): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id FROM scheduled_emails WHERE sequence_id = ? AND status = 'pending'",
    [sequenceId],
  );
  let cancelled = 0;
  for (const row of rows as RowDataPacket[]) {
    const job = await sendQueue.getJob(`se-${row.id}`);
    if (job) {
      await job.remove();
      cancelled++;
    }
  }
  return cancelled;
}

/**
 * When a new step is added to an already-active sequence, schedule that
 * specific step for all existing active prospects who don't already have it
 * queued. Timing is `now + delay_days` so it behaves like any other step.
 */
export async function scheduleStepForExistingProspects(opts: {
  sequenceId: number;
  stepId: number;
  delayDays: number;
}): Promise<ScheduleResult> {
  const { sequenceId, stepId, delayDays } = opts;

  const mailboxId = await pickMailboxForSequence(sequenceId);
  const prospects = await getProspects(sequenceId);

  const [existingRows] = await pool.execute<RowDataPacket[]>(
    'SELECT DISTINCT prospect_id FROM scheduled_emails WHERE sequence_id = ? AND step_id = ?',
    [sequenceId, stepId],
  );
  const alreadyScheduled = new Set((existingRows as RowDataPacket[]).map(r => r.prospect_id as number));

  let scheduled = 0;
  let skipped = 0;
  const now = Date.now();

  for (const prospect of prospects) {
    if (prospect.status !== 'active') { skipped++; continue; }
    if (alreadyScheduled.has(prospect.id)) { skipped++; continue; }

    const scheduledAt = new Date(now + delayDays * 24 * 60 * 60 * 1000);

    try {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO scheduled_emails
           (sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts)
         VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
        [sequenceId, stepId, prospect.id, mailboxId, scheduledAt],
      );
      const delay = Math.max(0, scheduledAt.getTime() - Date.now());
      await sendQueue.add(
        'send',
        { scheduledEmailId: result.insertId },
        { delay, jobId: `se-${result.insertId}` },
      );
      scheduled++;
    } catch (err) {
      console.error(`[scheduler] failed to schedule step ${stepId} for prospect ${prospect.id}:`, (err as Error).message);
      skipped++;
    }
  }

  return { scheduled, skipped };
}

export function _typeBrand(): Step | undefined {
  return undefined;
}
