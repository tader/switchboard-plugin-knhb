import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';

export const BASE = 'https://app.hockeyweerelt.nl';
export const ISSUER = 'https://login.hockeyweerelt.nl';
export const CLIENTS = ['019cbe35-3790-71c0-952e-f8e8c1b0133d', '019cbe33-d952-72b3-af89-653b35f430c7', '019cbe36-4532-72c5-ae7e-529020273d0d'];

export async function json(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) });
  } catch { throw new Error('KNHB request failed. Check connectivity and try again.'); }
  if (!response.ok) throw new Error(`KNHB request failed (HTTP ${response.status}). Reconnect if authentication has expired.`);
  try { return await response.json(); } catch { throw new Error('KNHB returned an invalid JSON response.'); }
}

export async function register() {
  const uuid = randomUUID();
  const result = await json(`${BASE}/device/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ uuid, os: 'Web' }),
  });
  if (typeof result.token !== 'string' || !result.token) throw new Error('KNHB did not return a device token.');
  return { uuid, deviceToken: result.token };
}

export function sign(url, credentials, now = Date.now()) {
  const target = new URL(url);
  if (target.origin !== BASE) throw new Error('KNHB credentials may only be sent to the Match Center API.');
  const clean = value => value.replace(/[^a-zA-Z0-9\-/=]+/g, '');
  const path = target.pathname.replace(/[^a-zA-Z0-9\-/]+/g, '');
  const query = [...target.searchParams].filter(([key]) => key.length).map(([key, value]) => `${clean(key)}=${clean(value)}`).join('');
  const timestamp = Math.floor(now / 1000).toString();
  const signature = createHash('sha1').update(`${timestamp}${path}${query}${[...credentials.uuid].reverse().join('')}`).digest('hex');
  return {
    accept: 'application/json', 'x-requested-with': 'XMLHttpRequest',
    'x-hapi-authorization': credentials.deviceToken, 'x-hapi-timestamp': timestamp,
    'x-hapi-signature': signature, 'x-hapi-version': '8',
    ...(credentials.idToken ? { authorization: `Bearer ${credentials.idToken}` } : {}),
  };
}

export async function validateIdentity(token, clientId, getKeys = () => json(`${ISSUER}/.well-known/jwks.json`)) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !CLIENTS.includes(clientId)) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== 'RS256' || claims.iss !== ISSUER || !audiences.includes(clientId) ||
        typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() ||
        (claims.nbf && claims.nbf * 1000 > Date.now() + 30_000)) throw new Error();
    const { keys } = await getKeys();
    const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
    return { account: { id: claims.sub, label: claims.name || claims.email || 'KNHB account' }, expiresAt: claims.exp * 1000 };
  } catch { throw new Error('Invalid or expired KNHB sign-in. Sign in again using the KNHB website.'); }
}

export async function connectSession(input) {
  let session;
  try { session = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('Paste the KNHB session JSON from the connection guide.'); }
  if (!session || typeof session.idToken !== 'string') throw new Error('KNHB session is missing its ID token.');
  const identity = await validateIdentity(session.idToken, session.clientId);
  const credentials = { ...await register(), idToken: session.idToken, clientId: session.clientId,
    refreshToken: typeof session.refreshToken === 'string' ? session.refreshToken : undefined, expiresAt: identity.expiresAt, subject: identity.account.id };
  await json(`${BASE}/my-matches`, { headers: sign(`${BASE}/my-matches`, credentials) });
  return { credentials, account: identity.account, config: {} };
}

export async function refresh(credentials, force = false) {
  if (!credentials.idToken || (!force && credentials.expiresAt > Date.now() + 60_000)) return credentials;
  if (!credentials.refreshToken) throw new Error('KNHB sign-in expired. Reconnect to sign in again.');
  const result = await json(`${ISSUER}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.clientId }),
  });
  // A rotated refresh token must survive even if the provider omits a new ID token.
  return { ...credentials, refreshToken: result.refresh_token ?? credentials.refreshToken,
    idToken: result.id_token ?? credentials.idToken };
}
