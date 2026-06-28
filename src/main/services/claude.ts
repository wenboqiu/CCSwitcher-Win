/**
 * Claude CLI interaction service.
 * Finds the claude binary, runs auth commands, fetches auth status.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { AuthStatus } from '../../shared/types';

// Common Windows install locations for Claude CLI
const WINDOWS_CANDIDATES: string[] = [
  // WinGet managed links
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
  // Anthropic native installer
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'AnthropicClaude', 'claude.exe'),
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'AnthropicClaude', 'resources', 'claude.exe'),
  // npm global (cmd wrapper)
  path.join(process.env.APPDATA ?? os.homedir(), 'npm', 'claude.cmd'),
  path.join(process.env.APPDATA ?? os.homedir(), 'npm', 'claude'),
  // Scoop
  path.join(os.homedir(), 'scoop', 'shims', 'claude.cmd'),
  path.join(os.homedir(), 'scoop', 'shims', 'claude'),
];

let _cachedPath: string | null = null;

/** Detect the claude binary. Returns null if not found. */
export function findClaudePath(): string | null {
  if (_cachedPath && existsSync(_cachedPath)) return _cachedPath;

  for (const p of WINDOWS_CANDIDATES) {
    if (existsSync(p)) {
      _cachedPath = p;
      return p;
    }
  }

  // Last resort: ask where.exe
  const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8', timeout: 3000 });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/)[0].trim();
    if (first) {
      _cachedPath = first;
      return first;
    }
  }

  return null;
}

/** Read the installed version string. */
export function getClaudeVersion(): string | null {
  const p = findClaudePath();
  if (!p) return null;
  const r = runSync(p, ['--version']);
  if (!r) return null;
  const m = r.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Run `claude auth status` and return parsed JSON. */
export async function getAuthStatus(): Promise<AuthStatus> {
  const p = findClaudePath();
  if (!p) throw new Error('Claude CLI not found.');
  const out = runSync(p, ['auth', 'status']);
  if (!out) throw new Error('claude auth status returned no output.');
  return JSON.parse(out) as AuthStatus;
}

/** Run `claude auth logout`. */
export async function logout(): Promise<void> {
  const p = findClaudePath();
  if (!p) throw new Error('Claude CLI not found.');
  runSync(p, ['auth', 'logout']);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function runSync(claudePath: string, args: string[]): string | null {
  const pArgs: string[] = claudePath.endsWith('.cmd') || claudePath.endsWith('.bat')
    ? ['/c', claudePath, ...args]
    : args;
  const exe = claudePath.endsWith('.cmd') || claudePath.endsWith('.bat')
    ? 'cmd.exe'
    : claudePath;

  const r = spawnSync(exe, pArgs, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });

  if (r.status !== 0) return null;
  return r.stdout?.trim() || null;
}
