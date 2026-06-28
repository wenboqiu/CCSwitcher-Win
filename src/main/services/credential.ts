/**
 * Credential service — file-based (Windows).
 *
 * On Windows, Claude CLI stores credentials in two files:
 *   1. ~/.claude/.credentials.json  — OAuth token JSON
 *   2. ~/.claude.json               — oauthAccount block
 *
 * Our per-account backups → safeStorage-encrypted JSON
 *   Stored at %APPDATA%\CCSwitcher\backups.json
 */

import { safeStorage, app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

// ── Claude live token (~/.claude/.credentials.json) ──────────────────────────

const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

export async function readClaudeToken(): Promise<string | null> {
  if (!existsSync(CREDS_FILE)) return null;
  try {
    return readFileSync(CREDS_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

export async function writeClaudeToken(token: string): Promise<void> {
  const dir = path.dirname(CREDS_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CREDS_FILE, token, 'utf8');
}

// ── ~/.claude.json oauthAccount block ────────────────────────────────────────

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

export function readOAuthAccount(): Record<string, unknown> | null {
  if (!existsSync(CLAUDE_JSON)) return null;
  try {
    const json = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) as Record<string, unknown>;
    const oa = json['oauthAccount'];
    return oa && typeof oa === 'object' ? (oa as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function writeOAuthAccount(oauthAccount: Record<string, unknown>): boolean {
  try {
    let json: Record<string, unknown> = {};
    if (existsSync(CLAUDE_JSON)) {
      json = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) as Record<string, unknown>;
    }
    json['oauthAccount'] = oauthAccount;
    writeFileSync(CLAUDE_JSON, JSON.stringify(json, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── Per-account backup store (safeStorage encrypted) ─────────────────────────

interface BackupEntry {
  encryptedToken: string;
  encryptedOAuth: string;
}

interface AccountBackup {
  token: string;
  oauthAccount: Record<string, unknown>;
}

function backupFilePath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'backups.json');
}

function loadStore(): Record<string, BackupEntry> {
  const p = backupFilePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, BackupEntry>;
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, BackupEntry>): void {
  writeFileSync(backupFilePath(), JSON.stringify(store, null, 2), 'utf8');
}

export function saveAccountBackup(
  accountId: string,
  token: string,
  oauthAccount: Record<string, unknown>,
): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const store = loadStore();
    store[accountId] = {
      encryptedToken: safeStorage.encryptString(token).toString('base64'),
      encryptedOAuth: safeStorage.encryptString(JSON.stringify(oauthAccount)).toString('base64'),
    };
    saveStore(store);
    return true;
  } catch {
    return false;
  }
}

export function getAccountBackup(accountId: string): AccountBackup | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const store = loadStore();
    const entry = store[accountId];
    if (!entry) return null;
    const token = safeStorage.decryptString(Buffer.from(entry.encryptedToken, 'base64'));
    const oauthAccount = JSON.parse(
      safeStorage.decryptString(Buffer.from(entry.encryptedOAuth, 'base64')),
    ) as Record<string, unknown>;
    return { token, oauthAccount };
  } catch {
    return null;
  }
}

export function removeAccountBackup(accountId: string): void {
  const store = loadStore();
  delete store[accountId];
  saveStore(store);
}
