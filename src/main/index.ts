import { app, Tray, Menu, nativeImage, nativeTheme } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { createPopupWindow, togglePopup, isPopupVisible } from './popup';
import { registerIpcHandlers } from './ipc';
import { getState } from './services/accounts';
import { findClaudePath, getClaudeVersion } from './services/claude';

// Single-instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;

app.whenReady().then(() => {
  // Keep app running without a visible dock entry
  app.setAppUserModelId('me.xueshi.ccswitcher');

  registerIpcHandlers();

  const preload = path.join(__dirname, '../preload/index.js');
  const popup = createPopupWindow(preload);

  // Load renderer
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    popup.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    popup.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Create system tray icon
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('CCSwitcher');

  updateTrayMenu(tray);

  tray.on('click', () => togglePopup(tray!));
  tray.on('right-click', () => tray!.popUpContextMenu());

  // Keep tray menu in sync with state and theme
  nativeTheme.on('updated', () => tray && updateTrayMenu(tray));

  // Log Claude CLI detection result
  const claudePath = findClaudePath();
  const version = claudePath ? getClaudeVersion() : null;
  console.log(claudePath
    ? `Claude CLI: ${claudePath}${version ? ` (v${version})` : ''}`
    : 'Claude CLI not found in common locations');
});

app.on('second-instance', () => {
  if (tray) togglePopup(tray);
});

// Prevent app from quitting when all windows are closed (tray-only app)
app.on('window-all-closed', (e: Event) => e.preventDefault());

function updateTrayMenu(t: Tray): void {
  const state = getState();
  const active = state.accounts.find((a) => a.id === state.activeAccountId);

  const menu = Menu.buildFromTemplate([
    {
      label: active ? `Signed in as ${active.email}` : 'Not signed in',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open CCSwitcher',
      click: () => {
        if (!isPopupVisible()) togglePopup(t);
      },
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);

  t.setContextMenu(menu);
}

function loadTrayIcon(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'resources', 'tray-icon.png')]
    : [
        path.join(app.getAppPath(), 'resources', 'tray-icon.png'),
        path.join(__dirname, '../../resources', 'tray-icon.png'),
      ];

  for (const p of candidates) {
    if (existsSync(p)) return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  }

  // Minimal fallback: 16×16 solid #1a1a1a square encoded as PNG
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4jWNgYGD4z8BAAoxqGBUwKmBgYGBg+E8mJqMaRgWMChgVAABl3gABqyOZIwAAAABJRU5ErkJggg==',
  );
}
