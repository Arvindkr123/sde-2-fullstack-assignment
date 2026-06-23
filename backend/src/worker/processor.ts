import type { Job } from 'bullmq';
import { pool } from '../config/db';
import { checkAndIncrement } from '../mailboxes/rateLimiter';
import { send } from './smtpAdapter';
import type { RowDataPacket } from 'mysql2';

interface SendJob {
  scheduledEmailId: number;
}

interface JoinedRow extends RowDataPacket {
  id: number;
  sequence_id: number;
  step_id: number;
  prospect_id: number;
  mailbox_id: number;
  status: string;
  attempts: number;
  subject: string;
  body: string;
  prospect_email: string;
  prospect_status: string;
  mailbox_email: string;
  sequence_status: string;
}

export async function processSendJob(job: Job<SendJob>): Promise<void> {
  const { scheduledEmailId } = job.data;

  const [rows] = await pool.execute<JoinedRow[]>(
    `SELECT se.id, se.sequence_id, se.step_id, se.prospect_id, se.mailbox_id,
            se.status, se.attempts,
            st.subject, st.body,
            p.email AS prospect_email, p.status AS prospect_status,
            m.email AS mailbox_email,
            s.status AS sequence_status
       FROM scheduled_emails se
       JOIN sequence_steps st ON st.id = se.step_id
       JOIN prospects p ON p.id = se.prospect_id
       JOIN mailboxes m ON m.id = se.mailbox_id
       JOIN sequences s ON s.id = se.sequence_id
      WHERE se.id = ?
      LIMIT 1`,
    [scheduledEmailId],
  );
  const row = rows[0];
  if (!row) {
    console.warn(`[worker] scheduled_email ${scheduledEmailId} not found`);
    return;
  }
  if (row.status !== 'pending') {
    return;
  }
  // Respect pause: if the sequence was paused after this job was already enqueued,
  // skip the send instead of firing it anyway.
  if (row.sequence_status !== 'active') {
    await pool.execute(
      "UPDATE scheduled_emails SET status='skipped' WHERE id=?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'skipped', `sequence ${row.sequence_status}`],
    );
    return;
  }
  if (row.prospect_status !== 'active') {
    await pool.execute(
      "UPDATE scheduled_emails SET status='skipped' WHERE id=?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'skipped', `prospect ${row.prospect_status}`],
    );
    return;
  }

  await pool.execute(
    "UPDATE scheduled_emails SET status='processing', processing_since=NOW(), attempts = attempts + 1 WHERE id = ?",
    [row.id],
  );

  const check = await checkAndIncrement(row.mailbox_id);
  if (!check.allowed) {
    // Leave status as 'processing' (processing_since already set) so that
    // recoverStuckJobs picks this up after 5 min and re-queues it. Resetting
    // to 'pending' here would drop the BullMQ job with no replacement, leaving
    // the row stuck in 'pending' with nothing to process it.
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'rate_limited', `limit hit: ${check.reason}`],
    );
    throw new Error(`rate_limited:${check.reason}`);
  }

  try {
    await send({
      from: row.mailbox_email,
      to: row.prospect_email,
      subject: row.subject,
      body: row.body,
    });
    await pool.execute(
      "UPDATE scheduled_emails SET status='sent', processing_since=NULL, sent_at=NOW() WHERE id = ?",
      [row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'sent', 'Email dispatched'],
    );
  } catch (err) {
    const message = (err as Error).message;
    await pool.execute(
      "UPDATE scheduled_emails SET status='failed', processing_since=NULL, last_error=? WHERE id = ?",
      [message, row.id],
    );
    await pool.execute(
      'INSERT INTO send_logs (scheduled_email_id, mailbox_id, status, message) VALUES (?, ?, ?, ?)',
      [row.id, row.mailbox_id, 'failed', message],
    );
    throw err;
  }
}
