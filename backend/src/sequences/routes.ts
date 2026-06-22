import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/db';
import { requireAuth, AuthedRequest } from '../auth/middleware';
import {
  getSequenceForUser,
  listSequencesForUser,
  createSequence,
  getSteps,
  getProspects,
  addProspect,
  updateProspectStatus,
  deleteProspect,
  setSequenceStatus,
} from './service';
import { scheduleSequence, resumeSequence, cancelDelayedJobs, scheduleStepForExistingProspects } from './scheduler';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: AuthedRequest, res) => {
  const sequences = await listSequencesForUser(req.userId!);
  res.json(sequences);
});

router.post('/', async (req: AuthedRequest, res) => {
  const parsed = z.object({
    name: z.string().min(1),
    mailbox_id: z.number().int().positive(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  // Verify the mailbox belongs to this user
  const [mbRows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM mailboxes WHERE id = ? AND user_id = ? LIMIT 1',
    [parsed.data.mailbox_id, req.userId!],
  );
  if (mbRows.length === 0) return res.status(400).json({ error: 'invalid_mailbox' });

  const id = await createSequence(req.userId!, parsed.data.name, parsed.data.mailbox_id);
  res.status(201).json({ id });
});

router.get('/:id', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const [steps, prospects] = await Promise.all([
    getSteps(seq.id),
    getProspects(seq.id),
  ]);
  res.json({ ...seq, steps, prospects });
});

router.get('/:id/steps', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  res.json(await getSteps(seq.id));
});

const stepSchema = z.object({
  step_order: z.number().int().positive(),
  delay_days: z.number().int().min(0),
  subject: z.string().min(1),
  body: z.string().min(1),
});

router.post('/:id/steps', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { step_order, delay_days, subject, body } = parsed.data;
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO sequence_steps (sequence_id, step_order, delay_days, subject, body) VALUES (?, ?, ?, ?, ?)',
      [seq.id, step_order, delay_days, subject, body],
    );
    const stepId = result.insertId;

    let autoScheduled: { scheduled: number; skipped: number } | null = null;
    if (seq.status === 'active') {
      autoScheduled = await scheduleStepForExistingProspects({
        sequenceId: seq.id,
        stepId,
        delayDays: delay_days,
      });
    }

    res.status(201).json({ id: stepId, autoScheduled });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'step_order_conflict', message: `step_order ${step_order} already exists in this sequence` });
    }
    throw err;
  }
});

const prospectSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
});

router.get('/:id/prospects', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  res.json(await getProspects(seq.id));
});

router.post('/:id/prospects', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const parsed = prospectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const id = await addProspect(seq.id, parsed.data.email, parsed.data.name ?? null);

  let autoScheduled: { scheduled: number; skipped: number } | null = null;
  if (seq.status === 'active') {
    // scheduleSequence skips prospects already in scheduled_emails, so only
    // the newly added prospect gets queued here.
    autoScheduled = await scheduleSequence({ sequenceId: seq.id });
  }

  res.status(201).json({ id, autoScheduled });
});

router.patch('/:id/prospects/:pid', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const parsed = z.object({ status: z.enum(['active', 'unsubscribed', 'bounced']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const updated = await updateProspectStatus(Number(req.params.pid), seq.id, parsed.data.status);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.delete('/:id/prospects/:pid', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const deleted = await deleteProspect(Number(req.params.pid), seq.id);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.get('/:id/scheduled-emails', async (req: AuthedRequest, res, next) => {
  try {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, sequence_id, step_id, prospect_id, mailbox_id, scheduled_at, status, attempts, last_error, sent_at
         FROM scheduled_emails
        WHERE sequence_id = ?
        ORDER BY scheduled_at ASC, id ASC
        LIMIT ? OFFSET ?`,
      [seq.id, limit, offset],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/logs', async (req: AuthedRequest, res, next) => {
  try {
    const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
    if (!seq) return res.status(404).json({ error: 'not_found' });
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 500);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT sl.id, sl.scheduled_email_id, sl.status, sl.message, sl.created_at,
              se.prospect_id, se.step_id,
              p.email  AS prospect_email,
              p.name   AS prospect_name,
              st.subject AS step_subject,
              st.step_order,
              m.email  AS mailbox_email
         FROM send_logs sl
         JOIN scheduled_emails se ON se.id = sl.scheduled_email_id
         JOIN prospects p         ON p.id  = se.prospect_id
         JOIN sequence_steps st   ON st.id = se.step_id
         JOIN mailboxes m         ON m.id  = sl.mailbox_id
        WHERE se.sequence_id = ?
        ORDER BY sl.created_at DESC
        LIMIT ? OFFSET ?`,
      [seq.id, limit, offset],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/schedule', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  const result = await scheduleSequence({ sequenceId: seq.id });
  res.json(result);
});

router.post('/:id/pause', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  if (seq.status === 'paused') return res.json({ ok: true, alreadyPaused: true });

  await setSequenceStatus(seq.id, 'paused');
  const cancelled = await cancelDelayedJobs(seq.id);
  res.json({ ok: true, cancelled });
});

router.post('/:id/resume', async (req: AuthedRequest, res) => {
  const seq = await getSequenceForUser(Number(req.params.id), req.userId!);
  if (!seq) return res.status(404).json({ error: 'not_found' });
  if (seq.status !== 'paused') return res.json({ ok: true, alreadyActive: true });

  await setSequenceStatus(seq.id, 'active');
  const result = await resumeSequence(seq.id);
  res.json({ ok: true, ...result });
});

// Used by the sequence-detail panel to refresh a single email's status.
const scheduledEmailRouter = Router();
scheduledEmailRouter.use(requireAuth);

scheduledEmailRouter.get('/:id', async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, sequence_id, step_id, prospect_id, mailbox_id, scheduled_at,
            status, attempts, last_error, sent_at
       FROM scheduled_emails
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

export { scheduledEmailRouter };
export default router;
