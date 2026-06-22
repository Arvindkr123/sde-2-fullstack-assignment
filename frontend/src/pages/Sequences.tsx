import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Sequence, type Mailbox } from '../api';

function StatusBadge({ status }: { status: Sequence['status'] }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export default function Sequences() {
  const navigate = useNavigate();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newMailboxId, setNewMailboxId] = useState<number | ''>('');
  const [creating, setCreating] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [seqs, mbs] = await Promise.all([api.getSequences(), api.getMailboxes()]);
      setSequences(seqs);
      setMailboxes(mbs);
      if (mbs.length > 0 && newMailboxId === '') {
        setNewMailboxId(mbs[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  async function createSequence() {
    if (!newName.trim() || newMailboxId === '') return;
    setCreating(true);
    try {
      await api.createSequence(newName.trim(), newMailboxId as number);
      setNewName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function schedule(id: number) {
    setActionLoading(id);
    try {
      const result = await api.scheduleSequence(id);
      if (result.scheduled === 0) {
        navigate(`/sequences/${id}`, {
          state: { hint: 'Please add at least one prospect and one step, then click Schedule.' },
        });
        return;
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  }

  async function pause(id: number) {
    setActionLoading(id);
    try {
      await api.pauseSequence(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  }

  async function resume(id: number) {
    setActionLoading(id);
    try {
      await api.resumeSequence(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  }

  const canCreate = newName.trim().length > 0 && newMailboxId !== '';

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Sequences</h1>
      </div>

      {/* ── Create form ── */}
      <div className="card" style={{ marginBottom: 24 }}>
        {mailboxes.length === 0 && !loading ? (
          <div style={{ fontSize: 13, color: 'var(--warning)' }}>
            You need at least one mailbox before creating a sequence.{' '}
            <Link to="/quota">Add a mailbox →</Link>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Sequence name
              </label>
              <input
                placeholder="New sequence name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && canCreate && createSequence()}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                Send from mailbox
              </label>
              <select
                value={newMailboxId}
                onChange={e => setNewMailboxId(Number(e.target.value))}
                style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 14 }}
              >
                {mailboxes.map(mb => (
                  <option key={mb.id} value={mb.id}>{mb.email}</option>
                ))}
              </select>
            </div>
            <button
              className="btn-primary"
              onClick={createSequence}
              disabled={creating || !canCreate}
              style={{ flexShrink: 0 }}
            >
              {creating ? 'Creating…' : '+ New'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="empty-msg">Loading…</div>
      ) : sequences.length === 0 ? (
        <div className="empty-msg">No sequences yet. Create one above.</div>
      ) : (
        sequences.map(seq => (
          <div className="card" key={seq.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Link to={`/sequences/${seq.id}`} style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}>
                <div style={{ fontWeight: 600 }}>{seq.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  #{seq.id} · {seq.mailbox_email}
                </div>
              </Link>
              <StatusBadge status={seq.status} />
              <div className="row-actions">
                {seq.status === 'draft' && (
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => schedule(seq.id)}
                    disabled={actionLoading === seq.id}
                  >
                    Schedule
                  </button>
                )}
                {seq.status === 'active' && (
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => pause(seq.id)}
                    disabled={actionLoading === seq.id}
                  >
                    Pause
                  </button>
                )}
                {seq.status === 'paused' && (
                  <button
                    className="btn-primary btn-sm"
                    onClick={() => resume(seq.id)}
                    disabled={actionLoading === seq.id}
                  >
                    Resume
                  </button>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
