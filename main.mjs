import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, safeStorage, shell, dialog } from 'electron';
import { resolve, dirname, join } from 'node:path';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNetMeterServer } from './server.mjs';
import { createPinToStartAction } from './start-menu.mjs';
import { APP_ID, shellIdentity } from './shell-identity.mjs';
import { TILE_HEIGHT, TILE_WIDTH } from './drag-geometry.mjs';
import { createDragController } from './tile-drag.mjs';
import { defaultTilePosition as getDefaultTilePosition } from './tile-layout.mjs';
import { historyWindowInputRegion, TILE_WINDOW_INPUT_REGION } from './tile-window-region.mjs';

const root = dirname(fileURLToPath(import.meta.url));
app.setName('NetMeter');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => { if (app.isReady()) { showTiles(); showSettings(); } });

// Every visible tile owns one independent frameless native window. The native
// window is slightly larger than the tile so the CSS shadow keeps a fixed and
// separate padding; the tile content box itself stays exactly 180x148.
const TILE_PADDING = 6;
const TILE_WINDOW_WIDTH = TILE_WIDTH + TILE_PADDING * 2;
const TILE_WINDOW_HEIGHT = TILE_HEIGHT + TILE_PADDING * 2;
const HISTORY_WIDTH = 380;
const HISTORY_HEIGHT = 306;
const LAYOUT_VERSION = 2;
const SHARED_STATE_VERSION = 1;

let server;
let serverPort;
let settingsWindow;
let emptyWindow;
let tray;
let quitting = false;
let uiLanguage = 'zh';
let shutdownStarted = false;
let shutdownFinished = false;
let layout = { version: LAYOUT_VERSION, tiles: {} };
let sharedState = { version: SHARED_STATE_VERSION, entries: [] };
let legacyWidgetOrigin = null;
let layoutWriteQueue = Promise.resolve();
let sharedStateWriteQueue = Promise.resolve();
let tilesVisible = true;
let sharedStateReceived = false;

const tiles = new Map();

const UI_STRINGS = {
  zh: {
    titleWidget: 'NetMeter 控制器方格',
    settingsTitle: 'NetMeter 设置',
    showHideWidget: '显示/隐藏方格',
    settings: '设置',
    pinToStart: '固定到开始菜单…',
    pinTitle: '固定 NetMeter 到开始菜单',
    pinManual: '请在 Windows 右键菜单中完成固定',
    pinManualDetail: '快捷方式已准备好，但尚未固定。点击“打开快捷方式位置”，在选中的 NetMeter 上右键，选择“固定到开始”或“固定到开始屏幕”；若未显示，请先点“显示更多选项”。',
    pinOpenShortcut: '打开快捷方式位置',
    pinActionFailed: '固定操作未完成，请重试。',
    pinInstallFailed: '无法创建 NetMeter 快捷方式',
    pinInstallFailedDetail: '未执行固定。请检查开始菜单文件夹的写入权限后重试。',
    pinSuccess: 'NetMeter 已固定到开始菜单',
    pinAlready: 'NetMeter 已经固定到开始菜单',
    ok: '确定',
    cancel: '取消',
    hideWidget: '隐藏方格',
    quit: '退出 NetMeter'
  },
  en: {
    titleWidget: 'NetMeter Controller Tiles',
    settingsTitle: 'NetMeter Settings',
    showHideWidget: 'Show/Hide tiles',
    settings: 'Settings',
    pinToStart: 'Pin to Start…',
    pinTitle: 'Pin NetMeter to Start',
    pinManual: 'Finish pinning in the Windows context menu',
    pinManualDetail: 'The shortcut is ready, but it is not pinned yet. Click “Open shortcut location”, right-click the selected NetMeter shortcut and choose “Pin to Start”. If it is missing, choose “Show more options” first.',
    pinOpenShortcut: 'Open shortcut location',
    pinActionFailed: 'Pinning did not finish. Please try again.',
    pinInstallFailed: 'Could not create the NetMeter shortcut',
    pinInstallFailedDetail: 'Nothing was pinned. Check write access to the Start Menu folder and try again.',
    pinSuccess: 'NetMeter is now pinned to Start',
    pinAlready: 'NetMeter is already pinned to Start',
    ok: 'OK',
    cancel: 'Cancel',
    hideWidget: 'Hide tiles',
    quit: 'Quit NetMeter'
  }
};

