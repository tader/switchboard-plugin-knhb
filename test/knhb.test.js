import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { BASE, ISSUER, CLIENTS, connectSession, json, refresh, sign, validateIdentity } from '../lib/api.js';
import { SESSION_EXPRESSION } from '../lib/browser.js';
import setup from '../index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const claims = { iss: ISSUER, aud: CLIENTS[0], sub: 'person-1', name: 'Test Person', exp: now + 3600 };
function jwt(extra = {}, headerExtra = {}) {
  const parts = [ { alg: 'RS256', kid: 'test', ...headerExtra }, { ...claims, ...extra } ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url'));
  return [...parts, rsaSign('RSA-SHA256', Buffer.from(parts.join('.')), privateKey).toString('base64url')].join('.');
}
const keys = async () => ({ keys: [jwk] });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const ctx = { settings: {}, capabilities: { deviceBrowser: true } };
const credentials = { uuid: 'device-123', deviceToken: 'device-secret' };

test('signs the final encoded URL and ordered query using the observed v8 protocol', () => {
  const url = `${BASE}/poules/12/teams/34?a=A%20B&x=1%7C2&a=z`;
  const headers = sign(url, { ...credentials, idToken: 'personal' }, 1234567000);
  const expected = createHash('sha1').update('1234567/poules/12/teams/34a=ABx=12a=z321-ecived').digest('hex');
  assert.equal(headers['x-hapi-signature'], expected);
  assert.equal(headers['x-hapi-version'], '8');
  assert.equal(headers.authorization, 'Bearer personal');
  assert.equal(sign(url, credentials).authorization, undefined);
  assert.throws(() => sign('https://attacker.invalid/', credentials), /only/);
  assert.throws(() => sign('http://app.hockeyweerelt.nl/', credentials), /only/);
});

test('validates signature, issuer, audience, subject and expiry before accepting an account', async () => {
  assert.deepEqual((await validateIdentity(jwt(), CLIENTS[0], keys)).account, { id: 'person-1', label: 'Test Person' });
  for (const token of [jwt({ iss: 'https://attacker.invalid' }), jwt({ aud: 'other' }), jwt({ exp: now - 1 }), jwt({ sub: '' }), jwt({ nbf: now + 999 }), jwt({}, { alg: 'none' }), jwt({}, { kid: 'other' }), jwt().slice(0, -8) + 'tampered']) {
    await assert.rejects(validateIdentity(token, CLIENTS[0], keys), /Invalid or expired/);
  }
  await assert.rejects(validateIdentity(jwt(), 'untrusted-client', keys), /Invalid or expired/);
});

test('session import verifies identity, registers an isolated device, checks account access and drops submitted config', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/jwks.json')) return reply({ keys: [jwk] });
    if (url.endsWith('/device/register')) {
      assert.equal(JSON.parse(opts.body).os, 'Web');
      return reply({ token: 'new-device' });
    }
    assert.equal(url, BASE + '/my-matches');
    assert.equal(opts.headers.authorization, 'Bearer ' + jwt());
    return reply({ data: [] });
  };
  const result = await connectSession(JSON.stringify({ idToken: jwt(), clientId: CLIENTS[0], refreshToken: 'refresh', unrelated: 'never-store' }));
  assert.equal(result.account.id, 'person-1');
  assert.equal(result.credentials.subject, 'person-1');
  assert.equal(result.credentials.deviceToken, 'new-device');
  assert.equal(result.credentials.unrelated, undefined);
  assert.deepEqual(result.config, {});
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.opts.redirect === 'error'));
});

test('request failures never expose provider error bodies or secrets', async () => {
  globalThis.fetch = async () => reply({ message: 'refresh-token-secret' }, 429);
  await assert.rejects(json(BASE + '/clubs'), error => /429/.test(error.message) && !/secret/.test(error.message));
  globalThis.fetch = async () => { throw new Error('url-with-token-secret'); };
  await assert.rejects(json(BASE + '/clubs'), error => !/secret/.test(error.message));
});

