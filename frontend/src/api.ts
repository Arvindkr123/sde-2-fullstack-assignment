const BASE = '/api';

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string): void {
  localStorage.setItem('token', token);
}

export function clearToken(): void {
  localStorage.removeItem('token');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Sequence {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  mailbox_id: number;
  mailbox_email: string;
}

export interface Step {
  id: number;
  step_order: number;
  delay_days: number;
  subject: string;
  body: string;
}

export interface Prospect {
  id: number;
  email: string;
  name: string | null;
  status: 'active' | 'unsubscribed' | 'bounced';
}

export interface SequenceDetail extends Sequence {
  steps: Step[];
  prospects: Prospect[];
}

export interface Mailbox {
  id: number;
  email: string;
  daily_limit: number;
  hourly_limit: number;
}

export interface ScheduledEmail {
  id: number;
  sequence_id: number;
  step_id: number;
  prospect_id: number;
  mailbox_id: number;
  scheduled_at: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

export interface SendLog {
  id: number;
  scheduled_email_id: number;
  status: string;
  message: string | null;
  created_at: string;
  prospect_id: number;
  step_id: number;
  prospect_email: string;
  prospect_name: string | null;
  step_subject: string;
  step_order: number;
  mailbox_email: string;
}

export interface QuotaSnapshot {
  mailboxId: number;
  email: string;
  daily: { used: number; limit: number };
  hourly: { used: number; limit: number };
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: { id: number; email: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string) =>
    request<{ token: string; user: { id: number; email: string } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  getSequences: () => request<Sequence[]>('/sequences'),

  getSequence: (id: number) =>
    request<SequenceDetail>(`/sequences/${id}`),

  createSequence: (name: string, mailboxId: number) =>
    request<{ id: number }>('/sequences', {
      method: 'POST',
      body: JSON.stringify({ name, mailbox_id: mailboxId }),
    }),

  scheduleSequence: (id: number) =>
    request<{ scheduled: number; skipped: number }>(`/sequences/${id}/schedule`, {
      method: 'POST',
    }),

  pauseSequence: (id: number) =>
    request<{ ok: boolean }>(`/sequences/${id}/pause`, { method: 'POST' }),

  resumeSequence: (id: number) =>
    request<{ ok: boolean; scheduled?: number; skipped?: number }>(`/sequences/${id}/resume`, {
      method: 'POST',
    }),

  addStep: (seqId: number, step: { step_order: number; delay_days: number; subject: string; body: string }) =>
    request<{ id: number; autoScheduled: { scheduled: number; skipped: number } | null }>(`/sequences/${seqId}/steps`, {
      method: 'POST',
      body: JSON.stringify(step),
    }),

  addProspect: (seqId: number, prospect: { email: string; name?: string }) =>
    request<{ id: number }>(`/sequences/${seqId}/prospects`, {
      method: 'POST',
      body: JSON.stringify(prospect),
    }),

  updateProspect: (seqId: number, pid: number, status: Prospect['status']) =>
    request<{ ok: boolean }>(`/sequences/${seqId}/prospects/${pid}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  deleteProspect: (seqId: number, pid: number) =>
    request<{ ok: boolean }>(`/sequences/${seqId}/prospects/${pid}`, {
      method: 'DELETE',
    }),

  getScheduledEmails: (seqId: number) =>
    request<ScheduledEmail[]>(`/sequences/${seqId}/scheduled-emails`),

  getLogs: (seqId: number, limit = 200) =>
    request<SendLog[]>(`/sequences/${seqId}/logs?limit=${limit}`),

  getMailboxes: () => request<Mailbox[]>('/mailboxes'),

  createMailbox: (email: string, dailyLimit: number, hourlyLimit: number) =>
    request<{ id: number }>('/mailboxes', {
      method: 'POST',
      body: JSON.stringify({ email, daily_limit: dailyLimit, hourly_limit: hourlyLimit }),
    }),

  getMailboxQuota: (id: number) =>
    request<QuotaSnapshot>(`/mailboxes/${id}/quota`),
};