function strings() {
  return UI_STRINGS[uiLanguage] || UI_STRINGS.zh;
}

const pinToStartMenu = createPinToStartAction({
  installShortcut: installStartMenuShortcut,
  requestPin: requestStartMenuPin,
  revealShortcut: () => shell.showItemInFolder(startMenuShortcutPath()),
  getStrings: strings,
  showDialog: options => {
    const parent = settingsWindow?.isVisible() ? settingsWindow : firstVisibleTileWindow();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }
});

function controllerConfigPath() {
  return join(app.getPath('userData'), 'controller-config.bin');
}

function layoutPath() {
  return join(app.getPath('userData'), 'tile-layout.json');
}

function sharedStatePath() {
  return join(app.getPath('userData'), 'shared-state.json');
}

function legacyWidgetStatePath() {
  return join(app.getPath('userData'), 'widget-window.json');
}

function appIconPath() {
  return join(app.getPath('userData'), 'netmeter.ico');
}

function bundledAppIconPath() {
  return resolve(root, 'assets', 'tray', 'netmeter.ico');
}

async function ensureAppIcon() {
  const source = bundledAppIconPath();
  const target = appIconPath();
  if (nativeImage.createFromPath(source).isEmpty()) throw new Error('NetMeter app icon could not be loaded');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

function startMenuShortcutPath() {
  return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NetMeter.lnk');
}

async function loadLegacyWidgetOrigin() {
  try {
    const stored = JSON.parse(await readFile(legacyWidgetStatePath(), 'utf8'));
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return { x: stored.x, y: stored.y };
  } catch {
    // No legacy widget origin yet.
  }
  return null;
}

async function loadLayout() {
  try {
    const stored = JSON.parse(await readFile(layoutPath(), 'utf8'));
    if (stored?.version !== LAYOUT_VERSION || !stored.tiles || typeof stored.tiles !== 'object') return null;
    const tilesState = {};
    for (const [key, position] of Object.entries(stored.tiles)) {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      tilesState[key] = { x: Math.round(position.x), y: Math.round(position.y) };
    }
    return { version: LAYOUT_VERSION, tiles: tilesState };
  } catch {
    return null;
  }
}

function writeLayout() {
  const payload = JSON.stringify({ version: LAYOUT_VERSION, tiles: layout.tiles }, null, 2);
  layoutWriteQueue = layoutWriteQueue
    .then(() => writeFile(layoutPath(), payload, { mode: 0o600 }))
    .catch(() => {});
  return layoutWriteQueue;
}

// Layout writes are serialized in the main process, so one renderer can never
// overwrite another tile with an old shared snapshot.
function persistTilePositions(positions) {
  let changed = false;
  for (const [key, position] of Object.entries(positions || {})) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    const next = { x: Math.round(position.x), y: Math.round(position.y) };
    const current = layout.tiles[key];
    if (current && current.x === next.x && current.y === next.y) continue;
    layout.tiles[key] = next;
    changed = true;
  }
  if (!changed) return layoutWriteQueue;
  return writeLayout();
}

function writeSharedState() {
  const payload = JSON.stringify(sharedState, null, 2);
  sharedStateWriteQueue = sharedStateWriteQueue
    .then(() => writeFile(sharedStatePath(), payload, { mode: 0o600 }))
    .catch(() => {});
  return sharedStateWriteQueue;
}

async function loadSharedState() {
  try {
    const stored = JSON.parse(await readFile(sharedStatePath(), 'utf8'));
    if (stored?.version !== SHARED_STATE_VERSION || !Array.isArray(stored.entries)) return null;
    return { version: SHARED_STATE_VERSION, entries: stored.entries };
  } catch {
    return null;
  }
}

