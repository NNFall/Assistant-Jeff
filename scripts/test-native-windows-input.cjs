// Synthetic-only native input regression. The helper is PID/path-bound to the
// newly launched fixture; no personal application is observed or controlled.
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repo = path.resolve(__dirname, '..');
const work = path.join(repo, 'work', 'windows-desktop');
let helperDir = path.join(work, 'staging-final');
let foregroundWaitMs = 1000;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--skip-build') continue; // Helper is never built here.
  if (process.argv[index] === '--helper-dir' && process.argv[index + 1]) helperDir = path.resolve(repo, process.argv[++index]);
  else if (process.argv[index] === '--foreground-wait-ms' && process.argv[index + 1]) foregroundWaitMs = Number(process.argv[++index]);
  else throw new Error('Usage: node scripts/test-native-windows-input.cjs [--helper-dir work/windows-desktop/staging-final] [--skip-build] [--foreground-wait-ms 1000]');
}
assert.ok(Number.isInteger(foregroundWaitMs) && foregroundWaitMs >= 100 && foregroundWaitMs <= 60000, 'Foreground wait must be 100..60000 ms');
const relativeHelper = path.relative(work, helperDir);
assert.ok(relativeHelper && !relativeHelper.startsWith('..') && !path.isAbsolute(relativeHelper), 'Helper must stay inside work/windows-desktop');
assert.equal(process.platform, 'win32', 'Native input tests require Windows');
const fixtureDir = path.join(work, 'input-fixture');
const fixtureExe = path.join(fixtureDir, 'JeffWindowsInputFixture.exe');
const helperExe = path.join(helperDir, 'JeffWindowsDesktopHelper.exe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const markers = [
  'INITIAL_NORMAL_SENTINEL_92a6', 'INITIAL_PASSWORD_SENTINEL_1b3d', 'INITIAL_READONLY_SENTINEL_6f5a',
  'PRIVATE_FIELD_NAME_NORMAL', 'PRIVATE_FIELD_NAME_PASSWORD', 'PRIVATE_FIELD_NAME_READONLY',
];
const inserted = 'Synthetic input 27 — Привет, Jeff!\r\nLiteral {ENTER} and ^A stay text.';
const nativeResponses = [];
const checks = [];
const skipped = [];
const channels = [];
let fixture;
let helper;
let fixtureRpc;
let helperRpc;
let windowId;

function writeResult(result) {
  const history = path.join(work, 'native-input-tests');
  fs.mkdirSync(history, { recursive: true });
  const serialized = JSON.stringify(result, null, 2);
  fs.writeFileSync(path.join(history, `${result.at.replace(/[:.]/g, '-')}.json`), serialized);
  fs.writeFileSync(path.join(work, 'native-input-test-result.json'), serialized);
}

