/**
 * Account management — switching, adding, removing.
 * Mirrors the macOS token flow from ARCHITECTURE.md.
 *
 * Switch A → B:
 *   1. Verify live oauthAccount email == A.email, then backup A
 *   2. Load B's backup
 *   3. Write B's token → ~/.claude/.credentials.json
 *      Write B's oauthAccount → ~/.claude.json
 *   4. Verify oauthAccount email == B.email after write
 *
 * Capture current account:
 *   1. Read live token from ~/.claude/.credentials.json
 *   2. Read live oauthAccount from ~/.claude.json
 *   3. If new email → create account + backup
 *   4. If existing email → refresh backup
 */

import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  readClaudeToken, writeClaudeToken,
  readOAuthAccount, writeOAuthAccount,
  saveAccountBackup, getAccountBackup, removeAccountBackup,
} from './credential';
import { getAuthStatus } from './claude';
import type { Account, AppState } from '../../shared/types';

// ── Persistence ───────────────────────────────────────────────────────────────

function stateFilePath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'accounts.json');
}

function loadState(): AppState {
  const p = stateFilePath();
  if (!existsSync(p)) return { accounts: [], activeAccountId: null };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AppState;
  } catch {
    return { accounts: [], activeAccountId: null };
  }
}

function saveState(state: AppState): void {
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getState(): AppState {
  return loadState();
}

export async function switchAccount(targetId: string): Promise<void> {
  const state = loadState();
  const target = state.accounts.find((a) => a.id === targetId);
  if (!target) throw new Error('Account not found.');

  const current = state.accounts.find((a) => a.id === state.activeAccountId);

  // Step 1: Backup current account's token if the live oauthAccount matches.
  // Identity lives in ~/.claude.json's oauthAccount.emailAddress — Windows'
  // `claude auth status` JSON doesn't include email.
  if (current) {
    const liveOauth = readOAuthAccount();
    const liveEmail = liveOauth?.['emailAddress'] as string | undefined;
    if (liveEmail === current.email) {
      const token = await readClaudeToken();
      if (token && liveOauth) {
        saveAccountBackup(current.id, token, liveOauth);
      }
    }
  }

  // Step 2: Load target backup
  const backup = getAccountBackup(targetId);
  if (!backup) throw new Error(`No saved credentials for ${target.email}. Re-authenticate first.`);

  // Step 3: Atomic write — token to Credential Manager, oauthAccount to disk
  await writeClaudeToken(backup.token);
  writeOAuthAccount(backup.oauthAccount);

  // Step 4: Verify by reading back the oauthAccount we just wrote
  const verified = readOAuthAccount();
  const verifiedEmail = verified?.['emailAddress'] as string | undefined;
  if (verifiedEmail !== target.email) {
    throw new Error(
      `Switch failed: expected ${target.email}, got ${verifiedEmail ?? 'unknown'}.`,
    );
  }

  // Step 4b: Proactive token refresh — if the target's backed-up access_token
  // is expired the CLI will exchange the refresh_token for a new one and write
  // it back to ~/.claude/.credentials.json. We then persist the fresh token so
  // the NEXT switch also starts with current credentials.
  // Bounded by 8 s so an unreachable network doesn't stall the switch for long.
  try {
    await Promise.race([
      getAuthStatus(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('refresh_timeout')), 8_000),
      ),
    ]);
    const freshToken = await readClaudeToken();
    const freshOAuth = readOAuthAccount();
    if (freshToken && freshOAuth) {
      saveAccountBackup(targetId, freshToken, freshOAuth);
    }
  } catch {
    // Network failure or timeout — proceed with stored token; the usage
    // panel's own 401-retry path will attempt another refresh.
  }

  // Step 5: Update state
  const updated: AppState = {
    ...state,
    accounts: state.accounts.map((a) => ({ ...a, isActive: a.id === targetId })),
    activeAccountId: targetId,
  };
  saveState(updated);
}

/**
 * Capture the currently active Claude credentials as a managed account.
 * Does NOT run `claude auth login` — on Windows that flow requires stdin
 * (browser redirect goes to platform.claude.com, not localhost).
 *
 * Workflow:
 *   1. User logs in via terminal:  `claude auth login`
 *   2. User clicks "Capture Current" in CCSwitcher
 *   3. We read live token + oauthAccount → create/refresh account entry
 *
 * To add a second account, user runs `claude auth logout && claude auth login`
 * in terminal as account B, then captures again.
 */
