import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, safeStorage } from 'electron';
import { resolve, dirname, join } from 'node:path';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNetMeterServer } from './server.mjs';

const root = dirname(fileURLToPath(import.meta.url));
let server;
let serverPort;
let settingsWindow;
let widgetWindow;
let tray;
let quitting = false;
let widgetCanvasWidth = 380;
let widgetCanvasHeight = 160;
let widgetCanvasInitialized = false;
let historyOpen = false;
let widgetWindowStateSaveTimer = null;
let widgetWindowState = null;
let uiLanguage = 'zh';

const UI_STRINGS = {
  zh: {
    titleWidget: 'NetMeter 控制器方格',
    settingsTitle: 'NetMeter 设置',
    showHideWidget: '显示/隐藏方格',
    settings: '设置',
    pinToStart: '固定到开始菜单',
    hideWidget: '隐藏方格',
    quit: '退出 NetMeter'
  },
  en: {
    titleWidget: 'NetMeter Controller Tiles',
    settingsTitle: 'NetMeter Settings',
    showHideWidget: 'Show/Hide tiles',
    settings: 'Settings',
    pinToStart: 'Pin to Start menu',
    hideWidget: 'Hide tiles',
    quit: 'Quit NetMeter'
  }
};

function strings() {
  return UI_STRINGS[uiLanguage] || UI_STRINGS.zh;
}

function controllerConfigPath() {
  return join(app.getPath('userData'), 'controller-config.bin');
}

function widgetWindowStatePath() {
  return join(app.getPath('userData'), 'widget-window.json');
}

function appIconPath() {
  return join(app.getPath('userData'), 'netmeter.ico');
}

function startMenuShortcutPath() {
  return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NetMeter.lnk');
}

async function loadWidgetWindowState() {
  try {
    const stored = JSON.parse(await readFile(widgetWindowStatePath(), 'utf8'));
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return { x: stored.x, y: stored.y };
  } catch {
    // no stored position yet
  }
  return null;
}

function clampWidgetPosition(x, y, bounds) {
  const workArea = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.max(workArea.x - bounds.width + 80, Math.min(workArea.x + workArea.width - 80, Math.round(x))),
    y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - 40, Math.round(y)))
  };
}

function saveWidgetWindowState() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const bounds = widgetWindow.getBounds();
  writeFile(widgetWindowStatePath(), JSON.stringify({ x: bounds.x, y: bounds.y }), { mode: 0o600 }).catch(() => {});
}

function scheduleWidgetWindowStateSave() {
  clearTimeout(widgetWindowStateSaveTimer);
  widgetWindowStateSaveTimer = setTimeout(saveWidgetWindowState, 400);
}

function installStartMenuShortcut() {
  return new Promise(resolve => {
    const script = resolve(root, 'scripts', 'install-start-menu.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPath', process.execPath, '-Arguments', `"${root}"`, '-WorkingDirectory', root, '-IconPath', appIconPath()], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

async function loadControllerConfig() {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
    const encrypted = await readFile(controllerConfigPath());
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    const stored = JSON.parse(decrypted.result);
    if (stored?.version !== 1 || !stored.config || typeof stored.config !== 'object') return null;
    if (decrypted.shouldReEncrypt) await writeFile(controllerConfigPath(), await safeStorage.encryptStringAsync(decrypted.result), { mode: 0o600 });
    return stored.config;
  } catch {
    return null;
  }
}

async function persistControllerConfig(config) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('secure_storage_unavailable');
  const payload = JSON.stringify({ version: 1, config });
  await writeFile(controllerConfigPath(), await safeStorage.encryptStringAsync(payload), { mode: 0o600 });
}

function startLocalServer(initialConfig) {
  server = createNetMeterServer({ projectRoot: root, initialConfig, onConfigChanged: persistControllerConfig });
  const requestedPort = Number(process.env.PORT || 4174);
  return new Promise((resolvePort, reject) => {
    const tryPort = port => {
      server.once('error', error => {
        if (error.code === 'EADDRINUSE' && port < requestedPort + 10) return tryPort(port + 1);
        reject(error);
      });
      server.listen(port, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolvePort(serverPort);
      });
    };
    tryPort(requestedPort);
  });
}