function channel(child, label, onResponse) {
  let sequence = 0;
  const pending = new Map();
  let closed = false;
  const finish = error => {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { finish(new Error(`${label}_INVALID_JSON`)); return; }
    onResponse?.(response);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer); request.resolve(response);
  });
  child.on('error', () => finish(new Error(`${label}_START_FAILED`)));
  child.on('exit', code => finish(new Error(`${label}_EXIT_${code}`)));
  child.stdin.on('error', () => finish(new Error(`${label}_INPUT_CLOSED`)));
  // Drain stderr without printing possible provider diagnostics or field data.
  child.stderr.resume();
  channels.push({ child, finish });
  return (method, args = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error(`${label}_CLOSED`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label}_RPC_TIMEOUT`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
}
function okay(response, context) {
  assert.equal(response.ok, true, `${context}: ${response.error?.code ?? 'unknown failure'}`);
  return response.result;
}
function privateResult(response) {
  const serialized = JSON.stringify(response);
  for (const marker of [...markers, inserted]) assert.ok(!serialized.includes(marker), 'Native response exposed synthetic field content or name');
  // These product snapshots may report flags, but never field text/value keys.
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!['value', 'text', 'normalText', 'passwordText', 'readOnlyText'].includes(key), `Native response exposed content key ${key}`);
      walk(nested);
    }
  };
  walk(response);
}
async function status() { return okay(await fixtureRpc('status'), 'fixture status'); }
async function focus(field) {
  let response = okay(await fixtureRpc('focus', { field }), 'fixture focus');
  assert.equal(response.focusedField, field, 'Fixture could not grant requested focus');
  // SetForegroundWindow may complete after this command returns. Poll only our
  // own fixture's state; do not send synthetic keys or bypass Windows policy.
  if (!response.foreground && foregroundWaitMs > 1000) console.log(JSON.stringify({ event: 'fixture_foreground_required', fixturePid: fixture.pid, waitMs: foregroundWaitMs }));
  for (let attempt = 0; !response.foreground && attempt < Math.ceil(foregroundWaitMs / 100); attempt++) { await delay(100); response = await status(); }
  if (!response.foreground) throw new Error('FIXTURE_FOREGROUND_NOT_GRANTED: activate the visible test fixture and rerun; no effects attempted on other apps');
  await delay(120);
}
async function observe() {
  const snapshot = okay(await helperRpc('observe', windowId ? { windowId } : {}), 'observe fixture');
  privateResult(snapshot);
  assert.equal(snapshot.windows.length, 1, 'Only one fixture window may be present');
  assert.equal(snapshot.windows[0].processId, fixture.pid);
  assert.equal(snapshot.windows[0].processName, 'JeffWindowsInputFixture');
  assert.equal(snapshot.metadata.fixtureRestricted, true);
  return snapshot;
}
async function execute(target, operation, extra = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await observe();
    const targetId = typeof target === 'function' ? target(snapshot) : target;
    const args = { expectedVersion: snapshot.version, targetId, operation, ...extra };
    if (targetId === windowId) args.expectedWindowVersion = snapshot.windows[0].stateVersion;
    const response = await helperRpc('execute', args);
    // Retry only a rejection before effects; never retry an unverified write.
    if (!response.ok && response.error.code === 'STALE_SNAPSHOT' && attempt < 3) { await delay(160); continue; }
    privateResult(response);
    return response;
  }
}
function editable(snapshot) { return snapshot.elements.filter(element => element.capabilities?.includes('replace_text')); }
function normalizedLayout(value) {
  assert.equal(typeof value, 'string', 'Layout ID must be string');
  return BigInt(value.startsWith('0x') ? value : `0x${value}`).toString(16);
}
async function unchanged(before, label) {
  const after = await status();
  for (const field of ['normalText', 'passwordText', 'readOnlyText']) assert.equal(after[field], before[field], `${label} changed ${field}`);
}
async function rejectedText(targetId, extra, label) {
  const before = await status();
  // Malformed text is validated before the helper observes/effects UI. It must
  // reject independently of later focus changes; reuse the known fixture ID.
  const response = await execute(targetId, 'replace_text', extra);
  assert.equal(response.ok, false, `${label} must reject`);
  assert.notEqual(response.error.code, 'STALE_SNAPSHOT', `${label} must reach argument validation`);
  await unchanged(before, label); checks.push(label);
}

async function run() {
  assert.ok(fs.existsSync(helperExe), 'Build the helper in the requested --helper-dir before this test; this harness never builds it');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compile = spawnSync(compiler, ['/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/out:${fixtureExe}`, path.join(repo, 'native', 'windows-desktop', 'InputFixture.cs')], { cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (compile.status !== 0) throw new Error(`Fixture compilation failed: ${(compile.stdout || compile.stderr || compile.error?.message || '').slice(0, 3000)}`);
  // This newly launched disposable fixture is deliberately visible. Hiding its
  // initial native window may also prevent focus/foreground eligibility.
  fixture = spawn(fixtureExe, [], { cwd: repo, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
  fixtureRpc = channel(fixture, 'FIXTURE');
  await status(); await focus('normal');
  helper = spawn(helperExe, ['--fixture-pid', String(fixture.pid)], { cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helperRpc = channel(helper, 'HELPER', response => nativeResponses.push(response));

  let snapshot = await observe(); windowId = snapshot.windows[0].id;
  snapshot = await observe();
  assert.equal(snapshot.facts.selectedWindowId, windowId);
  checks.push('inventory and selected surface bound to disposable input fixture');
  const candidates = editable(snapshot);
  assert.equal(candidates.length, 1, 'Expose only the currently focused writable field');
  const normalId = candidates[0].id;
  assert.equal(candidates[0].role, 'Edit');
  assert.equal(candidates[0].name, 'Focused editable field');
  assert.equal(candidates[0].label, 'Focused editable field');
  assert.equal(candidates[0].supportsValuePattern, true);
  assert.equal(candidates[0].readOnly, false);
  assert.equal(candidates[0].isPassword, false);
  assert.equal(candidates[0].hasKeyboardFocus, true);
  checks.push('focused normal Edit exposes writable metadata and constant identity label');
  privateResult(snapshot); checks.push('native observation omits all field names and contents');

  const before = await status();
  const receipt = okay(await execute(normalId, 'replace_text', { text: inserted }), 'replace literal text');
  assert.equal(receipt.verified, false);
  assert.equal(receipt.evidence, 'text_set_unverified');
  assert.equal(receipt.textLength, inserted.length);
  privateResult(receipt);
  const after = await status();
  assert.equal(after.normalText, inserted, 'Fixture channel must confirm exact literal replacement');
  assert.equal(after.passwordText, before.passwordText);
  assert.equal(after.readOnlyText, before.readOnlyText);
  checks.push('literal UTF-16 text replaces only the focused normal field');
  checks.push('write receipt remains unverified, reports length, never echoes text');

  await rejectedText(normalId, {}, 'missing text rejected without effect');
  await rejectedText(normalId, { text: null }, 'null text rejected without effect');
  await rejectedText(normalId, { text: 42 }, 'nonstring text rejected without effect');
  await rejectedText(normalId, { text: 'x'.repeat(4097) }, 'oversized text rejected without effect');
  await rejectedText(normalId, { text: 'synthetic\0nul' }, 'NUL text rejected without effect');
  await rejectedText(normalId, { text: 'synthetic\ud800' }, 'unpaired surrogate text rejected without effect');
  await focus('normal');
  const cleared = okay(await execute(normalId, 'replace_text', { text: '' }), 'explicit empty replacement');
  assert.equal(cleared.verified, false); assert.equal(cleared.evidence, 'text_set_unverified'); assert.equal(cleared.textLength, 0);
  assert.equal((await status()).normalText, '');
  checks.push('explicit empty text clears only the focused field');
  snapshot = await observe();
  const stable = await status();
  const stale = await helperRpc('execute', { expectedVersion: 'stale', targetId: normalId, operation: 'replace_text', text: 'MUST_NOT_BE_WRITTEN' });
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'STALE_SNAPSHOT');
  await unchanged(stable, 'stale text'); checks.push('stale snapshot rejects text before effect');
  const bypass = await helperRpc('execute', { expectedVersion: snapshot.version, expectedWindowVersion: snapshot.windows[0].stateVersion, targetId: normalId, operation: 'replace_text', text: 'MUST_NOT_BE_WRITTEN' });
  assert.equal(bypass.ok, false); assert.equal(bypass.error.code, 'WINDOW_VERSION_REQUIRES_WINDOW_TARGET');
  await unchanged(stable, 'window version bypass'); checks.push('window version cannot bypass editable field freshness');

  for (const field of ['password', 'readonly', 'none']) {
    await focus(field);
    snapshot = await observe();
    assert.equal(editable(snapshot).length, 0, `${field} must not offer replace_text`);
    const beforeReject = await status();
    const rejected = await execute(normalId, 'replace_text', { text: 'MUST_NOT_BE_WRITTEN' });
    assert.equal(rejected.ok, false, `Previously writable target must reject when focus is ${field}`);
    await unchanged(beforeReject, `focus ${field}`);
    checks.push(`${field} focus omits writable capability and rejects former normal target`);
  }

  await focus('normal');
  snapshot = await observe();
  const initialLayout = (await status()).originalKeyboardLayoutId;
  const window = snapshot.windows[0];
  assert.ok(Object.hasOwn(window, 'keyboardLanguage'));
  assert.ok(Object.hasOwn(window, 'keyboardLayoutId'));
  assert.ok(Array.isArray(window.availableKeyboardLanguages));
  assert.equal(normalizedLayout(window.keyboardLayoutId), normalizedLayout((await status()).keyboardLayoutId));
  checks.push('window keyboard metadata matches fixture UI thread');
  for (const language of ['English', 'Russian']) {
    if (!window.availableKeyboardLanguages.includes(language)) { skipped.push(`${language} layout is not installed; installation was not attempted`); continue; }
    const response = okay(await execute(windowId, 'set_keyboard_language', { language }), `set ${language}`);
    assert.equal(response.verified, true, `Installed ${language} must be confirmed by thread HKL`);
    snapshot = await observe();
    assert.equal(snapshot.windows[0].keyboardLanguage, language);
    assert.equal(normalizedLayout(snapshot.windows[0].keyboardLayoutId), normalizedLayout((await status()).keyboardLayoutId));
    checks.push(`set installed ${language} keyboard language on fixture thread`);
  }
  const beforeInvalidLayout = await status();
  const invalidLanguage = await execute(windowId, 'set_keyboard_language', { language: 'NotInstalledSyntheticLanguage' });
  assert.equal(invalidLanguage.ok, false);
  assert.equal(normalizedLayout((await status()).keyboardLayoutId), normalizedLayout(beforeInvalidLayout.keyboardLayoutId));
  checks.push('invalid keyboard language rejected without layout change');
  const restored = okay(await fixtureRpc('restore_layout'), 'restore own thread layout');
  assert.equal(normalizedLayout(restored.keyboardLayoutId), normalizedLayout(initialLayout));
  checks.push('original fixture-thread keyboard layout restored');

  for (const response of nativeResponses) privateResult(response);
  checks.push('all native protocol responses exclude fixture field content');
  const result = { passed: true, checks, skipped, at: new Date().toISOString(), scope: 'own disposable fixture only; no model API and no personal apps' };
  writeResult(result);
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => {
  const result = { passed: false, checks, skipped, error: error.message.split('\n')[0], at: new Date().toISOString() };
  writeResult(result);
  // Assertion actual/expected values are intentionally not printed: even this
  // synthetic fixture follows the product's no-field-content logging convention.
  console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
}).finally(async () => {
  if (fixture && fixture.exitCode === null && fixtureRpc) {
    try { await fixtureRpc('restore_layout'); await fixtureRpc('close'); } catch { /* Dispose this fixture below. */ }
  }
  helper?.stdin.end();
  fixture?.stdin.end();
  await delay(150);
  for (const child of [helper, fixture]) if (child && child.exitCode === null) child.kill(); // Only children launched by this harness.
  for (const entry of channels) entry.finish(new Error('TEST_FINISHED'));
});
