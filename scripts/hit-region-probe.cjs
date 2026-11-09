// Visible native hit-test probe using the production Electron main process.
const { app, BrowserWindow, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { basename, join, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'netmeter-hit-region-'));
const userData = join(profile, 'user-data');
const statePath = join(profile, 'underlay-state.json');
const stopPath = join(profile, 'underlay-stop');
const previewPath = join(tmpdir(), 'netmeter-hit-region-preview.png');
const port = 4198;
app.setPath('appData', profile);
app.setPath('userData', userData);
process.env.PORT = String(port);

const log = [];
let failed = 0;
let underlayProcess;
let underlayState;
let originalCursor;

function check(name, pass, detail) {
  log.push((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
  if (!pass) failed += 1;
}

const pause = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitFor(predicate, timeout = 12000, step = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(step);
  }
  return null;
}

function tileKeyOf(window) {
  try {
    return new URL(window.webContents.getURL()).searchParams.get('key') || '';
  } catch {
    return '';
  }
}

function tileWindows() {
  return BrowserWindow.getAllWindows().filter(window => tileKeyOf(window));
}

function nativeHandle(window) {
  return BigInt.asUintN(64, window.getNativeWindowHandle().readBigUInt64LE(0)).toString();
}

function readUnderlay() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); }
  catch { return null; }
}

function nativeHit(x, y, click = false) {
  const quote = String.fromCharCode(34);
  const source = `using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class NetMeterHitRegionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport(${quote}user32.dll${quote}, ExactSpelling=true)] private static extern IntPtr WindowFromPoint(POINT point);
  [DllImport(${quote}user32.dll${quote})] private static extern bool SetCursorPos(int x, int y);
  [DllImport(${quote}user32.dll${quote}, EntryPoint=${quote}mouse_event${quote})] private static extern void MouseEvent(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public static long Hit(int x, int y) { return WindowFromPoint(new POINT { X = x, Y = y }).ToInt64(); }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    MouseEvent(0x0002, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(50);
    MouseEvent(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}`;
  const command = `$source = @'
${source}
'@
Add-Type -TypeDefinition $source
$hit = [NetMeterHitRegionProbe]::Hit(${Math.round(x)}, ${Math.round(y)})
if (${click ? '$true' : '$false'}) { [NetMeterHitRegionProbe]::Click(${Math.round(x)}, ${Math.round(y)}) }
[Console]::WriteLine($hit.ToString())`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Native hit-test command failed').trim());
  const value = (result.stdout || '').trim().split(/\r?\n/).at(-1);
  if (!/^-?\d+$/.test(value)) throw new Error('Native hit-test returned an invalid handle: ' + value);
  return BigInt.asUintN(64, BigInt(value)).toString();
}

function readSystemCursor() {
  const source = `using System;
using System.Runtime.InteropServices;
public static class NetMeterCursorProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll", ExactSpelling=true)] private static extern bool GetCursorPos(out POINT point);
  public static POINT Read() { GetCursorPos(out POINT point); return point; }
}`;
  const command = `$source = @'
${source}
'@
Add-Type -TypeDefinition $source
$point = [NetMeterCursorProbe]::Read()
[Console]::WriteLine($point.X.ToString() + ',' + $point.Y.ToString())`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Cursor query failed').trim());
  const match = (result.stdout || '').trim().match(/^(-?\d+),(-?\d+)$/);
  if (!match) throw new Error('Cursor query returned invalid coordinates');
  return { x: Number(match[1]), y: Number(match[2]) };
}

function restoreSystemCursor(point) {
  const source = `using System.Runtime.InteropServices;
public static class NetMeterCursorRestore {
  [DllImport("user32.dll", ExactSpelling=true)] private static extern bool SetCursorPos(int x, int y);
  public static bool Restore(int x, int y) { return SetCursorPos(x, y); }
}`;
  const command = `$source = @'
${source}
'@
Add-Type -TypeDefinition $source
if (-not [NetMeterCursorRestore]::Restore(${Math.round(point.x)}, ${Math.round(point.y)})) { exit 1 }`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Cursor restore failed').trim());
}

async function clickUnderlay(name, point) {
  const before = readUnderlay()?.clicks ?? -1;
  const hit = nativeHit(point.x, point.y);
  check(name + ' resolves to the lower application button', hit === underlayState.buttonHandle, { point, hit, expected: underlayState.buttonHandle });
  nativeHit(point.x, point.y, true);
  const clicked = await waitFor(() => {
    const state = readUnderlay();
    return state && state.clicks > before ? state : null;
  }, 4000, 50);
  check(name + ' receives a real system mouse click', Boolean(clicked), { before, after: clicked?.clicks ?? readUnderlay()?.clicks ?? null });
}

function removeProfile() {
  const tempRoot = resolve(tmpdir()) + sep;
  const candidate = resolve(profile);
  if (candidate.startsWith(tempRoot) && basename(candidate).startsWith('netmeter-hit-region-')) {
    rmSync(candidate, { recursive: true, force: true });
  }
}

app.once('will-quit', removeProfile);
setTimeout(() => { console.error('Native hit-region probe hard deadline'); app.exit(2); }, 110000);