// The previous build stored one widget origin plus renderer relative
// positions. They are migrated once into absolute desktop coordinates; the
// traffic data, the credentials and the configuration stay untouched.
function migrateLegacyLayout(legacyPositions) {
  // The migration runs at most once: an existing layout is never rewritten.
  if (Object.keys(layout.tiles).length) return false;
  if (!legacyWidgetOrigin || !legacyPositions) return false;
  const migrated = {};
  for (const [key, position] of Object.entries(legacyPositions)) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    migrated[key] = {
      x: Math.round(legacyWidgetOrigin.x + position.x),
      y: Math.round(legacyWidgetOrigin.y + position.y)
    };
  }
  if (!Object.keys(migrated).length) return false;
  layout = { version: LAYOUT_VERSION, tiles: migrated };
  writeLayout();
  return true;
}

function installStartMenuShortcut() {
  return new Promise(resolveResult => {
    const script = resolve(root, 'scripts', 'install-start-menu.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPath', process.execPath, '-Arguments', `"${root}"`, '-WorkingDirectory', root, '-IconPath', appIconPath(), '-ShortcutPath', startMenuShortcutPath()], { windowsHide: true });
    child.on('error', () => resolveResult(false));
    child.on('close', code => {
      if (code !== 0) { resolveResult(false); return; }
      // Give the .lnk the same explicit identity as the taskbar window.
      try { resolveResult(shell.writeShortcutLink(startMenuShortcutPath(), 'update', shellIdentity(process.execPath, root, appIconPath()).shortcut)); }
      catch { resolveResult(false); }
    });
  });
}

function requestStartMenuPin() {
  return new Promise(resolveResult => {
    const script = resolve(root, 'scripts', 'pin-start-menu.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ShortcutPath', startMenuShortcutPath()], { windowsHide: true });
    let output = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ state: 'manual-required', reason: 'timeout' });
    }, 12000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (output.length < 8192) output += chunk; });
    child.on('error', () => finish({ state: 'manual-required', reason: 'launch-failed' }));
    child.on('close', () => {
      try { finish(JSON.parse(output.trim())); }
      catch { finish({ state: 'manual-required', reason: 'invalid-response' }); }
    });
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
  server = createNetMeterServer({ projectRoot: root, initialConfig, onConfigChanged: persistControllerConfig, trafficStorePath: join(app.getPath('userData'), 'traffic.sqlite') });
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

function pageUrl(view, key) {
  const url = new URL(`http://127.0.0.1:${serverPort}/`);
  url.searchParams.set('view', view);
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

function firstVisibleTileWindow() {
  for (const tile of tiles.values()) {
    if (!tile.window.isDestroyed() && tile.window.isVisible()) return tile.window;
  }
  return null;
}

function tileBoundsUnion() {
  let union = null;
  for (const tile of tiles.values()) {
    if (tile.window.isDestroyed()) continue;
    const bounds = tile.window.getBounds();
    if (!union) {
      union = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      continue;
    }
    const left = Math.min(union.x, bounds.x);
    const top = Math.min(union.y, bounds.y);
    union = {
      x: left,
      y: top,
      width: Math.max(union.x + union.width, bounds.x + bounds.width) - left,
      height: Math.max(union.y + union.height, bounds.y + bounds.height) - top
    };
  }
  return union;
}

function placeSettingsBesideTiles() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const union = tileBoundsUnion();
  if (!union) return;
  const settingsBounds = settingsWindow.getBounds();
  const overlaps = union.x < settingsBounds.x + settingsBounds.width &&
    union.x + union.width > settingsBounds.x &&
    union.y < settingsBounds.y + settingsBounds.height &&
    union.y + union.height > settingsBounds.y;
  if (!overlaps) return;
  const workArea = screen.getDisplayMatching(union).workArea;
  const clampX = value => Math.max(workArea.x, Math.min(workArea.x + workArea.width - settingsBounds.width, value));
  const clampY = value => Math.max(workArea.y, Math.min(workArea.y + workArea.height - settingsBounds.height, value));
  const candidates = [
    { x: union.x + union.width + 12, y: clampY(union.y) },
    { x: union.x - settingsBounds.width - 12, y: clampY(union.y) },
    { x: clampX(union.x), y: union.y + union.height + 12 },
    { x: clampX(union.x), y: union.y - settingsBounds.height - 12 }
  ];
  const position = candidates.find(candidate => candidate.x >= workArea.x && candidate.y >= workArea.y &&
    candidate.x + settingsBounds.width <= workArea.x + workArea.width &&
    candidate.y + settingsBounds.height <= workArea.y + workArea.height);
  if (!position) return;
  settingsWindow.setPosition(position.x, position.y);
}