function pageUrl(view) {
  return `http://127.0.0.1:${serverPort}/?view=${view}`;
}

function placeSettingsBesideWidget() {
  if (!widgetWindow?.isVisible() || !settingsWindow || settingsWindow.isDestroyed()) return;
  const widgetBounds = widgetWindow.getBounds();
  const settingsBounds = settingsWindow.getBounds();
  const overlaps = widgetBounds.x < settingsBounds.x + settingsBounds.width &&
    widgetBounds.x + widgetBounds.width > settingsBounds.x &&
    widgetBounds.y < settingsBounds.y + settingsBounds.height &&
    widgetBounds.y + widgetBounds.height > settingsBounds.y;
  if (!overlaps) return;
  const workArea = screen.getDisplayMatching(widgetBounds).workArea;
  const clampX = value => Math.max(workArea.x, Math.min(workArea.x + workArea.width - settingsBounds.width, value));
  const clampY = value => Math.max(workArea.y, Math.min(workArea.y + workArea.height - settingsBounds.height, value));
  const candidates = [
    { x: widgetBounds.x + widgetBounds.width + 12, y: clampY(widgetBounds.y) },
    { x: widgetBounds.x - settingsBounds.width - 12, y: clampY(widgetBounds.y) },
    { x: clampX(widgetBounds.x), y: widgetBounds.y + widgetBounds.height + 12 },
    { x: clampX(widgetBounds.x), y: widgetBounds.y - settingsBounds.height - 12 }
  ];
  const position = candidates.find(candidate => candidate.x >= workArea.x && candidate.y >= workArea.y &&
    candidate.x + settingsBounds.width <= workArea.x + workArea.width &&
    candidate.y + settingsBounds.height <= workArea.y + workArea.height);
  if (!position) return;
  settingsWindow.setPosition(position.x, position.y);
}

function showSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = new BrowserWindow({
      width: 560,
      height: 740,
      minWidth: 440,
      minHeight: 600,
      title: strings().settingsTitle,
      autoHideMenuBar: true,
      icon: appIconPath(),
      webPreferences: {
        preload: resolve(root, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    settingsWindow.on('close', event => {
      if (!quitting) {
        event.preventDefault();
        settingsWindow.hide();
        settingsWindow.setAlwaysOnTop(false);
      }
    });
    settingsWindow.loadURL(pageUrl('settings'));
  }
  settingsWindow.setTitle(strings().settingsTitle);
  placeSettingsBesideWidget();
  settingsWindow.show();
  settingsWindow.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow.focus();
}

function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    widgetWindow = new BrowserWindow({
      width: 192,
      height: 160,
      minWidth: 192,
      minHeight: 160,
      maxWidth: 4000,
      maxHeight: 4000,
      title: strings().titleWidget,
      frame: false,
      transparent: true,
      resizable: true,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      icon: appIconPath(),
      webPreferences: {
        preload: resolve(root, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    widgetWindow.on('closed', () => {
      widgetWindow = null;
      widgetCanvasInitialized = false;
      historyOpen = false;
    });
    widgetWindow.on('move', scheduleWidgetWindowStateSave);
    widgetWindow.webContents.on('context-menu', () => {
      if (!widgetWindow) return;
      const menu = Menu.buildFromTemplate([
        { label: strings().settings, click: showSettings },
        { label: strings().pinToStart, click: () => { installStartMenuShortcut().then(() => {}); } },
        { label: strings().hideWidget, click: () => widgetWindow?.hide() },
        { type: 'separator' },
        { label: strings().quit, click: () => app.quit() }
      ]);
      menu.popup({ window: widgetWindow });
    });
    widgetWindow.loadURL(pageUrl('widget'));
    if (widgetWindowState) {
      const position = clampWidgetPosition(widgetWindowState.x, widgetWindowState.y, widgetWindow.getBounds());
      widgetWindow.setPosition(position.x, position.y);
    }
  }
  widgetWindow.show();
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
}

function toggleWidget() {
  if (widgetWindow?.isVisible()) widgetWindow.hide();
  else showWidget();
}

function createTray() {
  const iconPath = resolve(root, 'assets', 'tray', 'netmeter.ico');
  if (nativeImage.createFromPath(iconPath).isEmpty()) throw new Error('NetMeter tray icon could not be loaded');
  tray = new Tray(iconPath);
  tray.setToolTip('NetMeter');
  refreshTrayMenu();
  tray.on('click', toggleWidget);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: strings().showHideWidget, click: toggleWidget },
    { label: strings().settings, click: showSettings },
    { label: strings().pinToStart, click: () => { installStartMenuShortcut(); } },
    { type: 'separator' },
    { label: strings().quit, click: () => app.quit() }
  ]));
}

