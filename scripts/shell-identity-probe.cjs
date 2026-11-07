// Read real per-window Windows property stores and persisted .lnk metadata.
const { app, BrowserWindow, shell, nativeImage } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'netmeter-shell-identity-probe-'));
app.setPath('appData', profile);
app.setPath('userData', path.join(profile, 'user-data'));
process.env.PORT = '4196';
const log = []; let failed = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok, detail) { if (!ok) failed += 1; log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail)); }
(async () => {
  await import(pathToFileURL(path.join(root, 'main.mjs')).href);
  await app.whenReady();
  const shortcut = path.join(profile, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NetMeter.lnk');
  let saved;
  for (let i = 0; i < 100; i += 1) {
    try { saved = shell.readShortcutLink(shortcut); if (saved.appUserModelId) break; } catch {}
    await pause(100);
  }
  if (!saved) throw Error('Start menu shortcut was not installed');
  check('shortcut has the explicit NetMeter application identity', saved.appUserModelId === 'local.netmeter.desktop', saved.appUserModelId);
  check('shortcut launches NetMeter, not an empty generic Electron window', saved.target === process.execPath && saved.args === '"' + root + '"', { target: saved.target, args: saved.args });
  const icon = path.join(app.getPath('userData'), 'netmeter.ico');
  check('shortcut explicitly uses the transfer-arrow icon', saved.icon === icon && saved.iconIndex === 0 && !nativeImage.createFromPath(saved.icon).isEmpty(), { icon: saved.icon, iconIndex: saved.iconIndex });
  const windows = BrowserWindow.getAllWindows();
  const handles = windows.map(win => win.getNativeWindowHandle().readBigUInt64LE().toString());
  const query = "Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class NetMeterWindowProperties {\n  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid fmtid; public uint pid; }\n  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr data; }\n  [ComImport, Guid(\"886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n  public interface Store {\n    [PreserveSig] int GetCount(out uint count);\n    [PreserveSig] int GetAt(uint index, out Key key);\n    [PreserveSig] int GetValue(ref Key key, out Value value);\n    [PreserveSig] int SetValue(ref Key key, ref Value value);\n    [PreserveSig] int Commit();\n  }\n  [DllImport(\"shell32.dll\")] public static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Store store);\n  [DllImport(\"ole32.dll\")] static extern int PropVariantClear(ref Value value);\n  public static string Read(long handle, uint id) {\n    var guid = new Guid(\"886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99\"); Store store;\n    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle), ref guid, out store));\n    var key = new Key { fmtid = new Guid(\"9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3\"), pid = id }; Value value;\n    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));\n    try { return value.type == 31 ? Marshal.PtrToStringUni(value.data) : \"\"; }\n    finally { PropVariantClear(ref value); Marshal.ReleaseComObject(store); }\n  }\n}\n'@\n$handles = @(__HANDLES__)\n$result = @()\nforeach ($handle in $handles) {\n  $result += @{ id=[NetMeterWindowProperties]::Read($handle,5); name=[NetMeterWindowProperties]::Read($handle,4); icon=[NetMeterWindowProperties]::Read($handle,3); command=[NetMeterWindowProperties]::Read($handle,2) }\n}\nConvertTo-Json -InputObject $result -Compress".replace('__HANDLES__', handles.join(','));
  const properties = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true }));
  check('native Windows properties are read for both real app windows', properties.length === 2, properties.length);
  for (const [index, value] of properties.entries()) {
    check(index + ' taskbar identity matches shortcut', value.id === saved.appUserModelId, value.id);
    check(index + ' relaunch display name is NetMeter, never Electron', value.name === 'NetMeter', value.name);
    check(index + ' relaunch icon is the real NetMeter ICO', value.icon.toLowerCase().includes(icon.toLowerCase()), value.icon);
    check(index + ' relaunch command includes both executable and app directory', value.command === '"' + process.execPath + '" "' + root + '"', value.command);
  }
  // Simulate the metadata copied into a new Windows pin without changing user pins.
  const newPin = path.join(profile, 'NetMeter-pin.lnk');
  const windowMetadata = properties[0];
  shell.writeShortcutLink(newPin, { ...saved, description: windowMetadata.name });
  const pin = shell.readShortcutLink(newPin);
  check('a newly materialized pin retains NetMeter name, identity and icon', pin.description === 'NetMeter' && pin.appUserModelId === saved.appUserModelId && pin.icon === icon, { id: pin.appUserModelId, icon: pin.icon });
  log.push(log.filter(line => line.startsWith('PASS ')).length + '/' + log.filter(line => /^(PASS|FAIL) /.test(line)).length + ' checks passed');
  writeFileSync(path.join(__dirname, 'shell-identity-probe.log'), log.join('\n')); app.quit(); app.exit(failed ? 1 : 0);
})().catch(error => { log.push('ERROR ' + (error.stack || String(error))); writeFileSync(path.join(__dirname, 'shell-identity-probe.log'), log.join('\n')); app.exit(1); });
