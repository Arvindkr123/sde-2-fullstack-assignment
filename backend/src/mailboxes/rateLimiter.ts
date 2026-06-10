import { redis } from '../config/redis';
import { pool } from '../config/db';
import type { RowDataPacket } from 'mysql2';

export interface Mailbox {
  id: number;
  user_id: number;
  email: string;
  daily_limit: number;
  hourly_limit: number;
}

export type LimitReason = 'daily' | 'hourly';
export type CheckResult =
  | { allowed: true }
  | { allowed: false; reason: LimitReason };

function dayKey(mailboxId: number, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `rl:daily:${mailboxId}:${y}-${m}-${d}`;
}

function hourKey(mailboxId: number, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return `rl:hourly:${mailboxId}:${y}-${m}-${d}T${h}`;
}

export async function getMailbox(mailboxId: number): Promise<Mailbox | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, user_id, email, daily_limit, hourly_limit FROM mailboxes WHERE id = ?',
    [mailboxId],
  );
  return (rows[0] as Mailbox) ?? null;
}

// Atomic check-and-increment via Lua script. Reads both counters, checks limits,
// and increments only if both are under limit — all in a single Redis round-trip.
// This eliminates the TOCTOU race that a read-then-write sequence would have under
// concurrent worker processes.
const CHECK_AND_INCREMENT = `
local dRaw = redis.call('GET', KEYS[1])
local hRaw = redis.call('GET', KEYS[2])
local dCount = dRaw and tonumber(dRaw) or 0
local hCount = hRaw and tonumber(hRaw) or 0
local dLimit = tonumber(ARGV[1])
local hLimit = tonumber(ARGV[2])

if dCount >= dLimit then return 'daily' end
if hCount >= hLimit then return 'hourly' end

local newD = redis.call('INCR', KEYS[1])
if newD == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
local newH = redis.call('INCR', KEYS[2])
if newH == 1 then redis.call('EXPIRE', KEYS[2], 3600) end

return 'ok'
`;

/**
 * Check whether the mailbox can send another email right now, and if so,
 * increment the counter. Returns { allowed: false } when a limit would be
 * crossed. Atomically safe under concurrent workers.
 */
export async function checkAndIncrement(mailboxId: number): Promise<CheckResult> {
  const mailbox = await getMailbox(mailboxId);
  if (!mailbox) return { allowed: false, reason: 'daily' };

  const dKey = dayKey(mailboxId);
  const hKey = hourKey(mailboxId);

  const result = (await redis.eval(
    CHECK_AND_INCREMENT,
    2,
    dKey,
    hKey,
    String(mailbox.daily_limit),
    String(mailbox.hourly_limit),
  )) as string;

  if (result === 'daily') return { allowed: false, reason: 'daily' };
  if (result === 'hourly') return { allowed: false, reason: 'hourly' };
  return { allowed: true };
}

export interface QuotaSnapshot {
  mailboxId: number;
  email: string;
  daily: { used: number; limit: number };
  hourly: { used: number; limit: number };
}

export async function readQuota(mailboxId: number): Promise<QuotaSnapshot | null> {
  const mailbox = await getMailbox(mailboxId);
  if (!mailbox) return null;

  const dKey = dayKey(mailboxId);
  const hKey = hourKey(mailboxId);

  let dailyRaw = await redis.get(dKey);
  if (dailyRaw === null) {
    // Initialise with TTL so Redis cleans up automatically at day rollover.
    await redis.set(dKey, '0', 'EX', 86400);
    dailyRaw = '0';
  }
  let hourlyRaw = await redis.get(hKey);
  if (hourlyRaw === null) {
    await redis.set(hKey, '0', 'EX', 3600);
    hourlyRaw = '0';
  }

  return {
    mailboxId,
    email: mailbox.email,
    daily: { used: parseInt(dailyRaw, 10), limit: mailbox.daily_limit },
    hourly: { used: parseInt(hourlyRaw, 10), limit: mailbox.hourly_limit },
  };
}

/**
 * Approximate remaining budget for a mailbox in a given window. Used by the
 * resume code path to decide how many sends to schedule "today".
 */
export async function remainingBudget(mailboxId: number): Promise<{
  daily: number;
  hourly: number;
} | null> {
  const snapshot = await readQuota(mailboxId);
  if (!snapshot) return null;
  return {
    daily: Math.max(0, snapshot.daily.limit - snapshot.daily.used),
    hourly: Math.max(0, snapshot.hourly.limit - snapshot.hourly.used),
  };
}
