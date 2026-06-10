import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Sequence } from '../api';

function StatusBadge({ status }: { status: Sequence['status'] }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export default function Sequences() {
  const navigate = useNavigate();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getSequences();
      setSequences(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createSequence() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createSequence(newName.trim());
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
        // Backend scheduled nothing — sequence has no active prospects or steps.
        // Navigate to the detail page so the user can add them.
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

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Sequences</h1>
      </div>

      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 24 }}>
        <input
          placeholder="New sequence name…"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createSequence()}
          style={{ flex: 1 }}
        />
        <button className="btn-primary" onClick={createSequence} disabled={creating || !newName.trim()}>
          {creating ? 'Creating…' : '+ New'}
        </button>
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
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>#{seq.id}</div>
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
