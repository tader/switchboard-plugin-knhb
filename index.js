import { randomUUID } from 'node:crypto';
import { BASE, connectSession, json, register, refresh, sign, validateIdentity } from './lib/api.js';
import { openBrowser } from './lib/browser.js';
import { createAdapter } from './lib/adapter.js';
import openapi from './openapi.json' with { type: 'json' };

export default async function setup(ctx) {
  const adapter = await createAdapter();
  const flows = new Map();
  async function stop(id) {
    const flow = flows.get(id);
    if (!flow) return;
    flows.delete(id);
    clearTimeout(flow.timer);
    await flow.browser.close();
  }
  async function authorize(req, conn, { force, persistCredentials } = {}) {
    // Keep the integration read-only, including arbitrary proxy calls.
    if (req.method.toUpperCase() !== 'GET') throw new Error('The KNHB plugin supports read-only requests.');
    if (new URL(req.url).origin !== adapter.origin) throw new Error('Unsupported KNHB API origin.');
    let credentials = await refresh(conn.credentials, force);
    if (credentials !== conn.credentials) {
      // Persist rotated refresh credentials before any subsequent validation can fail.
      if (persistCredentials) await persistCredentials(credentials);
      const identity = await validateIdentity(credentials.idToken, credentials.clientId);
      if (identity.account.id !== conn.credentials.subject) throw new Error('KNHB account changed. Reconnect this connection.');
      credentials = { ...credentials, expiresAt: identity.expiresAt };
    }
    if (force) credentials = { ...credentials, ...await register() };
    req.headers.set('authorization', `Bearer ${adapter.grant(new URL(req.url), credentials)}`);
    return { credentials };
  }
  return {
    services: [{
      id: 'knhb', name: 'KNHB Match Center', icon: 'icon.svg',
      description: 'Personal matches, referee duties, favorite teams and historical results.',
      baseUrl: adapter.origin, allowedHosts: [new URL(adapter.origin).host], openapi: { ...openapi, servers: [{ url: adapter.origin }] },
      authMethods: [
        {
          id: 'browser', name: 'Sign in with KNHB',
          description: 'Opens a separate browser on the computer running Switchboard. Sign in using KNHB’s own website.',
          unavailable: ctx.capabilities?.deviceBrowser ? undefined : 'Requires a Switchboard version supporting browser sign-in. Use session import instead.',
          async connect() {
            if (!ctx.capabilities?.deviceBrowser) throw new Error('Browser sign-in is unsupported. Use session import.');
            const browser = await openBrowser(ctx.settings.browserPath);
            const id = randomUUID();
            const timer = setTimeout(() => { stop(id).catch(() => {}); }, 10 * 60_000);
            timer.unref();
            flows.set(id, { browser, timer });
            return { device: { browser: true, instructions: 'A KNHB browser opened on the computer running Switchboard. Click Inloggen, sign in, and return to Match Center. The browser closes when connected.', expiresIn: 600, interval: 3 }, pending: { id } };
          },
          async poll({ pending }) {
            const flow = flows.get(pending?.id);
            if (!flow) throw new Error('KNHB sign-in expired or Switchboard restarted. Start sign-in again.');
            try {
              const session = await flow.browser.session();
              if (!session) return { wait: true };
              const connected = await connectSession(session);
              await stop(pending.id);
              return connected;
            } catch (error) { await stop(pending.id); throw error; }
          },
          authorize,
        },
        {
          id: 'session', name: 'Import signed-in KNHB session',
          description: 'For remote servers: sign in to KNHB in your browser and follow the connection guide.',
          fields: [{ key: 'session', label: 'KNHB session JSON', type: 'secret', required: true }],
          connect: ({ config }) => connectSession(config.session), authorize,
        },
        {
          id: 'public', name: 'Public match data',
          description: 'Browse clubs, teams and results without an account. Personal matches and favorites require sign-in.',
          async connect() {
            const credentials = await register();
            await json(`${BASE}/clubs`, { headers: sign(`${BASE}/clubs`, credentials) });
            return { credentials, account: { label: 'Public KNHB Match Center' }, config: {} };
          }, authorize,
        },
      ],
    }],
    async dispose() { await Promise.all([...flows.keys()].map(stop)); await adapter.close(); },
  };
}
