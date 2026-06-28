import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, UsageSummary, UsageLimits, CostSummary, Account, OperationResult } from '../shared/types';

const api = {
  getState: (): Promise<AppState> =>
    ipcRenderer.invoke('get-state'),

  switchAccount: (accountId: string): Promise<OperationResult> =>
    ipcRenderer.invoke('switch-account', accountId),

  addAccount: (): Promise<OperationResult<Account>> =>
    ipcRenderer.invoke('add-account'),

  removeAccount: (accountId: string): Promise<OperationResult> =>
    ipcRenderer.invoke('remove-account', accountId),

  reauthenticate: (accountId: string): Promise<OperationResult> =>
    ipcRenderer.invoke('reauthenticate', accountId),

  getStats: (): Promise<UsageSummary> =>
    ipcRenderer.invoke('get-stats'),

  getCost: (): Promise<CostSummary> =>
    ipcRenderer.invoke('get-cost'),

  getUsageLimits: (): Promise<OperationResult<UsageLimits>> =>
    ipcRenderer.invoke('get-usage-limits'),

  onStateUpdated: (cb: (state: AppState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => cb(state);
    ipcRenderer.on('state-updated', handler);
    return () => ipcRenderer.removeListener('state-updated', handler);
  },

  closePopup: (): void => {
    ipcRenderer.send('close-popup');
  },

  resizePopup: (height: number): void => {
    ipcRenderer.send('resize-popup', height);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

declare global {
  interface Window {
    electronAPI: typeof api;
  }
}
