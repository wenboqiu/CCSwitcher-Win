/**
 * Usage + cost stats computed directly from ~/.claude/projects/*.jsonl.
 *
 * Claude Code no longer writes ~/.claude/stats-cache.json on Windows, so we
 * derive everything ourselves from the raw session transcripts — the same files
 * ccusage reads. Each assistant turn is one "message"; tool_use blocks are tool
 * calls; distinct sessionIds active on a day are sessions; token usage feeds the
 * ccusage-aligned cost in pricing.ts.
 *
 * Parsing 100+ MB of JSONL on every IPC call would be too slow, so files are
 * cached by (mtime, size): only new/changed files are re-parsed, deleted files
 * are evicted. The first call pays the full parse cost (~1–2s); later calls are
 * near-instant unless sessions changed on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import os from 'os';
import type { UsageSummary, DailyActivity, CostSummary, DailyCost } from '../../shared/types';
import { getPricing, costForRow } from './pricing';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** One deduplicated assistant turn. */
interface Row {
  hash: string | null; // message.id:requestId — null means "never dedup" (kept as-is)
  date: string;        // local yyyy-MM-dd of timestamp
  sid: string;
  model: string;
  fast: boolean;
  tools: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheCreate1h: number;
  cacheRead: number;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  rows: Row[];
}

const cache = new Map<string, FileEntry>();

// ── Public API ───────────────────────────────────────────────────────────────

export function getUsageSummary(): UsageSummary {
  if (!existsSync(PROJECTS_DIR)) return emptyUsage();
  const rows = allRows();

  const msgByDate = new Map<string, number>();
  const toolByDate = new Map<string, number>();
  const sessByDate = new Map<string, Set<string>>();
  const allSessions = new Set<string>();

  for (const r of rows) {
    msgByDate.set(r.date, (msgByDate.get(r.date) ?? 0) + 1);
    toolByDate.set(r.date, (toolByDate.get(r.date) ?? 0) + r.tools);
    if (r.sid) {
      let set = sessByDate.get(r.date);
      if (!set) { set = new Set(); sessByDate.set(r.date, set); }
      set.add(r.sid);
      allSessions.add(r.sid);
    }
  }

  const activities: DailyActivity[] = [...msgByDate.keys()].map((date) => ({
    date,
    messageCount: msgByDate.get(date) ?? 0,
    sessionCount: sessByDate.get(date)?.size ?? 0,
    toolCallCount: toolByDate.get(date) ?? 0,
  }));

  const { today, todayStr, weekAgo } = window7();
  const todayEntry = activities.find((a) => a.date === todayStr);
  const weekly = activities.filter((a) => inRange(a.date, weekAgo, today));

  return {
    weeklyMessages: sum(weekly, 'messageCount'),
    weeklySessionCount: sum(weekly, 'sessionCount'),
    weeklyToolCalls: sum(weekly, 'toolCallCount'),
    todayMessages: todayEntry?.messageCount ?? 0,
    todaySessionCount: todayEntry?.sessionCount ?? 0,
    todayToolCalls: todayEntry?.toolCallCount ?? 0,
    totalMessages: rows.length,
    totalSessions: allSessions.size,
    dailyActivity: activities
      .filter((a) => inRange(a.date, weekAgo, null))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getCostSummary(): Promise<CostSummary> {
  if (!existsSync(PROJECTS_DIR)) return emptyCost(true);
  const pricing = await getPricing();
  if (!pricing) return emptyCost(false);

  const rows = allRows();
  const byDate = new Map<string, DailyCost>();
  let totalCost = 0;

  for (const r of rows) {
    const cost = costForRow(r, pricing);
    totalCost += cost;
    let dc = byDate.get(r.date);
    if (!dc) {
      dc = { date: r.date, costUSD: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      byDate.set(r.date, dc);
    }
    dc.costUSD += cost;
    dc.inputTokens += r.input;
    dc.outputTokens += r.output;
    dc.cacheCreationTokens += r.cacheCreate;
    dc.cacheReadTokens += r.cacheRead;
  }

  const { today, todayStr, weekAgo } = window7();
  const todayDc = byDate.get(todayStr);
  let weekCost = 0;
  for (const dc of byDate.values()) {
    if (inRange(dc.date, weekAgo, today)) weekCost += dc.costUSD;
  }

  const todayTokens = todayDc
    ? todayDc.inputTokens + todayDc.outputTokens + todayDc.cacheCreationTokens + todayDc.cacheReadTokens
    : 0;

  return {
    pricingAvailable: true,
    todayCost: todayDc?.costUSD ?? 0,
    weekCost,
    totalCost,
    todayTokens,
    dailyCost: [...byDate.values()]
      .filter((dc) => inRange(dc.date, weekAgo, null))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ── Cache + parsing ──────────────────────────────────────────────────────────

/** Refresh the file cache, then return globally-deduped rows (max output wins). */
function allRows(): Row[] {
  refreshCache();

  // ccusage dedups globally on message.id:requestId, keeping the copy with the
  // largest output_tokens (the final streaming write). Duplicates almost always
  // sit in one file, but a hash can recur across files on session resume — dedup
  // globally here so those don't double-count.
  const winners = new Map<string, Row>();
  const out: Row[] = [];
  for (const entry of cache.values()) {
    for (const r of entry.rows) {
      if (r.hash === null) { out.push(r); continue; }
      const cur = winners.get(r.hash);
      if (!cur || r.output > cur.output) winners.set(r.hash, r);
    }
  }
  for (const r of winners.values()) out.push(r);
  return out;
}

function refreshCache(): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(PROJECTS_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }

  const seen = new Set<string>();
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
    // Node ≥20 exposes parentPath; fall back to the legacy `path` field.
    const dir = (d as Dirent & { parentPath?: string; path?: string }).parentPath
      ?? (d as Dirent & { path?: string }).path
      ?? PROJECTS_DIR;
    const fp = path.join(dir, d.name);
    seen.add(fp);

    let st;
    try { st = statSync(fp); } catch { continue; }

    const cached = cache.get(fp);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;

    cache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, rows: parseFile(fp) });
  }

  for (const fp of [...cache.keys()]) {
    if (!seen.has(fp)) cache.delete(fp);
  }
}

interface AssistantEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number };
      speed?: string;
    };
  };
}