function recordWindowFailure(view, code) {
  // No page URLs, configuration, website history or credentials in diagnostics.
  appendFile(join(app.getPath('userData'), 'window-load-errors.jsonl'), JSON.stringify({ at: Date.now(), view, code }) + '\n').catch(() => {});
}

function applyTileInputRegion(tile) {
  const window = tile?.window;
  if (!window || window.isDestroyed() || !['win32', 'linux'].includes(process.platform)) return;
  try {
    if (tile.historyOpen) {
      const [width, height] = window.getContentSize();
      window.setShape(historyWindowInputRegion(width, height));
    } else {
      window.setShape(TILE_WINDOW_INPUT_REGION);
    }
    tile.inputRegionScaleFactor = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  } catch {
    if (tile.inputRegionFailureRecorded) return;
    tile.inputRegionFailureRecorded = true;
    recordWindowFailure('tile-input-region', 'set_shape_failed');
  }
}

function refreshTileInputRegions() {
  for (const tile of tiles.values()) applyTileInputRegion(tile);
}

function loadSettingsPage(window) {
  window.netmeterPageReady = false;
  window.loadURL(pageUrl('settings')).catch(() => {
    if (window.isDestroyed()) return;
    recordWindowFailure('settings', 'load_failed');
    window.netmeterLoadFailed = true;
    const text = uiLanguage === 'en' ? 'Settings failed to load. Close and reopen this window to retry.' : '设置加载失败，请关闭此窗口后重新打开以重试。';
    window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><meta charset="utf-8"><title>NetMeter</title><body style="font:14px Segoe UI,sans-serif;padding:24px;background:white;color:#183249"><h2>NetMeter</h2><p>' + text + '</p></body></html>')).catch(() => {});
  });
}

function presentSettings(window) {
  if (!window || window.isDestroyed() || !window.netmeterPageReady || !window.netmeterShowRequested) return;
  window.setAlwaysOnTop(true, 'screen-saver');
  window.show();
  window.focus();
}

function ensureSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
  settingsWindow = new BrowserWindow({
    show: false,
    width: 560,
    height: 740,
    minWidth: 440,
    minHeight: 600,
    title: strings().settingsTitle,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: resolve(root, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.setAppDetails(shellIdentity(process.execPath, root, appIconPath()).window);
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.netmeterPageReady = true;
      presentSettings(settingsWindow);
    }
  });
  settingsWindow.webContents.on('render-process-gone', (_event, details) => {
    recordWindowFailure('settings', details.reason);
    settingsWindow.netmeterLoadFailed = true;
  });
  settingsWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      settingsWindow.netmeterShowRequested = false;
      settingsWindow.hide();
      settingsWindow.setAlwaysOnTop(false);
    }
  });
  loadSettingsPage(settingsWindow);
  return settingsWindow;
}

// One singleton settings window serves every tile. A gear click from any tile
// focuses this instance instead of opening a second configuration surface.
function showSettings() {
  const window = ensureSettingsWindow();
  window.setTitle(strings().settingsTitle);
  placeSettingsBesideTiles();
  window.netmeterShowRequested = true;
  if (window.netmeterLoadFailed) {
    window.netmeterLoadFailed = false;
    window.webContents.once('did-finish-load', () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.netmeterPageReady = true;
        presentSettings(settingsWindow);
      }
    });
    loadSettingsPage(window);
  }
  presentSettings(window);
}

function showTiles() {
  tilesVisible = true;
  for (const tile of tiles.values()) {
    if (tile.window.isDestroyed()) continue;
    tile.window.show();
    tile.window.setAlwaysOnTop(true, 'screen-saver');
  }
  if (emptyWindow && !emptyWindow.isDestroyed()) emptyWindow.show();
}