(async () => {
  await app.whenReady();
  const display = screen.getPrimaryDisplay();
  const work = display.workArea;
  if (process.platform !== 'win32') throw new Error('This probe requires Windows native hit testing');
  if (display.scaleFactor !== 1) throw new Error('Native screen-coordinate click probe requires the verified 100% display scale');
  if (work.width < 780 || work.height < 620) throw new Error('Primary work area is too small for the isolated two-tile probe');

  const underlayX = work.x + 20;
  const underlayY = Math.max(work.y, 40);
  originalCursor = readSystemCursor();
  const alphaPosition = { x: underlayX + 40, y: underlayY + 40 };
  const bravoPosition = { x: underlayX + 500, y: underlayY + 40 };
  writeFileSync(join(userData, 'tile-layout.json'), JSON.stringify({
    version: 2,
    tiles: { 'alpha.test': alphaPosition, 'bravo.test': bravoPosition }
  }));
  writeFileSync(join(userData, 'shared-state.json'), JSON.stringify({
    version: 1,
    entries: [{ url: 'alpha.test', visible: true }, { url: 'bravo.test', visible: true }]
  }));

  underlayProcess = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'scripts', 'hit-region-underlay.ps1'),
    '-X', String(underlayX), '-Y', String(underlayY), '-Width', '720', '-Height', '190',
    '-StatePath', statePath, '-StopPath', stopPath
  ], { windowsHide: true, stdio: 'ignore' });
  underlayState = await waitFor(() => readUnderlay());
  if (!underlayState) throw new Error('The lower test application did not become ready');
  check('the lower button belongs to a separate Windows process', underlayState.processId !== process.pid, {
    electronProcessId: process.pid,
    underlayProcessId: underlayState.processId
  });

  await import(pathToFileURL(join(root, 'main.mjs')).href);
  const settings = await waitFor(() => BrowserWindow.getAllWindows().find(window => /view=settings/.test(window.webContents.getURL()) && !window.webContents.isLoading()));
  if (!settings) throw new Error('The isolated production main process did not start');
  const tiles = await waitFor(() => {
    const found = tileWindows();
    return found.length === 2 ? found : null;
  });
  if (!tiles) throw new Error('The isolated production tiles did not start');
  const alpha = tiles.find(window => tileKeyOf(window) === 'alpha.test');
  const bravo = tiles.find(window => tileKeyOf(window) === 'bravo.test');
  if (!alpha || !bravo) throw new Error('The isolated tile identities are incomplete');
  check('the visible probe uses separate compact tile windows', tiles.every(window => {
    const bounds = window.getBounds();
    return bounds.width === 192 && bounds.height === 160;
  }), tiles.map(window => ({ key: tileKeyOf(window), bounds: window.getBounds() })));

  const alphaHandle = nativeHandle(alpha);
  const hostPoint = await alpha.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.host-button').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const alphaBounds = alpha.getBounds();
  const tilePoint = { x: Math.round(alphaBounds.x + hostPoint.x), y: Math.round(alphaBounds.y + hostPoint.y) };
  const tileHit = nativeHit(tilePoint.x, tilePoint.y);
  check('a visible tile button resolves to its own native window', tileHit === alphaHandle, { point: tilePoint, hit: tileHit, tile: alphaHandle });
  nativeHit(tilePoint.x, tilePoint.y, true);
  const historyOpened = await waitFor(() => alpha.getBounds().width === 380 && alpha.getBounds().height === 306 ? true : null);
  check('a real mouse click on the domain button opens history', Boolean(historyOpened), alpha.getBounds());

  if (historyOpened) {
    const historyClose = await alpha.webContents.executeJavaScript(`(() => {
      const rect = document.getElementById('closeDialog').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const historyBounds = alpha.getBounds();
    const closePoint = { x: Math.round(historyBounds.x + historyClose.x), y: Math.round(historyBounds.y + historyClose.y) };
    const historyHit = nativeHit(closePoint.x, closePoint.y);
    check('the expanded history control resolves to the tile window', historyHit === alphaHandle, { point: closePoint, hit: historyHit, tile: alphaHandle });
    nativeHit(closePoint.x, closePoint.y, true);
    const historyClosed = await waitFor(() => alpha.getBounds().width === 192 && alpha.getBounds().height === 160 ? true : null);
    check('a real mouse click on the history close button restores the tile', Boolean(historyClosed), alpha.getBounds());
  }

  const restoredBounds = alpha.getBounds();
  await clickUnderlay('the transparent tile padding', { x: restoredBounds.x + 1, y: restoredBounds.y + 1 });
  await clickUnderlay('the original overlay band between scattered tiles', { x: underlayX + 300, y: underlayY + 100 });
  await clickUnderlay('another lower-app button in the original overlay band', { x: underlayX + 360, y: underlayY + 150 });

  const screenshot = await alpha.webContents.capturePage();
  writeFileSync(previewPath, screenshot.toPNG());
  check('the isolated Electron preview was captured for visual inspection', existsSync(previewPath), { path: previewPath });

})().catch(error => {
  failed += 1;
  console.error(error.stack || String(error));
}).finally(async () => {
  try { writeFileSync(stopPath, 'stop'); } catch {}
  if (underlayProcess && underlayProcess.exitCode === null) {
    await Promise.race([
      new Promise(resolveExit => underlayProcess.once('exit', resolveExit)),
      pause(3000).then(() => { underlayProcess.kill(); })
    ]);
  }
  try {
    if (originalCursor) restoreSystemCursor(originalCursor);
  } catch (error) {
    failed += 1;
    console.error('Failed to restore the desktop cursor: ' + (error.stack || String(error)));
  }
  console.log(log.join('\n'));
  console.log('failed=' + failed);
  app.quit();
  setTimeout(() => app.exit(failed ? 1 : 0), 8000);
})();
