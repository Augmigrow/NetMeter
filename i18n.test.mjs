import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, 'index.html'), 'utf8');

function extractConst(name) {
  const start = source.indexOf('const ' + name + ' =');
  assert.notEqual(start, -1, `${name} not found in index.html`);
  const objectStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = objectStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart, index + 1);
    }
  }
  throw new Error(`unbalanced object ${name}`);
}

function loadI18n() {
  const tables = new Function('return ' + extractConst('I18N') + ';')();
  return tables;
}

function loadTranslator() {
  const code = [
    'const I18N = ' + extractConst('I18N') + ';',
    'let language = "zh";',
    extractConst('I18N') ? '' : '',
    source.slice(source.indexOf('function t(key, vars) {'), source.indexOf('function storedLanguage() {'))
  ].join('\n');
  return new Function(`${code}\nreturn { t, setLanguage: value => { language = value; } };`)();
}

const tables = loadI18n();

test('both languages define exactly the same set of keys', () => {
  const zhKeys = Object.keys(tables.zh).sort();
  const enKeys = Object.keys(tables.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length > 60, 'expected a full UI dictionary, got ' + zhKeys.length);
});

test('no translation is left empty', () => {
  Object.keys(tables.zh).forEach(key => {
    assert.ok(typeof tables.zh[key] === 'string' && tables.zh[key].trim(), `zh.${key} is empty`);
    assert.ok(typeof tables.en[key] === 'string' && tables.en[key].trim(), `en.${key} is empty`);
  });
});

test('the english dictionary contains no chinese characters', () => {
  Object.keys(tables.en).forEach(key => {
    assert.doesNotMatch(tables.en[key], /[\u4e00-\u9fff]/, `en.${key} still contains chinese: ${tables.en[key]}`);
  });
});

test('placeholders are identical across languages', () => {
  const placeholders = text => (text.match(/\{\w+\}/g) || []).sort();
  Object.keys(tables.zh).forEach(key => {
    assert.deepEqual(placeholders(tables.en[key]), placeholders(tables.zh[key]), `placeholders differ for ${key}`);
  });
});

test('the translator substitutes placeholders and falls back to chinese', () => {
  const { t } = loadTranslator();
  assert.equal(t('status.connected', { count: 3 }), '已连接 · 3 个活动连接');
  assert.equal(t('unknown.key'), 'unknown.key');
});

test('every data-i18n hook in the markup points at a known key', () => {
  const referenced = new Set();
  const pattern = /data-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source))) referenced.add(match[1]);
  assert.ok(referenced.size > 25, 'expected the markup to be translated, got ' + referenced.size);
  referenced.forEach(key => {
    assert.ok(Object.prototype.hasOwnProperty.call(tables.zh, key), `missing zh key ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(tables.en, key), `missing en key ${key}`);
  });
});

test('every key referenced from javascript exists in both languages', () => {
  const referenced = new Set();
  const pattern = /\bt\('([^']+)'/g;
  let match;
  while ((match = pattern.exec(source))) referenced.add(match[1]);
  assert.ok(referenced.size > 40, 'expected dynamic strings to be translated, got ' + referenced.size);
  referenced.forEach(key => {
    assert.ok(Object.prototype.hasOwnProperty.call(tables.zh, key), `missing zh key ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(tables.en, key), `missing en key ${key}`);
  });
});

test('the interface language is selectable and stored outside the settings blob', () => {
  assert.match(source, /<select id="language">/);
  assert.match(source, /<option value="zh">/);
  assert.match(source, /<option value="en">/);
  assert.match(source, /const LANGUAGE_KEY = 'netmeter-language';/);
  assert.match(source, /localStorage\.setItem\(LANGUAGE_KEY/);
  assert.doesNotMatch(source, /language: values\.language/);
});

test('switching the language repaints the tiles and the history panel', () => {
  assert.match(source, /function setLanguage\(next\)/);
  assert.match(source, /renderMeters\(\);\s*\n\s*if \(!historyPanel\.hidden\) renderHistoryPanel\(\);/);
  assert.match(source, /language !== renderedLanguage/);
});

test('the widget window follows a language switch made in the settings window', () => {
  assert.match(source, /event\.key === LANGUAGE_KEY/);
  assert.match(source, /if \(next !== language\) setLanguage\(next\);/);
});

test('the electron tray menu and settings title are localised', () => {
  const main = readFileSync(join(root, 'main.mjs'), 'utf8');
  assert.match(main, /const UI_STRINGS = \{/);
  assert.match(main, /showHideWidget: 'Show\/Hide tiles'/);
  assert.match(main, /title: strings\(\)\.settingsTitle/);
  assert.match(main, /ipcMain\.on\('app:language'/);
  const preload = readFileSync(join(root, 'preload.cjs'), 'utf8');
  assert.match(preload, /setLanguage: language => ipcRenderer\.send\('app:language', language\)/);
});

test('each window gets its own localised title', () => {
  assert.match(source, /document\.title = view === 'widget' \? t\('app\.titleWidget'\) : t\('app\.titleSettings'\);/);
  const main = readFileSync(join(root, 'main.mjs'), 'utf8');
  assert.match(main, /titleWidget: 'NetMeter Controller Tiles'/);
  assert.match(main, /title: strings\(\)\.titleWidget/);
  assert.match(main, /widgetWindow\.setTitle\(strings\(\)\.titleWidget\)/);
});