function hideTiles() {
  tilesVisible = false;
  for (const tile of tiles.values()) {
    if (tile.window.isDestroyed()) continue;
    tile.window.hide();
  }
  if (emptyWindow && !emptyWindow.isDestroyed()) emptyWindow.hide();
}

function toggleTiles() {
  if (tilesVisible) hideTiles();
  else showTiles();
}

function defaultTilePosition(index) {
  return getDefaultTilePosition(index, screen.getPrimaryDisplay().workArea);
}

function createTileWindow(key) {
  const window = new BrowserWindow({
    show: false,
    width: TILE_WINDOW_WIDTH,
    height: TILE_WINDOW_HEIGHT,
    minWidth: TILE_WINDOW_WIDTH,
    minHeight: TILE_WINDOW_HEIGHT,
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
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.setAppDetails(shellIdentity(process.execPath, root, appIconPath()).window);
  window.setAlwaysOnTop(true, 'screen-saver');
  const tile = { key, window, historyOpen: false, historyBounds: null };
  tiles.set(key, tile);
  applyTileInputRegion(tile);
  window.on('resize', () => applyTileInputRegion(tile));
  window.on('move', () => {
    if (screen.getDisplayMatching(window.getBounds()).scaleFactor !== tile.inputRegionScaleFactor) {
      applyTileInputRegion(tile);
    }
  });
  window.on('closed', () => {
    if (dragController.active && dragController.state.key === key) dragController.cancel();
    tiles.delete(key);
    updateEmptyState();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    recordWindowFailure('tile', details.reason);
    if (dragController.active && dragController.state.key === key) dragController.cancel();
  });
  window.webContents.on('did-finish-load', () => applyTileInputRegion(tile));
  window.webContents.on('context-menu', () => {
    if (window.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      { label: strings().settings, click: showSettings },
      { id: 'pin-to-start', label: strings().pinToStart, click: () => { pinToStartMenu().catch(() => { dialog.showErrorBox(strings().pinTitle, strings().pinActionFailed); }); } },
      { label: strings().hideWidget, click: hideTiles },
      { type: 'separator' },
      { label: strings().quit, click: () => app.quit() }
    ]);
    menu.popup({ window });
  });
  window.loadURL(pageUrl('tile', key));
  positionTile(key);
  return tile;
}

function positionTile(key) {
  const tile = tiles.get(key);
  if (!tile || tile.window.isDestroyed()) return;
  const stored = layout.tiles[key];
  if (!stored) return;
  // The stored position is the tile content origin; the native window keeps the
  // fixed shadow padding around it.
  tile.window.setPosition(Math.round(stored.x - TILE_PADDING), Math.round(stored.y - TILE_PADDING));
}

function updateEmptyState() {
  // The empty state only appears once the shared domain list is known, so the
  // desktop never flashes an empty surface while the tiles are still loading.
  if (!sharedStateReceived || quitting) return;
  const needed = tiles.size === 0;
  if (needed && !emptyWindow) {
    emptyWindow = new BrowserWindow({
      show: false,
      width: TILE_WINDOW_WIDTH,
      height: TILE_WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
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
    emptyWindow.setAlwaysOnTop(true, 'screen-saver');
    emptyWindow.setIgnoreMouseEvents(true);
    emptyWindow.loadURL(pageUrl('empty'));
    const origin = legacyWidgetOrigin || defaultTilePosition(0);
    emptyWindow.setPosition(Math.round(origin.x - TILE_PADDING), Math.round(origin.y - TILE_PADDING));
  }
  if (!needed && emptyWindow && !emptyWindow.isDestroyed()) {
    emptyWindow.destroy();
    emptyWindow = null;
  }
  if (emptyWindow && !emptyWindow.isDestroyed()) {
    if (tilesVisible) emptyWindow.show();
    else emptyWindow.hide();
  }
}

function reconcileTiles(entries) {
  const visible = (entries || []).filter(entry => entry && entry.visible !== false && typeof entry.url === 'string' && entry.url.trim());
  const wanted = visible.map(entry => entry.url.trim());
  const wantedSet = new Set(wanted);
  for (const [key, tile] of [...tiles]) {
    if (wantedSet.has(key)) continue;
    if (dragController.active && dragController.state.key === key) dragController.cancel();
    tiles.delete(key);
    if (!tile.window.isDestroyed()) tile.window.destroy();
  }
  wanted.forEach((key, index) => {
    // Tiles that already exist keep their established placement.
    if (!layout.tiles[key]) layout.tiles[key] = defaultTilePosition(index);
  });
  for (const key of wanted) {
    if (!tiles.has(key)) createTileWindow(key);
  }
  writeLayout();
  updateEmptyState();
  if (tilesVisible) showTiles();
}

function applySharedState(state) {
  if (!state || !Array.isArray(state.entries)) return;
  sharedStateReceived = true;
  sharedState = { version: SHARED_STATE_VERSION, entries: state.entries };
  writeSharedState();
  if (!Object.keys(layout.tiles).length) migrateLegacyLayout(state.legacyPositions);
  reconcileTiles(sharedState.entries);
}

function createTray() {
  const iconPath = appIconPath();
  if (nativeImage.createFromPath(iconPath).isEmpty()) throw new Error('NetMeter tray icon could not be loaded');
  tray = new Tray(iconPath);
  tray.setToolTip('NetMeter');
  refreshTrayMenu();
  tray.on('click', toggleTiles);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: strings().showHideWidget, click: toggleTiles },
    { label: strings().settings, click: showSettings },
    { id: 'pin-to-start', label: strings().pinToStart, click: () => { pinToStartMenu().catch(() => { dialog.showErrorBox(strings().pinTitle, strings().pinActionFailed); }); } },
    { type: 'separator' },
    { label: strings().quit, click: () => app.quit() }
  ]));
}

