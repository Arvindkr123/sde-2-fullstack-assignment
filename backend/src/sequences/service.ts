import { pool } from '../config/db';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export interface Sequence {
  id: number;
  user_id: number;
  mailbox_id: number;
  mailbox_email: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
}

export interface Step {
  id: number;
  sequence_id: number;
  step_order: number;
  delay_days: number;
  subject: string;
  body: string;
}

export interface Prospect {
  id: number;
  sequence_id: number;
  email: string;
  name: string | null;
  status: 'active' | 'unsubscribed' | 'bounced';
}

export async function getSequenceForUser(
  sequenceId: number,
  userId: number,
): Promise<Sequence | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT s.id, s.user_id, s.mailbox_id, m.email AS mailbox_email, s.name, s.status
       FROM sequences s
       JOIN mailboxes m ON m.id = s.mailbox_id
      WHERE s.id = ? AND s.user_id = ?
      LIMIT 1`,
    [sequenceId, userId],
  );
  return (rows[0] as Sequence) ?? null;
}

export async function listSequencesForUser(userId: number): Promise<Sequence[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT s.id, s.user_id, s.mailbox_id, m.email AS mailbox_email, s.name, s.status, s.created_at
       FROM sequences s
       JOIN mailboxes m ON m.id = s.mailbox_id
      WHERE s.user_id = ?
      ORDER BY s.id DESC`,
    [userId],
  );
  return rows as Sequence[];
}

export async function createSequence(userId: number, name: string, mailboxId: number): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT INTO sequences (user_id, mailbox_id, name, status) VALUES (?, ?, ?, 'draft')",
    [userId, mailboxId, name],
  );
  return result.insertId;
}

export async function getSteps(sequenceId: number): Promise<Step[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, sequence_id, step_order, delay_days, subject, body FROM sequence_steps WHERE sequence_id = ? ORDER BY step_order ASC',
    [sequenceId],
  );
  return rows as Step[];
}

export async function getProspects(sequenceId: number): Promise<Prospect[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, sequence_id, email, name, status FROM prospects WHERE sequence_id = ? ORDER BY id',
    [sequenceId],
  );
  return rows as Prospect[];
}

export async function addProspect(
  sequenceId: number,
  email: string,
  name: string | null,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT INTO prospects (sequence_id, email, name, status) VALUES (?, ?, ?, 'active')",
    [sequenceId, email, name ?? null],
  );
  return result.insertId;
}

export async function updateProspectStatus(
  prospectId: number,
  sequenceId: number,
  status: Prospect['status'],
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE prospects SET status = ? WHERE id = ? AND sequence_id = ?',
    [status, prospectId, sequenceId],
  );
  return result.affectedRows > 0;
}

export async function deleteProspect(
  prospectId: number,
  sequenceId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM prospects WHERE id = ? AND sequence_id = ?',
    [prospectId, sequenceId],
  );
  return result.affectedRows > 0;
}

export async function setSequenceStatus(
  sequenceId: number,
  status: Sequence['status'],
): Promise<void> {
  await pool.execute('UPDATE sequences SET status = ? WHERE id = ?', [status, sequenceId]);
}

/**
 * Compute when the next email in a sequence should go out given the previous
 * send time and the next step's configured `delay_days`. Used by the resume
 * code path so that paused sequences pick up from "now + delay" rather than
 * blasting all queued emails the moment the user clicks Resume.
 */
export function computeNextSendTime(prevSentAt: Date, delayDays: number): Date {
  return new Date(prevSentAt.getTime() + delayDays * 24 * 60 * 60*1000);
}
