import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = resolve('scripts/run-probe.ps1');

async function runFixture(source, timeout = 10, executable = process.execPath) {
  const dir = mkdtempSync(join(tmpdir(), 'netmeter runner '));
  const script = join(dir, 'fixture script.cjs');
  writeFileSync(script, source);
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', runner, '-Script', script, '-Executable', executable,
      '-TimeoutSeconds', String(timeout)], { windowsHide: true });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('probe runner drains both pipes and handles script paths with spaces', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const result = await runFixture("console.log('x'.repeat(200000)); console.error('y'.repeat(200000)); console.log('stdout-end'); console.error('stderr-end'); console.log('node-mode=' + process.env.ELECTRON_RUN_AS_NODE);");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /exit=0/);
  assert.match(result.output, /stdout-end/);
  assert.match(result.output, /stderr-end/);
  assert.match(result.output, /node-mode=undefined/);
});

test('probe runner propagates a nonzero child exit code', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const result = await runFixture("console.error('expected-failure'); process.exitCode = 7;");
  assert.equal(result.code, 7, result.output);
  assert.match(result.output, /exit=7/);
  assert.match(result.output, /expected-failure/);
});

test('probe runner times out and stops descendants', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const pidFile = join(tmpdir(), 'netmeter-probe-child-' + process.pid + '.txt');
  try {
    const source = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true}); require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ",String(c.pid)); setInterval(()=>{},1000);";
    const result = await runFixture(source, 2);
    assert.equal(result.code, 124, result.output);
    assert.match(result.output, /timed out/);
    assert.ok(existsSync(pidFile), 'fixture created its descendant');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(pidFile, { force: true });
  }
});

test('probe runner reports executable launch errors', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const result = await runFixture('', 10, 'Z:\\netmeter-missing\\electron.exe');
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Probe runner failed/);
});
