import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Read only the KNHB OIDC record; never export cookies, profiles or other origins.
export const SESSION_EXPRESSION = `(() => {
  if (location.origin !== 'https://www.knhb.nl') return null;
  for (const key of Object.keys(sessionStorage)) {
    if (!key.startsWith('oidc.user:https://login.hockeyweerelt.nl:')) continue;
    try {
      const value = JSON.parse(sessionStorage.getItem(key));
      if (value.id_token && !value.expired) return {
        idToken: value.id_token, refreshToken: value.refresh_token,
        clientId: key.slice(key.lastIndexOf(':') + 1)
      };
    } catch {}
  }
  return null;
})()`;

export async function findBrowser(configured) {
  for (const path of configured ? [configured] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ]) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  throw new Error('Install Chrome or Edge on the Switchboard server, configure browserPath, or use session import.');
}

export class Browser {
  constructor(executable, profile, spawnProcess = spawn) {
    this.profile = profile;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    // An OS pipe keeps the debugging interface off the network.
    this.child = spawnProcess(executable, [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', 'https://www.knhb.nl/match-center'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => {
      this.child.once('exit', resolve);
      this.child.once('error', resolve);
    });
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdio[3].on('error', () => this.fail());
    this.child.stdio[4].on('error', () => this.fail());
    this.child.stdio[4].on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end;
      while ((end = this.buffer.indexOf(0)) !== -1) {
        const raw = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error('KNHB browser operation failed.'));
        else waiter.resolve(message.result);
      }
      if (this.buffer.length > 4 * 1024 * 1024) this.fail();
    });
  }
  fail() {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('KNHB sign-in browser closed. Start sign-in again.'));
    }
    this.pending.clear();
  }
  call(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('KNHB sign-in browser closed. Start sign-in again.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('KNHB browser timed out.')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async session() {
    const { targetInfos } = await this.call('Target.getTargets');
    for (const target of targetInfos.filter(t => t.type === 'page' && t.url.startsWith('https://www.knhb.nl/'))) {
      const { sessionId } = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const result = await this.call('Runtime.evaluate', { expression: SESSION_EXPRESSION, returnByValue: true }, sessionId);
        if (result.result?.value) return result.result.value;
      } finally { await this.call('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    }
    return null;
  }
  async close() {
    if (!this.closed) await this.call('Browser.close').catch(() => {});
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      let timer;
      await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
    this.fail();
    await rm(this.profile, { recursive: true, force: true });
  }
}

export async function openBrowser(configured) {
  const executable = await findBrowser(configured);
  const profile = await mkdtemp(join(tmpdir(), 'switchboard-knhb-'));
  try { return new Browser(executable, profile); }
  catch (error) { await rm(profile, { recursive: true, force: true }); throw error; }
}