test('account refresh uses the captured client and retains rotated refresh tokens', async () => {
  const expired = { ...credentials, idToken: jwt({ exp: now - 2 }), refreshToken: 'old', clientId: CLIENTS[0], expiresAt: 0 };
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, ISSUER + '/oauth/token');
    assert.equal(opts.body.get('client_id'), CLIENTS[0]);
    assert.equal(opts.body.get('refresh_token'), 'old');
    return reply({ id_token: jwt(), refresh_token: 'rotated' });
  };
  const result = await refresh(expired);
  assert.equal(result.refreshToken, 'rotated');
  assert.equal(result.idToken, jwt());
  await assert.rejects(refresh({ ...expired, refreshToken: undefined }), /Reconnect/);
  assert.equal(await refresh(credentials), credentials);
});

test('authorization refuses writes and credential forwarding to other origins before network access', async () => {
  const plugin = setup(ctx);
  const auth = plugin.services[0].authMethods[0];
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  for (const req of [ { method: 'POST', url: BASE + '/favorites' }, { method: 'GET', url: 'https://evil.invalid/' } ]) {
    await assert.rejects(auth.authorize({ ...req, headers: new Headers() }, { credentials }), /read-only|origin/);
  }
  const req = { method: 'GET', url: BASE + '/clubs', headers: new Headers() };
  await auth.authorize(req, { credentials });
  assert.equal(req.headers.get('x-hapi-authorization'), 'device-secret');
  await plugin.dispose();
});

test('forced public authentication renews the device and signs the retried request', async () => {
  globalThis.fetch = async url => {
    assert.equal(url, BASE + '/device/register');
    return reply({ token: 'renewed' });
  };
  const req = { method: 'GET', url: BASE + '/clubs', headers: new Headers() };
  const auth = setup(ctx).services[0].authMethods[2];
  const result = await auth.authorize(req, { credentials }, { force: true });
  assert.equal(req.headers.get('x-hapi-authorization'), 'renewed');
  assert.notEqual(result.credentials.uuid, credentials.uuid);
});

test('rotated refresh tokens are persisted before failed account validation', async () => {
  const saved = [];
  globalThis.fetch = async () => reply({ refresh_token: 'rotated', id_token: jwt({ exp: now - 1 }) });
  const auth = setup(ctx).services[0].authMethods[0];
  await assert.rejects(auth.authorize({ method: 'GET', url: BASE + '/my-matches', headers: new Headers() }, {
    credentials: { ...credentials, idToken: jwt(), clientId: CLIENTS[0], refreshToken: 'old', expiresAt: 0, subject: 'person-1' },
  }, { persistCredentials: c => saved.push(c) }), /Invalid or expired/);
  assert.equal(saved[0].refreshToken, 'rotated');
});

test('browser extraction reads only the KNHB OIDC session on the KNHB origin', () => {
  const record = { id_token: 'id-token', refresh_token: 'refresh' };
  const sessionStorage = {
    ['oidc.user:' + ISSUER + ':' + CLIENTS[0]]: JSON.stringify(record),
    'other-secret': 'never-export',
    getItem(key) { return this[key]; },
  };
  const extracted = runInNewContext(SESSION_EXPRESSION, { location: { origin: 'https://www.knhb.nl' }, sessionStorage });
  assert.deepEqual(JSON.parse(JSON.stringify(extracted)), { idToken: 'id-token', refreshToken: 'refresh', clientId: CLIENTS[0] });
  assert.equal(runInNewContext(SESSION_EXPRESSION, { location: { origin: 'https://evil.invalid' }, sessionStorage }), null);
});

test('old cores retain session import and public access without offering broken browser pairing', async () => {
  const plugin = setup({ settings: {} });
  const methods = plugin.services[0].authMethods;
  assert.ok(methods[0].unavailable);
  await assert.rejects(methods[0].connect(), /unsupported/);
  await assert.rejects(methods[0].poll({ pending: { id: 'unknown' } }), /expired/);
  assert.equal(methods[1].unavailable, undefined);
});
