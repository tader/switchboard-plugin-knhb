import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BASE } from '../lib/api.js';
import { createAdapter, selectMatches } from '../lib/adapter.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const team = (id, name) => ({ id, name, logo: 'large-image-url' });
const ours = team(1, 'Our H30-2');
const hdm = team(2, 'HDM H30-1');
const other = team(3, 'Other H30-1');
const make = (id, date, status, home = ours, away = hdm) => ({ id, date, status, home, away, score: { home: 0, away: 0 }, role: 'referee', role_name: 'Scheidsrechter', user_action_required: true });
const matches = [
  make(1, '2026-09-20T13:00:00+02:00', 'final'),
  make(2, '2026-10-25T13:00:00+01:00', 'final', hdm, ours),
  make(3, '2026-11-01T13:00:00+01:00', 'scheduled'),
  make(4, '2026-11-02T13:00:00+01:00', 'cancelled'),
  make(5, '2026-10-26T13:00:00+01:00', 'final', other, hdm),
];

test('historical opponent results exclude other teams, deduplicate and sort latest first', () => {
  const result = selectMatches([...matches, matches[1]], new URLSearchParams({ period: 'past', opponent: 'hdm' }), '1');
  assert.deepEqual(result.data.map(x => x.id), [2, 1]);
  assert.equal(result.total, 2);
  assert.deepEqual(result.data[0].score, { home: 0, away: 0 });
  assert.equal(result.data[0].home.logo, undefined);
  assert.equal(result.data[0].role_name, 'Scheidsrechter');
  assert.equal(result.data[0].user_action_required, true);
  assert.equal(selectMatches([make(9, matches[0].date, 'final', hdm, other)], new URLSearchParams({ opponent: 'HDM' }), 2).total, 0);
});

test('upcoming status and Amsterdam day boundaries survive DST and UTC date changes', () => {
  const query = new URLSearchParams({ period: 'upcoming', from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(selectMatches(matches, query, 1, Date.parse('2026-10-27')).data.map(x => x.id), [3]);
  const late = make(10, '2026-10-24T22:30:00Z', 'scheduled');
  assert.equal(selectMatches([late], new URLSearchParams({ from: '2026-10-25', to: '2026-10-25' }), 1).total, 1);
});

test('pagination preserves all matching fixtures and validates malformed filters', () => {
  const params = new URLSearchParams({ period: 'past', limit: '1', role: 'scheidsrechter' });
  const first = selectMatches(matches, params, 1);
  assert.equal(first.nextToken, '1');
  params.set('nextToken', first.nextToken);
  const last = selectMatches(matches, params, 1);
  assert.deepEqual([...first.data, ...last.data].map(x => x.id), [2, 1]);
  assert.equal(last.nextToken, undefined);
  for (const args of [{ from: '2026-02-31' }, { limit: '999' }, { nextToken: '-1' }, { period: 'unknown' }, { from: '2026-12-01', to: '2026-01-01' }]) {
    assert.throws(() => selectMatches(matches, new URLSearchParams(args), 1), e => e.status === 400);
  }
});

test('loopback adapter isolates credentials, enforces one-use URL-bound grants and filters before returning data', async t => {
  const adapter = await createAdapter();
  t.after(() => adapter.close());
  let upstreamCalls = 0;
  globalThis.fetch = async (url, opts) => {
    upstreamCalls++;
    assert.equal(url, BASE + '/poules/22/teams/1');
    assert.equal(opts.headers['x-hapi-authorization'], 'device-secret');
    return new Response(JSON.stringify({ data: { season_name: '2026-2027', poules: [{ matches }] } }));
  };
  const url = new URL(adapter.origin + '/teams/1/poules/22/matches?period=past&opponent=HDM&limit=1');
  const credentials = { uuid: 'test-device', deviceToken: 'device-secret' };
  const token = adapter.grant(url, credentials);
  const response = await originalFetch(url, { headers: { authorization: 'Bearer ' + token } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.data.map(x => x.id), [2]);
  assert.equal(result.nextToken, '1');
  assert.equal(result.coverage.season, '2026-2027');
  assert.ok(!JSON.stringify(result).includes('device-secret'));
  assert.equal((await originalFetch(url, { headers: { authorization: 'Bearer ' + token } })).status, 401);
  const stolen = adapter.grant(url, credentials);
  assert.equal((await originalFetch(adapter.origin + '/my-matches', { headers: { authorization: 'Bearer ' + stolen } })).status, 401);
  assert.equal(upstreamCalls, 1);
  assert.throws(() => adapter.grant(new URL(BASE + '/clubs'), credentials), /origin/);
});

test('adapter rejects bad queries before fetching and preserves sanitized rate-limit responses', async t => {
  const adapter = await createAdapter();
  t.after(() => adapter.close());
  const credentials = { uuid: 'test-device', deviceToken: 'secret' };
  const request = async path => {
    const url = new URL(adapter.origin + path);
    return originalFetch(url, { headers: { authorization: 'Bearer ' + adapter.grant(url, credentials) } });
  };
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return new Response('provider-secret', { status: 429, headers: { 'retry-after': '60' } }); };
  assert.equal((await request('/my-matches?limit=1000')).status, 400);
  assert.equal((await request('/my-matches?redirect=https://evil.invalid')).status, 400);
  assert.equal((await request('/unlisted')).status, 404);
  assert.equal(upstreamCalls, 0);
  const response = await request('/my-matches');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.ok(!(await response.text()).includes('provider-secret'));
});
