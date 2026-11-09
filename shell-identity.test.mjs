import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ID, shellIdentity } from './shell-identity.mjs';
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
test('Windows relaunch metadata names NetMeter and preserves the app command and icon', () => {
  const identity = shellIdentity('C:\\Program Files\\Electron\\electron.exe', 'C:\\My Projects\\NetMeter', 'C:\\Data\\netmeter.ico');
  assert.equal(identity.window.appId, APP_ID);
  assert.equal(identity.window.relaunchDisplayName, 'NetMeter');
  assert.equal(identity.window.relaunchCommand, '"C:\\Program Files\\Electron\\electron.exe" "C:\\My Projects\\NetMeter"');
  assert.equal(identity.window.appIconPath, identity.shortcut.icon);
  assert.equal(identity.shortcut.appUserModelId, APP_ID);
  assert.equal(identity.shortcut.args, '"C:\\My Projects\\NetMeter"');
  assert.equal(identity.window.appIconIndex, 0);
});
test('the settings window and every tile publish relaunch metadata and old shortcuts are repaired on every start', () => {
  assert.match(main, /settingsWindow\.setAppDetails\(shellIdentity/);
  assert.match(main, /window\.setAppDetails\(shellIdentity/);
  assert.match(main, /shell\.writeShortcutLink\(startMenuShortcutPath\(\), 'update'/);
  assert.match(main, /app\.setName\('NetMeter'\)/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(main, /await installStartMenuShortcut\(\);/);
});
