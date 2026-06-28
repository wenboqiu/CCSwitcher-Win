import { ipcMain, BrowserWindow } from 'electron';
import { getState, switchAccount, addAccount, removeAccount, reauthenticate } from './services/accounts';
import { getUsageSummary, getCostSummary } from './services/stats';
import { getActiveUsageLimits } from './services/usage';
import { hidePopup, setPopupHeight } from './popup';
import type { OperationResult } from '../shared/types';

export function registerIpcHandlers(): void {
  ipcMain.handle('get-state', () => getState());

  ipcMain.handle('switch-account', async (_e, accountId: string): Promise<OperationResult> => {
    try {
      await switchAccount(accountId);
      broadcastState();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('add-account', async (): Promise<OperationResult> => {
    try {
      const account = await addAccount();
      broadcastState();
      return { success: true, data: account };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('remove-account', (_e, accountId: string): OperationResult => {
    try {
      removeAccount(accountId);
      broadcastState();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reauthenticate', async (_e, accountId: string): Promise<OperationResult> => {
    try {
      await reauthenticate(accountId);
      broadcastState();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('get-stats', () => getUsageSummary());

  ipcMain.handle('get-cost', () => getCostSummary());

  ipcMain.handle('get-usage-limits', async (): Promise<OperationResult> => {
    try {
      const limits = await getActiveUsageLimits();
      return { success: true, data: limits ?? undefined };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.on('close-popup', () => hidePopup());

  ipcMain.on('resize-popup', (_e, height: number) => setPopupHeight(height));
}

function broadcastState(): void {
  const state = getState();
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('state-updated', state);
  });
}
