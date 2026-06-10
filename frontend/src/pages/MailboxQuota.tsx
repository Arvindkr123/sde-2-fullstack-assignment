import { useState, useEffect, useCallback, FormEvent } from 'react';
import { api, type Mailbox, type QuotaSnapshot } from '../api';

const REFRESH_INTERVAL_MS = 30_000;

interface MailboxWithQuota {
  mailbox: Mailbox;
  quota: QuotaSnapshot | null;
  error?: string;
}

function QuotaBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isWarn = pct >= 80 && pct < 100;
  const isCrit = pct >= 100;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          {(isWarn || isCrit) && (
            <span className="quota-warn-icon" title={isCrit ? 'Limit reached' : 'Near limit'}>
              {isCrit ? '🔴' : '⚠️'}
            </span>
          )}
          <span style={{ color: isCrit ? 'var(--danger)' : isWarn ? 'var(--warning)' : 'var(--text-muted)' }}>
            {used} / {limit}
          </span>
        </span>
      </div>
      <div className="quota-bar-bg">
        <div
          className={`quota-bar-fill${isWarn ? ' warn' : isCrit ? ' crit' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function MailboxQuota() {
  const [items, setItems] = useState<MailboxWithQuota[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState('');

  // Create mailbox form state
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDailyLimit, setNewDailyLimit] = useState('100');
  const [newHourlyLimit, setNewHourlyLimit] = useState('10');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const load = useCallback(async () => {
    try {
      const mailboxes = await api.getMailboxes();
      const results = await Promise.all(
        mailboxes.map(async (mb): Promise<MailboxWithQuota> => {
          try {
            const quota = await api.getMailboxQuota(mb.id);
            return { mailbox: mb, quota };
          } catch (err) {
            return { mailbox: mb, quota: null, error: (err as Error).message };
          }
        }),
      );
      setItems(results);
      setLastRefreshed(new Date());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const daily = parseInt(newDailyLimit, 10);
    const hourly = parseInt(newHourlyLimit, 10);
    if (!newEmail.trim() || isNaN(daily) || isNaN(hourly) || daily < 1 || hourly < 1) {
      setCreateError('Fill in all fields with valid positive numbers.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      await api.createMailbox(newEmail.trim(), daily, hourly);
      setNewEmail('');
      setNewDailyLimit('100');
      setNewHourlyLimit('10');
      setShowForm(false);
      await load();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const anyNearLimit = items.some(({ quota }) => {
    if (!quota) return false;
    return quota.daily.used / quota.daily.limit >= 0.8
        || quota.hourly.used / quota.hourly.limit >= 0.8;
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Mailboxes
            {anyNearLimit && <span style={{ marginLeft: 8, fontSize: 16 }}>⚠️</span>}
          </h1>
          {lastRefreshed && (
            <div className="refresh-note" style={{ marginTop: 4 }}>
              Last refreshed {lastRefreshed.toLocaleTimeString()} · quota auto-refreshes every 30 s
            </div>
          )}
        </div>
        <div className="row-actions">
          <button className="btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={() => { setShowForm(v => !v); setCreateError(''); }}
          >
            {showForm ? 'Cancel' : '+ Add Mailbox'}
          </button>
        </div>
      </div>

      {/* Add Mailbox form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>New Mailbox</div>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Email address
                </label>
                <input
                  type="email"
                  placeholder="sender@yourdomain.com"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div style={{ flex: '0 0 120px' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Daily limit
                </label>
                <input
                  type="number"
                  min={1}
                  value={newDailyLimit}
                  onChange={e => setNewDailyLimit(e.target.value)}
                  required
                />
              </div>
              <div style={{ flex: '0 0 120px' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Hourly limit
                </label>
                <input
                  type="number"
                  min={1}
                  value={newHourlyLimit}
                  onChange={e => setNewHourlyLimit(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={creating}
                style={{ flexShrink: 0, alignSelf: 'flex-end' }}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
            {createError && <div className="error-msg" style={{ marginTop: 10 }}>{createError}</div>}
          </form>
        </div>
      )}

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}

      {loading && items.length === 0 ? (
        <div className="empty-msg">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty-msg">
          No mailboxes yet. Click <strong>+ Add Mailbox</strong> to create one.
        </div>
      ) : (
        <div className="mailbox-grid">
          {items.map(({ mailbox, quota, error: qErr }) => (
            <div className="card" key={mailbox.id}>
              <div className="card-header">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{mailbox.email}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Mailbox #{mailbox.id} · limits: {mailbox.daily_limit}/day · {mailbox.hourly_limit}/hr
                  </div>
                </div>
              </div>

              {qErr ? (
                <div className="error-msg">Failed to load quota: {qErr}</div>
              ) : quota ? (
                <>
                  <QuotaBar label="Daily"  used={quota.daily.used}  limit={quota.daily.limit} />
                  <QuotaBar label="Hourly" used={quota.hourly.used} limit={quota.hourly.limit} />
                </>
              ) : (
                <div className="empty-msg">No quota data.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