function parseFile(fp: string): Row[] {
  let content: string;
  try { content = readFileSync(fp, 'utf8'); } catch { return []; }

  // One logical turn is written as several lines sharing message.id:requestId
  // (streaming partials); only output_tokens grows across copies. Collapse by
  // key, keeping the largest-output copy — same rule ccusage uses, and that copy
  // also carries the complete tool_use blocks.
  const byKey = new Map<string, Row>();
  let synthetic = 0;

  for (const line of content.split('\n')) {
    if (line.length < 2 || !line.includes('"assistant"')) continue;

    let d: AssistantEntry;
    try { d = JSON.parse(line) as AssistantEntry; } catch { continue; }
    if (d.type !== 'assistant' || !d.message) continue;

    const date = localDate(d.timestamp);
    if (!date) continue;

    const msg = d.message;
    // ccusage filters out <synthetic> rows (local error/placeholder turns that
    // were never billed) — skip them so counts and cost both stay aligned.
    if (msg.model === '<synthetic>') continue;
    const u = msg.usage ?? {};
    const speed = u.speed;

    let tools = 0;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') tools++;
      }
    }

    const hasId = !!msg.id && !!d.requestId;
    const key = hasId ? `${msg.id}:${d.requestId}` : `__syn${synthetic++}`;

    const row: Row = {
      hash: hasId ? key : null,
      date,
      sid: d.sessionId ?? '',
      model: msg.model ?? 'unknown',
      fast: speed === 'fast',
      tools,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
      cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };

    const existing = byKey.get(key);
    if (!existing || row.output > existing.output) byKey.set(key, row);
  }

  return [...byKey.values()];
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/** ISO timestamp → local yyyy-MM-dd, or null if unparseable. */
function localDate(ts: string | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return formatDate(d);
}

/** Today (local) and the start of the trailing 7-day window. */
function window7(): { today: Date; todayStr: string; weekAgo: Date } {
  const today = startOfDay(new Date());
  return { today, todayStr: formatDate(today), weekAgo: addDays(today, -7) };
}

/** Is `dateStr` within [from, to]? `to === null` means open-ended. */
function inRange(dateStr: string, from: Date, to: Date | null): boolean {
  const d = parseDate(dateStr);
  if (d === null) return false;
  return d >= from && (to === null || d <= to);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Local yyyy-MM-dd (not UTC — must agree with localDate above). */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(s: string): Date | null {
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : startOfDay(d);
}

function sum<K extends string>(arr: Record<K, number>[], key: K): number {
  return arr.reduce((acc, a) => acc + (a[key] ?? 0), 0);
}

function emptyUsage(): UsageSummary {
  return {
    weeklyMessages: 0, weeklySessionCount: 0, weeklyToolCalls: 0,
    todayMessages: 0, todaySessionCount: 0, todayToolCalls: 0,
    totalMessages: 0, totalSessions: 0, dailyActivity: [],
  };
}

function emptyCost(pricingAvailable: boolean): CostSummary {
  return { pricingAvailable, todayCost: 0, weekCost: 0, totalCost: 0, todayTokens: 0, dailyCost: [] };
}
