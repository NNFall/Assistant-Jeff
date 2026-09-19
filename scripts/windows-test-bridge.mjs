import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

/** Persistent test-only bridge: startup is measured separately from each action. */
export class WindowsTestBridge {
  constructor() { this.pending = new Map(); this.sequence = 0; }
  async start() {
    if (process.platform !== 'win32') throw new Error('Windows required.');
    const started = performance.now();
    this.process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./windows-test-bridge.ps1', import.meta.url))],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    // PowerShell/compiler failures may include source text; do not log stderr.
    this.process.stderr.resume();
    this.process.stdin.on('error', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Window bridge startup timed out.')); }, 15000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Window bridge unavailable.'));
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Window bridge stopped.')); }
        this.pending.clear();
      };
      this.process.once('error', fail);
      this.process.once('exit', fail);
      createInterface({input: this.process.stdout}).on('line', line => {
        let value; try { value = JSON.parse(line); } catch { return; }
        if (value.ready) { clearTimeout(timer); resolve(); return; }
        const entry = this.pending.get(value.id);
        if (!entry) return;
        this.pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.ok) entry.resolve({...value, roundtripMs: Math.round(performance.now() - entry.started)});
        else entry.reject(new Error('Window action rejected or stale.'));
      });
    });
    this.startupMs = Math.round(performance.now() - started);
    return this;
  }
  request(operation, target) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Window bridge request timed out.')); }, 6000);
      this.pending.set(id, {resolve, reject, timer, started: performance.now()});
      this.process.stdin.write(JSON.stringify({id, operation, target}) + '\n');
    });
  }
  close() {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Window bridge closed.')); }
    this.pending.clear();
    this.process?.stdin.end(JSON.stringify({operation: 'quit'}) + '\n');
  }
}
