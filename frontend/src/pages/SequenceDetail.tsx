import { useState, useEffect, useCallback, useRef, FormEvent } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { api, type SequenceDetail as SeqDetail, type Prospect, type ScheduledEmail, type SendLog } from '../api';

const SE_STATUS_COLOR: Record<ScheduledEmail['status'], string> = {
  pending:    '#f1f5f9',
  processing: '#dbeafe',
  sent:       '#dcfce7',
  failed:     '#fee2e2',
  skipped:    '#f1f5f9',
};
const SE_STATUS_TEXT: Record<ScheduledEmail['status'], string> = {
  pending:    '#475569',
  processing: '#1d4ed8',
  sent:       '#15803d',
  failed:     '#dc2626',
  skipped:    '#94a3b8',
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function SEStatusBadge({ status }: { status: ScheduledEmail['status'] }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 11,
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 999,
      background: SE_STATUS_COLOR[status],
      color: SE_STATUS_TEXT[status],
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
    }}>
      {status}
    </span>
  );
}

function fmt(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function SequenceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const seqId = Number(id);

  const navHint = (location.state as { hint?: string } | null)?.hint ?? '';

  const [seq, setSeq] = useState<SeqDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const [stepOrder, setStepOrder] = useState('');
  const [stepDelay, setStepDelay] = useState('0');
  const [stepSubject, setStepSubject] = useState('');
  const [stepBody, setStepBody] = useState('');
  const [addingStep, setAddingStep] = useState(false);
  const [stepScheduleMsg, setStepScheduleMsg] = useState('');

  const [prospectEmail, setProspectEmail] = useState('');
  const [prospectName, setProspectName] = useState('');
  const [addingProspect, setAddingProspect] = useState(false);

  const [emails, setEmails] = useState<ScheduledEmail[]>([]);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [logs, setLogs] = useState<SendLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getSequence(seqId);
      setSeq(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [seqId]);

  const loadEmails = useCallback(async () => {
    setEmailsLoading(true);
    try {
      const res = await api.getScheduledEmails(seqId);
      setEmails(res);
    } catch {
      // non-fatal
    } finally {
      setEmailsLoading(false);
    }
  }, [seqId]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await api.getLogs(seqId);
      setLogs(res);
    } catch {
      // non-fatal
    } finally {
      setLogsLoading(false);
    }
  }, [seqId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadEmails(); }, [loadEmails]);
  useEffect(() => { void loadLogs(); }, [loadLogs]);

  useEffect(() => {
    if (!seq) return;
    if (seq.status === 'active') {
      pollRef.current = setInterval(() => void loadEmails(), 8000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [seq?.status, loadEmails]);

  async function handleSchedule() {
    setActionLoading(true);
    try { await api.scheduleSequence(seqId); await Promise.all([load(), loadEmails(), loadLogs()]); }
    catch (err) { setError((err as Error).message); }
    finally { setActionLoading(false); }
  }

  async function handlePause() {
    setActionLoading(true);
    try { await api.pauseSequence(seqId); await Promise.all([load(), loadEmails(), loadLogs()]); }
    catch (err) { setError((err as Error).message); }
    finally { setActionLoading(false); }
  }

  async function handleResume() {
    setActionLoading(true);
    try { await api.resumeSequence(seqId); await Promise.all([load(), loadEmails(), loadLogs()]); }
    catch (err) { setError((err as Error).message); }
    finally { setActionLoading(false); }
  }

  async function handleAddStep(e: FormEvent) {
    e.preventDefault();
    const order = parseInt(stepOrder, 10);
    const delay = parseInt(stepDelay, 10);
    if (!stepSubject.trim() || !stepBody.trim() || isNaN(order) || isNaN(delay)) return;
    setAddingStep(true);
    setStepScheduleMsg('');
    try {
      const result = await api.addStep(seqId, { step_order: order, delay_days: delay, subject: stepSubject.trim(), body: stepBody.trim() });
      setStepOrder(''); setStepDelay('0'); setStepSubject(''); setStepBody('');
      if (result.autoScheduled && result.autoScheduled.scheduled > 0) {
        const { scheduled } = result.autoScheduled;
        setStepScheduleMsg(`Step added and auto-scheduled for ${scheduled} existing prospect${scheduled !== 1 ? 's' : ''}.`);
      }
      await Promise.all([load(), loadEmails()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingStep(false);
    }
  }

  async function handleAddProspect(e: FormEvent) {
    e.preventDefault();
    if (!prospectEmail.trim()) return;
    setAddingProspect(true);
    try {
      await api.addProspect(seqId, { email: prospectEmail.trim(), name: prospectName.trim() || undefined });
      setProspectEmail(''); setProspectName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingProspect(false);
    }
  }

  async function handleProspectStatus(pid: number, status: Prospect['status']) {
    try { await api.updateProspect(seqId, pid, status); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  async function handleDeleteProspect(pid: number) {
    try { await api.deleteProspect(seqId, pid); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  if (loading) return <div className="page"><div className="empty-msg">Loading…</div></div>;
  if (!seq) return <div className="page"><div className="error-msg">{error || 'Not found'}</div></div>;

  const activeProspects = seq.prospects.filter(p => p.status === 'active').length;
  const canSchedule = seq.steps.length > 0 && activeProspects > 0;

  const scheduledProspectIds = new Set(emails.map(e => e.prospect_id));
  const newUnscheduledActive = seq.prospects.filter(
    p => p.status === 'active' && !scheduledProspectIds.has(p.id),
  ).length;
  const canScheduleNew = seq.steps.length > 0 && newUnscheduledActive > 0;

  const stepMap = Object.fromEntries(seq.steps.map(s => [s.id, s]));
  const prospectMap = Object.fromEntries(seq.prospects.map(p => [p.id, p]));

  const counts = { pending: 0, processing: 0, sent: 0, failed: 0, skipped: 0 };
  for (const e of emails) counts[e.status]++;

  return (
    <div className="page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="page-title">{seq.name}</h1>
            <StatusBadge status={seq.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Mailbox: <strong>{seq.mailbox_email}</strong>
          </div>
          <button className="btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => navigate('/sequences')}>
            ← Back
          </button>
        </div>

        <div className="row-actions">
          {seq.status === 'draft' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <button
                className="btn-primary"
                onClick={handleSchedule}
                disabled={actionLoading || !canSchedule}
                title={!canSchedule ? 'Add prospects and steps first' : undefined}
              >
                Schedule
              </button>
              {!canSchedule && (
                <span style={{ fontSize: 12, color: 'var(--warning)' }}>
                  {seq.steps.length === 0 && activeProspects === 0
                    ? 'Add steps and prospects first'
                    : seq.steps.length === 0
                    ? 'Add at least one step first'
                    : 'Add at least one prospect first'}
                </span>
              )}
            </div>
          )}
          {seq.status === 'active' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {canScheduleNew && (
                  <button className="btn-primary" onClick={handleSchedule} disabled={actionLoading}>
                    Schedule New
                  </button>
                )}
                <button className="btn-secondary" onClick={handlePause} disabled={actionLoading}>
                  Pause
                </button>
              </div>
              {canScheduleNew && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {newUnscheduledActive} new prospect{newUnscheduledActive !== 1 ? 's' : ''} ready to schedule
                </span>
              )}
            </div>
          )}
          {seq.status === 'paused' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {canScheduleNew && (
                  <button className="btn-secondary" onClick={handleSchedule} disabled={actionLoading}>
                    Schedule New
                  </button>
                )}
                <button className="btn-primary" onClick={handleResume} disabled={actionLoading}>
                  Resume
                </button>
              </div>
              {canScheduleNew && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {newUnscheduledActive} new prospect{newUnscheduledActive !== 1 ? 's' : ''} ready to schedule
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}
      {navHint && (
        <div style={{
          background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8,
          padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#92400e',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          ⚠️ {navHint}
        </div>
      )}

      {/* ── Steps ── */}
      <div>
        <div className="section-title">Steps ({seq.steps.length})</div>

        <form className="card" onSubmit={handleAddStep} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 70px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Order #</label>
              <input
                type="number" min={1}
                placeholder={String(seq.steps.length + 1)}
                value={stepOrder}
                onChange={e => setStepOrder(e.target.value)}
                required style={{ marginTop: 4 }}
              />
            </div>
            <div style={{ flex: '0 0 90px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Delay (days)</label>
              <input
                type="number" min={0}
                value={stepDelay}
                onChange={e => setStepDelay(e.target.value)}
                required style={{ marginTop: 4 }}
              />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Subject</label>
              <input
                type="text" placeholder="Email subject…"
                value={stepSubject}
                onChange={e => setStepSubject(e.target.value)}
                required style={{ marginTop: 4 }}
              />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Body</label>
            <textarea
              placeholder="Email body…"
              value={stepBody}
              onChange={e => setStepBody(e.target.value)}
              required rows={3}
              style={{ marginTop: 4, resize: 'vertical' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" className="btn-primary btn-sm" disabled={addingStep}>
              {addingStep ? 'Adding…' : '+ Add Step'}
            </button>
            {stepScheduleMsg && (
              <span style={{ fontSize: 12, color: '#15803d', background: '#dcfce7', border: '1px solid #86efac', borderRadius: 6, padding: '3px 10px' }}>
                {stepScheduleMsg}
              </span>
            )}
          </div>
        </form>

        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {seq.steps.length === 0 ? (
            <div className="empty-msg">No steps yet.</div>
          ) : (
            <table style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: 46 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: '30%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Delay</th>
                  <th>Subject</th>
                  <th>Body</th>
                </tr>
              </thead>
              <tbody>
                {seq.steps.map(step => (
                  <tr key={step.id}>
                    <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{step.step_order}</td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {step.delay_days === 0 ? 'Immediate' : `+${step.delay_days} day${step.delay_days !== 1 ? 's' : ''}`}
                    </td>
                    <td style={{ fontWeight: 500 }}>{step.subject}</td>
                    <td style={{ whiteSpace: 'pre-line', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      {step.body}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Prospects ── */}
      <div style={{ marginTop: 8 }}>
        <div className="section-title">Prospects ({seq.prospects.length})</div>

        <form className="card" onSubmit={handleAddProspect}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>Email</label>
            <input
              type="email" placeholder="email@example.com"
              value={prospectEmail}
              onChange={e => setProspectEmail(e.target.value)}
              required
            />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>Name (optional)</label>
            <input
              placeholder="Jane Doe"
              value={prospectName}
              onChange={e => setProspectName(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary btn-sm" disabled={addingProspect} style={{ flexShrink: 0 }}>
            {addingProspect ? 'Adding…' : '+ Add Prospect'}
          </button>
        </form>

        <div className="card" style={{ padding: 0 }}>
          {seq.prospects.length === 0 ? (
            <div className="empty-msg">No prospects yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Email / Name</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {seq.prospects.map(p => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name ? `${p.name} <${p.email}>` : p.email}
                    </td>
                    <td>
                      <select
                        value={p.status}
                        onChange={e => handleProspectStatus(p.id, e.target.value as Prospect['status'])}
                        style={{ fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text)' }}
                      >
                        <option value="active">active</option>
                        <option value="unsubscribed">unsubscribed</option>
                        <option value="bounced">bounced</option>
                      </select>
                    </td>
                    <td>
                      <button className="btn-danger btn-sm" onClick={() => handleDeleteProspect(p.id)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Scheduled Emails ── */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Scheduled Emails ({emails.length})
          </div>
          {emails.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              {(Object.entries(counts) as [ScheduledEmail['status'], number][])
                .filter(([, n]) => n > 0)
                .map(([s, n]) => (
                  <span key={s} style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px',
                    borderRadius: 999,
                    background: SE_STATUS_COLOR[s],
                    color: SE_STATUS_TEXT[s],
                  }}>
                    {n} {s}
                  </span>
                ))}
            </div>
          )}
          <span style={{ flex: 1 }} />
          {seq.status === 'active' && (
            <span className="refresh-note">auto-refreshing every 8 s</span>
          )}
          <button
            className="btn-secondary btn-sm"
            onClick={() => void loadEmails()}
            disabled={emailsLoading}
          >
            {emailsLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {seq.status === 'draft' && emails.length === 0 ? (
          <div className="card">
            <div className="empty-msg" style={{ padding: '16px 0' }}>
              No scheduled emails yet — click <strong>Schedule</strong> to queue this sequence.
            </div>
          </div>
        ) : emails.length === 0 ? (
          <div className="card">
            <div className="empty-msg" style={{ padding: '16px 0' }}>No scheduled emails.</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Prospect</th>
                  <th>Step</th>
                  <th>Scheduled at</th>
                  <th>Status</th>
                  <th>Sent at</th>
                  <th>Attempts</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {emails.map(e => {
                  const prospect = prospectMap[e.prospect_id];
                  const step = stepMap[e.step_id];
                  return (
                    <tr key={e.id}>
                      <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={prospect?.email}>
                        {prospect?.name ?? prospect?.email ?? `#${e.prospect_id}`}
                      </td>
                      <td title={step?.subject}>
                        {step ? `#${step.step_order} — ${step.subject.slice(0, 24)}${step.subject.length > 24 ? '…' : ''}` : `step ${e.step_id}`}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmt(e.scheduled_at)}</td>
                      <td><SEStatusBadge status={e.status} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmt(e.sent_at)}</td>
                      <td style={{ textAlign: 'center' }}>{e.attempts}</td>
                      <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--danger)', fontSize: 12 }}
                          title={e.last_error ?? ''}>
                        {e.last_error ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Send Logs ── */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div className="section-title" style={{ margin: 0 }}>Send Logs ({logs.length})</div>
          <span style={{ flex: 1 }} />
          <button className="btn-secondary btn-sm" onClick={() => void loadLogs()} disabled={logsLoading}>
            {logsLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {logs.length === 0 ? (
          <div className="card">
            <div className="empty-msg" style={{ padding: '16px 0' }}>No log entries yet.</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Prospect</th>
                  <th>Step</th>
                  <th>Mailbox</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 12 }}>
                      {fmt(log.created_at)}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-block', fontSize: 11, fontWeight: 600,
                        padding: '2px 8px', borderRadius: 999,
                        textTransform: 'uppercase', letterSpacing: '0.03em',
                        background: log.status === 'sent'         ? 'rgba(34,197,94,.15)'
                                  : log.status === 'failed'       ? 'rgba(239,68,68,.15)'
                                  : log.status === 'rate_limited' ? 'rgba(245,158,11,.15)'
                                  : 'rgba(148,163,184,.12)',
                        color: log.status === 'sent'         ? '#4ade80'
                             : log.status === 'failed'       ? 'var(--danger)'
                             : log.status === 'rate_limited' ? '#fbbf24'
                             : 'var(--text-muted)',
                      }}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={log.prospect_email}>
                      {log.prospect_name ?? log.prospect_email}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      #{log.step_order} — {log.step_subject.slice(0, 28)}{log.step_subject.length > 28 ? '…' : ''}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{log.mailbox_email}</td>
                    <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  color: log.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)' }}
                        title={log.message ?? ''}>
                      {log.message ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