export async function addAccount(): Promise<Account> {
  const state = loadState();

  // Read live credentials (what Claude CLI is currently using)
  const token = await readClaudeToken();
  const oauthAccount = readOAuthAccount();

  if (!token) {
    throw new Error(
      'No active Claude session found.\n\n' +
        'Run "claude auth login" in a terminal first, then click Capture.',
    );
  }
  if (!oauthAccount) {
    throw new Error(
      'oauthAccount not found in ~/.claude.json.\n\n' +
        'Run "claude auth login" in a terminal first.',
    );
  }

  const newEmail = oauthAccount['emailAddress'] as string | undefined;
  if (!newEmail) {
    throw new Error(
      'No email field in oauthAccount.\n\n' +
        'Your ~/.claude.json may be missing identity info. Try re-logging in.',
    );
  }
  console.log('[addAccount] Capturing account:', newEmail);

  // Refresh backup for the currently-active account if it's already in our list
  const current = state.accounts.find((a) => a.id === state.activeAccountId);
  if (current && current.email === newEmail) {
    saveAccountBackup(current.id, token, oauthAccount);
  }

  // Existing account? Refresh its backup and make it active
  const existing = state.accounts.find((a) => a.email === newEmail);
  if (existing) {
    saveAccountBackup(existing.id, token, oauthAccount);
    const refreshed: AppState = {
      ...state,
      accounts: state.accounts.map((a) =>
        a.id === existing.id ? { ...a, isActive: true } : { ...a, isActive: false },
      ),
      activeAccountId: existing.id,
    };
    saveState(refreshed);
    console.log('[addAccount] Updated existing account:', existing.email);
    return { ...existing, isActive: true };
  }

  // New account
  const newAccount: Account = {
    id: randomUUID(),
    email: newEmail,
    displayName: (oauthAccount['displayName'] as string | undefined) ?? newEmail,
    organization: (oauthAccount['organizationName'] as string | undefined) ??
      oauthAccount['organization'] as string | undefined,
    subscriptionType: oauthAccount['billingType'] as string | undefined,
    addedAt: new Date().toISOString(),
    isActive: true,
  };

  saveAccountBackup(newAccount.id, token, oauthAccount);

  const newState: AppState = {
    accounts: [
      ...state.accounts.map((a) => ({ ...a, isActive: false })),
      newAccount,
    ],
    activeAccountId: newAccount.id,
  };
  saveState(newState);
  console.log('[addAccount] New account captured:', newEmail);
  return newAccount;
}

/**
 * Refresh the backup for an existing account from the currently active credentials.
 * Used when the token was refreshed externally (e.g., via `claude auth status`).
 */
export async function reauthenticate(accountId: string): Promise<void> {
  const state = loadState();
  const target = state.accounts.find((a) => a.id === accountId);
  if (!target) throw new Error('Account not found.');

  // Capture current live credentials
  const token = await readClaudeToken();
  const oauthAccount = readOAuthAccount();
  if (!token || !oauthAccount) {
    throw new Error(
      'No active session found.\n\n' +
        `To re-authenticate as ${target.email}, run "claude auth login" in a terminal ` +
        'and log in as that account, then click Capture.',
    );
  }

  const liveEmail = oauthAccount['emailAddress'] as string | undefined;
  if (liveEmail !== target.email) {
    throw new Error(
      `Currently logged in as ${liveEmail ?? 'unknown'}, but need ${target.email}.\n\n` +
        `Run "claude auth login" in a terminal and log in as ${target.email} first.`,
    );
  }

  saveAccountBackup(accountId, token, oauthAccount);
  console.log('[reauthenticate] Refreshed backup for:', target.email);

  // Make this account active
  const newState: AppState = {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === accountId ? { ...a, isActive: true } : { ...a, isActive: false },
    ),
    activeAccountId: accountId,
  };
  saveState(newState);
}

export function removeAccount(accountId: string): void {
  const state = loadState();
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Account not found.');
  if (account.isActive) throw new Error('Cannot remove the active account. Switch to another first.');

  removeAccountBackup(accountId);

  const newState: AppState = {
    ...state,
    accounts: state.accounts.filter((a) => a.id !== accountId),
  };
  saveState(newState);
}

