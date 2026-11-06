// Native bilingual pinning-guide acceptance using the real app/menu workflow.
// A mocked denied native pin request prevents tests from changing user Start pins.
const { app, BrowserWindow, Menu, dialog, desktopCapturer, shell, screen } = require('electron');
const { mkdtempSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const root = path.join(__dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'netmeter-start-menu-probe-'));
const logPath = path.join(__dirname, 'start-menu-probe.log');
const log = [];
let failed = 0, requests = 0, captures = 0;
const menus = [], dialogs = [], revealed = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('appData', profile);
app.setPath('userData', path.join(profile, 'user-data'));
mkdirSync(app.getPath('userData'), { recursive: true });
process.env.PORT = '4196';
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes(path.join(root, 'scripts', 'pin-start-menu.ps1'))) {
    requests += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', '{"state":"manual-required","reason":"native-request-blocked"}');
      child.emit('close', 0);
    });
    return child;
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => { const menu = buildMenu(template); menus.push(menu); return menu; };
const realDialog = dialog.showMessageBox.bind(dialog);
shell.showItemInFolder = target => { revealed.push(target); };
function nativeDialogBounds() {
  // Read only this process's #32770 dialog geometry; never other app content.
  const query = "Add-Type -TypeDefinition @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic static class NetMeterDialogBounds {\n  public delegate bool EnumProc(IntPtr h, IntPtr l);\n  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }\n  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc p, IntPtr l);\n  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\n  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);\n  [DllImport(\"dwmapi.dll\")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out Rect r, int n);\n}\n'@\n$script:found = $null\n$callback = [NetMeterDialogBounds+EnumProc]{\n  param($handle, $unused)\n  $owner = 0\n  [void][NetMeterDialogBounds]::GetWindowThreadProcessId($handle, [ref]$owner)\n  if ($owner -eq __OWNER_PID__) {\n    $name = New-Object System.Text.StringBuilder 64\n    [void][NetMeterDialogBounds]::GetClassName($handle, $name, 64)\n    if ($name.ToString() -eq '#32770') {\n      $rect = New-Object NetMeterDialogBounds+Rect\n      if ([NetMeterDialogBounds]::DwmGetWindowAttribute($handle, 9, [ref]$rect, 16) -eq 0) {\n        $script:found = @{ x=$rect.Left; y=$rect.Top; width=($rect.Right-$rect.Left); height=($rect.Bottom-$rect.Top) }\n        return $false\n      }\n    }\n  }\n  return $true\n}\n[void][NetMeterDialogBounds]::EnumWindows($callback, [IntPtr]::Zero)\n$script:found | ConvertTo-Json -Compress".replace('__OWNER_PID__', String(process.pid));
  const result = JSON.parse(childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true }));
  if (!result || result.width <= 0 || result.height <= 0) throw new Error('Own native dialog bounds unavailable');
  return screen.screenToDipRect(null, result);
}

function check(name, ok, detail) {
  if (!ok) failed += 1;
  log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
}
(async () => {
  await import(pathToFileURL(path.join(root, 'main.mjs')).href);
  await app.whenReady();
  let settings;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    settings = BrowserWindow.getAllWindows().find(win => /view=settings/.test(win.webContents.getURL()));
    if (settings && !settings.webContents.isLoading()) break;
    await pause(100);
  }
  if (!settings) throw new Error('Actual settings window was not created');
  const shortcut = path.join(profile, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NetMeter.lnk');
  for (let attempt = 0; attempt < 50 && !existsSync(shortcut); attempt += 1) await pause(100);
  check('startup installs the shortcut without requesting any pin', existsSync(shortcut) && requests === 0, { exists: existsSync(shortcut), requests });
  settings.setPosition(140, 100);
  settings.show();
  settings.focus();
  for (const language of ['zh', 'en']) {
    await settings.webContents.executeJavaScript("(() => { const select = document.getElementById('language'); select.value = " + JSON.stringify(language) + "; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await pause(200);
    let finished = false, dialogError;
    dialog.showMessageBox = async (...args) => {
      const options = args.pop();
      dialogs.push(options);
      const abort = new AbortController();
      const response = realDialog(...args, { ...options, signal: abort.signal });
      try {
        await pause(600);
        const capture = nativeDialogBounds();
        const display = screen.getDisplayMatching(capture);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)
        } });
        const source = sources.find(candidate => candidate.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty()) throw new Error('Native guide display capture unavailable');
        const size = source.thumbnail.getSize();
        const sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
        const image = source.thumbnail.crop({ x: Math.round((capture.x - display.bounds.x) * sx), y: Math.round((capture.y - display.bounds.y) * sy),
          width: Math.round(capture.width * sx), height: Math.round(capture.height * sy) });
        writeFileSync(path.join(root, 'docs', 'screenshots', 'start-menu-guide-' + language + '.png'), image.toPNG());
        captures += 1;
        check(language + ' native guide screenshot saved', true, image.getSize());
      } catch (error) { dialogError = error; }
      finally { abort.abort(); }
      const result = await response;
      finished = true;
      return result;
    };
    const menu = menus.filter(candidate => candidate.getMenuItemById('pin-to-start')).at(-1);
    const item = menu?.getMenuItemById('pin-to-start');
    check(language + ' actual tray menu has an actionable pin entry', Boolean(item && item.enabled && item.label.endsWith('…')), item?.label);
    item.click();
    for (let attempt = 0; attempt < 120 && !finished; attempt += 1) await pause(100);
    if (dialogError) throw dialogError;
    if (!finished) throw new Error('Pin action failed to show and finish its guide');
    const options = dialogs.at(-1);
    check(language + ' a denied native request shows guidance, never success',
      options.message === (language === 'zh' ? '请在 Windows 右键菜单中完成固定' : 'Finish pinning in the Windows context menu'), options.message);
    check(language + ' guide explains the unpinned shortcut and next action',
      language === 'zh' ? options.detail.includes('尚未固定') && options.detail.includes('右键') : options.detail.includes('not pinned yet') && options.detail.includes('right-click'), options.detail);
    check(language + ' guide provides an explicit open-location button and Cancel', options.buttons.length === 2 && options.defaultId === 0 && options.cancelId === 1, options.buttons);
    await pause(100);
  }
  check('each menu click requested native pinning only once', requests === 2, requests);
  check('cancelling guides never opened Explorer', revealed.length === 0, revealed.length);
  check('both actual native dialog captures were completed', captures === 2, captures);
  log.push(log.filter(line => line.startsWith('PASS ')).length + '/' + log.filter(line => /^(PASS|FAIL) /.test(line)).length + ' checks passed');
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.quit();
  app.exit(failed ? 1 : 0);
})().catch(error => {
  log.push('ERROR ' + (error.stack || String(error)));
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.exit(1);
});