function tileKeyFor(sender) {
  for (const [key, tile] of tiles) {
    if (!tile.window.isDestroyed() && tile.window.webContents === sender) return key;
  }
  return '';
}

// The cursor is read from the Electron screen module, which reports one
// consistent logical desktop coordinate space even when the gesture crosses a
// display with a different scale factor.
function cursorPoint(payload) {
  try {
    const point = screen.getCursorScreenPoint();
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
  } catch {
    // Fall back to the reported screen coordinates below.
  }
  if (payload && Number.isFinite(payload.screenX) && Number.isFinite(payload.screenY)) {
    return { x: payload.screenX, y: payload.screenY };
  }
  return null;
}

function sendDragFeedback(key, payload) {
  const tile = tiles.get(key);
  if (!tile || tile.window.isDestroyed()) return;
  tile.window.webContents.send('tile:drag-feedback', payload);
}

const dragController = createDragController({
  listTiles: () => [...tiles.values()].map(tile => ({
    key: tile.key,
    bounds: tile.window.isDestroyed() ? { x: 0, y: 0 } : tile.window.getBounds(),
    historyOpen: tile.historyOpen
  })),
  moveTile: (key, x, y) => {
    const tile = tiles.get(key);
    if (!tile || tile.window.isDestroyed()) return;
    tile.window.setPosition(Math.round(x), Math.round(y));
  },
  cursorAt: payload => cursorPoint(payload),
  feedback: (key, payload) => sendDragFeedback(key, payload),
  commit: positions => persistTilePositions(positions)
});

ipcMain.on('app:language', (event, language) => {
  const next = language === 'en' ? 'en' : 'zh';
  if (next === uiLanguage) return;
  uiLanguage = next;
  refreshTrayMenu();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setTitle(strings().settingsTitle);
  for (const tile of tiles.values()) {
    if (!tile.window.isDestroyed()) tile.window.setTitle(strings().titleWidget);
  }
});

// Every tile gear reaches the same singleton settings window.
ipcMain.on('app:open-settings', event => {
  const sender = event.sender;
  const fromTile = Boolean(tileKeyFor(sender));
  const fromSettings = Boolean(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents === sender);
  const fromEmpty = Boolean(emptyWindow && !emptyWindow.isDestroyed() && emptyWindow.webContents === sender);
  if (!fromTile && !fromSettings && !fromEmpty) return;
  showSettings();
});

ipcMain.on('app:shared-state', (event, state) => {
  const fromSettings = Boolean(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents === event.sender);
  if (!fromSettings) return;
  applySharedState(state);
});