ipcMain.on('app:language', (event, language) => {
  const next = language === 'en' ? 'en' : 'zh';
  if (next === uiLanguage) return;
  uiLanguage = next;
  refreshTrayMenu();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setTitle(strings().settingsTitle);
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.setTitle(strings().titleWidget);
});

ipcMain.on('widget:resize', (event, payload) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return;
  if (!Number.isFinite(payload?.width) || !Number.isFinite(payload?.height)) return;
  const width = Math.max(192, Math.min(4000, Math.round(payload.width)));
  const height = Math.max(160, Math.min(4000, Math.round(payload.height)));
  if (widgetCanvasInitialized && width === widgetCanvasWidth && height === widgetCanvasHeight) return;
  widgetCanvasWidth = width;
  widgetCanvasHeight = height;
  widgetCanvasInitialized = true;
  resizeWidget();
});

function resizeWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (historyOpen) {
    widgetWindow.setMinimumSize(380, 306);
    widgetWindow.setContentSize(380, 306);
    placeSettingsBesideWidget();
    return;
  }
  const display = screen.getDisplayMatching(widgetWindow.getBounds());
  const width = Math.min(widgetCanvasWidth, display.workAreaSize.width);
  const height = Math.min(widgetCanvasHeight, display.workAreaSize.height);
  widgetWindow.setMinimumSize(192, 160);
  widgetWindow.setContentSize(width, height);
  placeSettingsBesideWidget();
}

ipcMain.on('widget:history-open', (event, open) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return;
  const next = Boolean(open);
  if (next === historyOpen) return;
  if (next) {
    historyOpen = true;
    resizeWidget();
    return;
  }
  historyOpen = false;
  resizeWidget();
});

ipcMain.handle('widget:position', event => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return null;
  const bounds = widgetWindow.getBounds();
  return { x: bounds.x, y: bounds.y };
});

ipcMain.handle('diag:drag', async (event, payload) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return false;
  if (!payload || typeof payload !== 'object') return false;
  const file = join(app.getPath('userData'), 'drag-diagnostics.jsonl');
  try {
    const info = await stat(file).catch(() => null);
    if (info && info.size > 512 * 1024) await writeFile(file, '');
    await appendFile(file, JSON.stringify(payload) + '\n');
  } catch {
    return false;
  }
  return true;
});

ipcMain.on('widget:move-fast', (event, payload) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return;
  if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return;
  const bounds = widgetWindow.getBounds();
  const position = clampWidgetPosition(payload.x, payload.y, bounds);
  widgetWindow.setPosition(position.x, position.y);
});

ipcMain.handle('widget:move', (event, payload) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return null;
  if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return null;
  const bounds = widgetWindow.getBounds();
  const position = clampWidgetPosition(payload.x, payload.y, bounds);
  widgetWindow.setPosition(position.x, position.y);
  return position;
});

ipcMain.on('app:open-settings', event => {
  if (event.sender === widgetWindow?.webContents) showSettings();
});

ipcMain.on('app:settings-saved', event => {
  if (event.sender !== settingsWindow?.webContents || !widgetWindow) return;
  widgetWindow.webContents.reload();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('local.netmeter.desktop');
  await startLocalServer(await loadControllerConfig());
  widgetWindowState = await loadWidgetWindowState();
  createTray();
  showWidget();
  showSettings();
  if (!existsSync(startMenuShortcutPath())) installStartMenuShortcut();
});

app.on('activate', showWidget);
app.on('before-quit', () => {
  quitting = true;
  saveWidgetWindowState();
  server?.close();
  tray?.destroy();
});
