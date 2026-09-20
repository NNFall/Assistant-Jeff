// Restricted native regression suite. It launches only the repository's own
// fixture; helper inventory is bound to its verified PID/path/start time.
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repo = path.resolve(__dirname, '..');
const work = path.join(repo, 'work', 'windows-desktop');
let helperDir = path.join(work, 'test-bin');
let skipBuild = false;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--skip-build') skipBuild = true;
  else if (process.argv[index] === '--helper-dir' && process.argv[index + 1]) helperDir = path.resolve(repo, process.argv[++index]);
  else throw new Error('Usage: node scripts/test-native-windows-desktop.cjs [--helper-dir work/windows-desktop/test-bin] [--skip-build]');
}
const relativeHelper = path.relative(work, helperDir);
assert.ok(relativeHelper && !relativeHelper.startsWith('..') && !path.isAbsolute(relativeHelper), 'Test binaries must stay inside work/windows-desktop');
assert.equal(process.platform, 'win32', 'Native tests require Windows');
const fixtureExe = path.join(repo, 'work', 'desktop-lab', 'bin', 'JeffDesktopLabTarget.exe');
const helperExe = path.join(helperDir, 'JeffWindowsDesktopHelper.exe');
const reviewExe = path.join(helperDir, 'ReviewTests.exe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function command(executable, args, capture = false) {
  const result = spawnSync(executable, args, { cwd: repo, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', timeout: 120_000 });
  if (capture) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(executable)} failed`);
  return result.stdout || '';
}

let fixture;
let helper;
const checks = [];
const pending = new Map();
let requestId = 0;
async function run() {
  if (!fs.existsSync(fixtureExe)) command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'build-desktop-lab.ps1')]);
  if (!skipBuild) command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'build-windows-desktop.ps1'), '-OutputDirectory', helperDir]);
  assert.ok(fs.existsSync(helperExe), 'Build the requested helper directory first');
  command(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${reviewExe}`, path.join(repo, 'native', 'windows-desktop', 'ReviewTests.cs'),
  ]);
  const targetedOutput = command(reviewExe, [helperExe, fixtureExe], true);
  const targetedChecks = Number(targetedOutput.match(/PASSED (\d+)/)?.[1]);
  assert.ok(Number.isInteger(targetedChecks) && targetedChecks > 0, 'Targeted test runner must report its actual check count');

  // This visible window is a newly launched, disposable test fixture.
  fixture = spawn(fixtureExe, [], { windowsHide: false, stdio: 'ignore' });
  await delay(800);
  helper = spawn(helperExe, ['--fixture-pid', String(fixture.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: helper.stdout }).on('line', line => {
    const result = JSON.parse(line);
    const callback = pending.get(result.id);
    if (callback) { pending.delete(result.id); clearTimeout(callback.timer); callback.resolve(result); }
  });
  const rpc = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC_TIMEOUT')); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    helper.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
  const observe = async () => {
    const response = await rpc('observe');
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  let snapshot = await observe();
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].processName, 'JeffDesktopLabTarget');
  assert.equal(snapshot.metadata.fixtureRestricted, true);
  checks.push('fixture-only inventory');
  const windowId = snapshot.windows[0].id;
  const execute = async (targetId, operation) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      snapshot = await observe();
      const response = await rpc('execute', { expectedVersion: snapshot.version, targetId, operation });
      // Only retry a request explicitly rejected before any effect. Never retry
      // invoked/unknown effects. Windows animations can invalidate old bounds.
      if (!response.ok && response.error.code === 'STALE_SNAPSHOT' && attempt < 3) { await delay(160); continue; }
      assert.equal(response.ok, true, JSON.stringify(response));
      snapshot = response.result.after;
      return response.result;
    }
  };
  let receipt = await execute(windowId, 'inspect');
  assert.equal(receipt.verified, true);
  assert.ok(snapshot.elements.some(element => element.name === 'Music'));
  assert.ok(snapshot.elements.every(element => !['Text', 'Document', 'Edit'].includes(element.role)));
  checks.push('inspect real UIA controls, omit content');

  const music = snapshot.elements.find(element => element.name === 'Music' && element.role === 'TabItem');
  receipt = await execute(music.id, 'select');
  assert.equal(receipt.verified, true);
  assert.equal(snapshot.elements.find(element => element.id === music.id).selected, true);
  checks.push('select via real SelectionItem pattern');
  const play = snapshot.elements.find(element => element.name === 'Play music');
  assert.ok(play);
  const bypass = await rpc('execute', { expectedVersion: snapshot.version, expectedWindowVersion: snapshot.windows[0].stateVersion, targetId: play.id, operation: 'invoke' });
  assert.equal(bypass.ok, false);
  assert.equal(bypass.error.code, 'WINDOW_VERSION_REQUIRES_WINDOW_TARGET');
  checks.push('window version cannot bypass UIA freshness');

  receipt = await execute(play.id, 'invoke');
  assert.equal(receipt.verified, false);
  assert.equal(receipt.stateChanged, true);
  assert.equal(receipt.evidence, 'state_changed');
  assert.ok(snapshot.elements.some(element => element.name === 'Pause music'));
  checks.push('invoke distinguishes state change from task completion');
  assert.notEqual(snapshot.version, receipt.before.version);
  assert.equal(snapshot.windows[0].stateVersion, receipt.before.windows[0].stateVersion);
  const windowScoped = await rpc('execute', { expectedVersion: receipt.before.version, expectedWindowVersion: receipt.before.windows[0].stateVersion, targetId: windowId, operation: 'inspect' });
  assert.equal(windowScoped.ok, true, JSON.stringify(windowScoped));
  snapshot = windowScoped.result.after;
  checks.push('window version allows unrelated UIA state change');

  const stable1 = await observe();
  const stable2 = await observe();
  assert.equal(stable1.version, stable2.version);
  checks.push('stable repeated observation version');
  const stale = await rpc('execute', { expectedVersion: 'invalid', targetId: windowId, operation: 'close' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_SNAPSHOT');
  checks.push('stale effect rejected');

  const beforeMinimize = snapshot.windows[0].stateVersion;
  receipt = await execute(windowId, 'minimize');
  assert.equal(receipt.verified, true);
  assert.equal(snapshot.facts.surfaceStatus, 'window_minimized');
  checks.push('minimize real fixture window');
  const staleWindow = await rpc('execute', { expectedVersion: snapshot.version, expectedWindowVersion: beforeMinimize, targetId: windowId, operation: 'restore' });
  assert.equal(staleWindow.ok, false);
  assert.equal(staleWindow.error.code, 'STALE_SNAPSHOT');
  checks.push('changed target window version rejects effect');
  snapshot = await observe();
  assert.equal(snapshot.windows[0].minimized, true);
  checks.push('observation does not restore minimized window');
  for (const [operation, label] of [['restore', 'restore real fixture window'], ['maximize', 'maximize real fixture window'], ['restore', 'restore maximized real fixture window']]) {
    receipt = await execute(windowId, operation);
    assert.equal(receipt.verified, true);
    checks.push(label);
  }
  receipt = await execute(windowId, 'close');
  assert.equal(receipt.verified, true);
  assert.equal(snapshot.windows.length, 0);
  assert.equal(snapshot.facts.selectedWindowId, null);
  checks.push('graceful close verified by original window absence');
  const result = { passed: true, targetedChecks, checks, receipt: { operation: receipt.operation, verified: receipt.verified, evidence: receipt.evidence }, at: new Date().toISOString() };
  fs.writeFileSync(path.join(work, 'native-test-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const callback of pending.values()) clearTimeout(callback.timer);
  helper?.stdin.end();
  if (fixture?.exitCode === null) fixture.kill(); // Only our own disposable fixture.
  await delay(100);
});
