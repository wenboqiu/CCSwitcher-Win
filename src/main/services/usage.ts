/**
 * Anthropic Usage API — same endpoint as macOS (/api/oauth/usage).
 * Automatically retries once after a 401 by triggering a silent CLI refresh.
 *
 * NOTE: we deliberately use Electron's `net` (Chromium network stack), NOT
 * Node's `https`. Cloudflare in front of api.anthropic.com 403s ("Request not
 * allowed") requests carrying Node/OpenSSL's TLS fingerprint, while it accepts
 * Chromium's browser-like fingerprint (same reason curl and macOS URLSession
 * work). If `net` is ever blocked too, we fall back to shelling out to curl.
 *
 * `utilization` from this endpoint is already a 0–100 percentage (e.g. 33.0,
 * 85.0) — do not multiply by 100.
 */

import { net } from 'electron';
import { execFile } from 'child_process';
import type { UsageLimits } from '../../shared/types';
import { readClaudeToken } from './credential';
import { getAuthStatus } from './claude';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

interface UsageAPIResponse {
  five_hour?: { utilization: number; resets_at?: string };
  seven_day?: { utilization: number; resets_at?: string };
  error?: { type?: string; message?: string };
}

export async function getUsageLimits(accessToken: string): Promise<UsageLimits> {
  const raw = await fetchUsage(accessToken);
  return {
    fiveHourUtilization: raw.five_hour?.utilization,
    sevenDayUtilization: raw.seven_day?.utilization,
    fiveHourResetAt: raw.five_hour?.resets_at,
    sevenDayResetAt: raw.seven_day?.resets_at,
    resetAt: raw.five_hour?.resets_at ?? raw.seven_day?.resets_at,
  };
}

/**
 * Fetch usage for the currently active account.
 * On 401 (expired token), asks Claude CLI to refresh silently by calling
 * `claude auth status`, which triggers an internal token refresh, then retries.
 */
export async function getActiveUsageLimits(): Promise<UsageLimits | null> {
  const token = await readClaudeToken();
  if (!token) return null;

  const accessToken = extractAccessToken(token);
  if (!accessToken) return null;

  try {
    return await getUsageLimits(accessToken);
  } catch (err) {
    if ((err as Error).message !== 'TOKEN_EXPIRED') return null;

    // Trigger CLI's internal token refresh by calling auth status.
    // Let errors propagate so the IPC handler can surface a meaningful
    // message instead of silently showing nothing.
    await getAuthStatus();
    const refreshed = await readClaudeToken();
    if (!refreshed) return null;
    const newAccessToken = extractAccessToken(refreshed);
    if (!newAccessToken) return null;
    return await getUsageLimits(newAccessToken);
  }
}

async function fetchUsage(accessToken: string): Promise<UsageAPIResponse> {
  try {
    return await fetchViaElectronNet(accessToken);
  } catch (err) {
    // An expired token must reach the refresh path; everything else (notably a
    // 403 from TLS-fingerprint blocking) falls back to curl, which uses a
    // different fingerprint api.anthropic.com accepts.
    if ((err as Error).message === 'TOKEN_EXPIRED') throw err;
    return await fetchViaCurl(accessToken);
  }
}

/** Primary path: Chromium network stack — browser-like TLS fingerprint. */
function fetchViaElectronNet(accessToken: string): Promise<UsageAPIResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: USAGE_URL });
    request.setHeader('Authorization', `Bearer ${accessToken}`);
    request.setHeader('anthropic-beta', 'oauth-2025-04-20');

    request.on('response', (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      response.on('end', () => {
        const status = response.statusCode;
        if (status === 401 || body.includes('token_expired')) {
          return reject(new Error('TOKEN_EXPIRED'));
        }
        if (status !== 200) return reject(new Error(`HTTP ${status}`));
        try {
          resolve(JSON.parse(body) as UsageAPIResponse);
        } catch {
          reject(new Error('Failed to parse usage response'));
        }
      });
    });

    request.on('error', (err) => reject(err));
    request.end();
  });
}

/** Fallback: shell out to curl (present on Windows 10+ as curl.exe). */
function fetchViaCurl(accessToken: string): Promise<UsageAPIResponse> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-s', '-S', '--max-time', '10',
        '-H', `Authorization: Bearer ${accessToken}`,
        '-H', 'anthropic-beta: oauth-2025-04-20',
        USAGE_URL,
      ],
      { timeout: 12_000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        const body = stdout ?? '';
        if (body.includes('token_expired')) return reject(new Error('TOKEN_EXPIRED'));
        try {
          const json = JSON.parse(body) as UsageAPIResponse;
          if (json.error) return reject(new Error(json.error.message ?? 'usage error'));
          resolve(json);
        } catch {
          reject(new Error('Failed to parse usage response'));
        }
      },
    );
  });
}

export function extractAccessToken(tokenJson: string): string | null {
  try {
    const parsed = JSON.parse(tokenJson) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}
