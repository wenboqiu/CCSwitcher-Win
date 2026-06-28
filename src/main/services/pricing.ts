/**
 * LiteLLM pricing + ccusage-aligned per-message cost.
 *
 * Ported from the macOS canonical re-parser (CCSwitcher/Tools/recalc_cost.swift),
 * which deliberately mirrors `ccusage daily`. If our numbers drift from ccusage,
 * the bug is almost always here — keep this in lock-step with recalc_cost.swift.
 *
 * Pricing comes from LiteLLM's model_prices_and_context_window.json, fetched
 * once an hour and cached on disk (same source ccusage uses at runtime).
 */

import https from 'https';
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import path from 'path';

const PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface ModelPricing {
  input: number;
  output: number;
  cacheCreate: number;
  cacheCreate1h: number | null; // 1-hour-TTL cache-write rate (above_1hr)
  cacheRead: number;
  inputAbove200k: number | null;
  outputAbove200k: number | null;
  cacheCreateAbove200k: number | null;
  cacheReadAbove200k: number | null;
  fastMultiplier: number | null;
}

export type PricingMap = Map<string, ModelPricing>;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'litellm-pricing.json');
}

/** Fetch the raw LiteLLM JSON, reusing a <1h-old disk cache when present. */
async function fetchRaw(): Promise<Record<string, unknown>> {
  const cp = cachePath();
  try {
    if (existsSync(cp) && Date.now() - statSync(cp).mtimeMs < 3_600_000) {
      return JSON.parse(readFileSync(cp, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    // fall through to network
  }

  const body = await new Promise<string>((resolve, reject) => {
    const req = https.get(PRICING_URL, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c.toString(); });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Pricing request timeout')); });
  });

  const json = JSON.parse(body) as Record<string, unknown>;
  try { writeFileSync(cp, body, 'utf8'); } catch { /* cache best-effort */ }
  return json;
}

function num(d: Record<string, unknown>, key: string): number | null {
  const v = d[key];
  return typeof v === 'number' ? v : null;
}

/** Returns the parsed pricing table, or null if it can't be fetched (offline). */
export async function getPricing(): Promise<PricingMap | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await fetchRaw();
  } catch {
    return null;
  }

  const out: PricingMap = new Map();
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const d = value as Record<string, unknown>;

    const input = num(d, 'input_cost_per_token') ?? 0;
    const output = num(d, 'output_cost_per_token') ?? 0;
    const cw = num(d, 'cache_creation_input_token_cost') ?? 0;
    const cr = num(d, 'cache_read_input_token_cost') ?? 0;
    // Skip metadata-only rows with no pricing.
    if (input === 0 && output === 0 && cw === 0 && cr === 0) continue;

    // 1-hour cache writes bill at 2x base input (the 5-minute default is 1.25x).
    // LiteLLM omits the explicit field for some models (e.g. claude-sonnet-4-6),
    // while ccusage applies the 2x rule universally — fall back to 2x input.
    const cw1h = num(d, 'cache_creation_input_token_cost_above_1hr') ?? (input > 0 ? input * 2 : null);

    let fast: number | null = null;
    const prov = d['provider_specific_entry'];
    if (prov && typeof prov === 'object') {
      const f = (prov as Record<string, unknown>)['fast'];
      if (typeof f === 'number') fast = f;
    }

    out.set(name, {
      input, output, cacheCreate: cw, cacheCreate1h: cw1h, cacheRead: cr,
      inputAbove200k: num(d, 'input_cost_per_token_above_200k_tokens'),
      outputAbove200k: num(d, 'output_cost_per_token_above_200k_tokens'),
      cacheCreateAbove200k: num(d, 'cache_creation_input_token_cost_above_200k_tokens'),
      cacheReadAbove200k: num(d, 'cache_read_input_token_cost_above_200k_tokens'),
      fastMultiplier: fast,
    });
  }
  return out;
}

/**
 * Resolve a JSONL model name against LiteLLM keys: exact, then provider-prefixed,
 * then longest prefix match (claude-sonnet-4-6-20250929 → claude-sonnet-4-6).
 */
export function resolvePricing(model: string, pricing: PricingMap): ModelPricing | null {
  const exact = pricing.get(model);
  if (exact) return exact;

  for (const c of [`anthropic/${model}`, `anthropic.${model}`]) {
    const v = pricing.get(c);
    if (v) return v;
  }

  let bestKey: string | null = null;
  for (const key of pricing.keys()) {
    if (model.startsWith(key) || key.startsWith(model)) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? pricing.get(bestKey) ?? null : null;
}

function tieredCost(tokens: number, baseRate: number, hiRate: number | null): number {
  if (hiRate === null || hiRate <= 0 || tokens <= 200_000) return tokens * baseRate;
  return 200_000 * baseRate + (tokens - 200_000) * hiRate;
}

export interface TokenRow {
  model: string;
  fast: boolean;
  input: number;
  output: number;
  cacheCreate: number;
  cacheCreate1h: number;
  cacheRead: number;
}

/** Per-message cost in USD, mirroring recalc_cost.swift. 0 if the model is unpriced. */
export function costForRow(row: TokenRow, pricing: PricingMap): number {
  const p = resolvePricing(row.model, pricing);
  if (!p) return 0;

  let cacheCreateCost: number;
  if (p.cacheCreate1h !== null && row.cacheCreate1h > 0) {
    const oneHour = Math.min(row.cacheCreate1h, row.cacheCreate);
    cacheCreateCost =
      tieredCost(row.cacheCreate - oneHour, p.cacheCreate, p.cacheCreateAbove200k) +
      tieredCost(oneHour, p.cacheCreate1h, p.cacheCreateAbove200k);
  } else {
    cacheCreateCost = tieredCost(row.cacheCreate, p.cacheCreate, p.cacheCreateAbove200k);
  }

  const base =
    tieredCost(row.input, p.input, p.inputAbove200k) +
    tieredCost(row.output, p.output, p.outputAbove200k) +
    cacheCreateCost +
    tieredCost(row.cacheRead, p.cacheRead, p.cacheReadAbove200k);

  const mult = row.fast ? (p.fastMultiplier ?? 1) : 1;
  return base * mult;
}