ipcMain.on('tile:drag-down', (event, payload) => {
  const key = tileKeyFor(event.sender);
  if (!key) return;
  dragController.pointerDown({
    key,
    pointerId: payload.pointerId,
    gestureId: payload.gestureId,
    ctrl: Boolean(payload.ctrl),
    screenX: payload.screenX,
    screenY: payload.screenY
  });
});

ipcMain.on('tile:drag-modifier', (event, payload) => {
  const key = tileKeyFor(event.sender);
  if (!key) return;
  dragController.modifier({ key, gestureId: payload?.gestureId, ctrl: Boolean(payload?.ctrl) });
});

ipcMain.on('tile:drag-move', (event, payload) => {
  const key = tileKeyFor(event.sender);
  if (!key) return;
  dragController.pointerMove({
    key,
    pointerId: payload?.pointerId,
    gestureId: payload?.gestureId,
    ctrl: Boolean(payload?.ctrl),
    screenX: payload?.screenX,
    screenY: payload?.screenY
  });
});

ipcMain.on('tile:drag-up', (event, payload) => {
  const key = tileKeyFor(event.sender);
  if (!key) return;
  dragController.pointerUp({
    key,
    pointerId: payload?.pointerId,
    gestureId: payload?.gestureId,
    cancelled: Boolean(payload?.cancelled)
  });
});

ipcMain.on('tile:history-open', (event, open) => {
  const key = tileKeyFor(event.sender);
  if (!key) return;
  const tile = tiles.get(key);
  if (!tile || tile.window.isDestroyed()) return;
  const next = Boolean(open);
  if (next === tile.historyOpen) return;
  if (next) {
    tile.historyBounds = tile.window.getBounds();
    tile.historyOpen = true;
    tile.window.setMinimumSize(HISTORY_WIDTH, HISTORY_HEIGHT);
    tile.window.setMaximumSize(HISTORY_WIDTH, HISTORY_HEIGHT);
    tile.window.setContentSize(HISTORY_WIDTH, HISTORY_HEIGHT);
    applyTileInputRegion(tile);
    return;
  }
  tile.historyOpen = false;
  applyTileInputRegion(tile);
  tile.window.setMinimumSize(TILE_WINDOW_WIDTH, TILE_WINDOW_HEIGHT);
  tile.window.setMaximumSize(4000, 4000);
  tile.window.setContentSize(TILE_WINDOW_WIDTH, TILE_WINDOW_HEIGHT);
  const restore = tile.historyBounds;
  tile.historyBounds = null;
  if (restore) tile.window.setPosition(restore.x, restore.y);
});

ipcMain.handle('diag:drag', async (event, payload) => {
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

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  screen.on('display-metrics-changed', refreshTileInputRegions);
  screen.on('display-added', refreshTileInputRegions);
  screen.on('display-removed', refreshTileInputRegions);
  app.setAppUserModelId(APP_ID);
  await ensureAppIcon();
  await startLocalServer(await loadControllerConfig());
  legacyWidgetOrigin = await loadLegacyWidgetOrigin();
  layout = (await loadLayout()) || { version: LAYOUT_VERSION, tiles: {} };
  sharedState = (await loadSharedState()) || { version: SHARED_STATE_VERSION, entries: [] };
  createTray();
  // The settings window exists from the start so it can report the shared
  // domain list, but it stays hidden until a gear click or the tray asks for it.
  ensureSettingsWindow();
  reconcileTiles(sharedState.entries);
  // Repair older shortcuts that lacked AppUserModelID; this never pins them.
  await installStartMenuShortcut();
});

app.on('activate', showTiles);

async function finishShutdown() {
  await writeLayout();
  await writeSharedState();
  server?.netmeterCollector?.stop();
  const closed = server?.listening
    ? new Promise(resolve => server.close(resolve))
    : Promise.resolve();
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 4000))]);
  server?.netmeterLedger?.close();
  tray?.destroy();
  shutdownFinished = true;
  app.quit();
}

app.on('before-quit', event => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  quitting = true;
  finishShutdown().catch(() => {
    shutdownFinished = true;
    app.quit();
  });
});
