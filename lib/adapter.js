import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { BASE, json, sign } from './api.js';

const completed = new Set(['final', 'result', 'official']);
const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const badRequest = message => Object.assign(new Error(message), { status: 400 });

// Remove image URLs from lists to keep agent responses below tool output limits.
export function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'logo').map(([key, item]) => [key, compact(item)]));
  return value;
}

export function selectMatches(matches, params, teamId, now = Date.now()) {
  const period = params.get('period') ?? 'all';
  if (!['all', 'upcoming', 'past'].includes(period)) throw badRequest('period must be all, upcoming or past.');
  const dates = ['from', 'to'].map(name => {
    const value = params.get(name);
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw badRequest(`${name} must be a valid YYYY-MM-DD date.`);
    return value;
  });
  if (dates[0] && dates[1] && dates[0] > dates[1]) throw badRequest('from must be on or before to.');
  const opponent = params.get('opponent')?.trim().toLocaleLowerCase('nl');
  const role = params.get('role')?.trim().toLocaleLowerCase('nl');
  const limit = Number(params.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badRequest('limit must be an integer from 1 to 50.');
  const token = params.get('nextToken');
  if (token && !/^\d{1,7}$/.test(token)) throw badRequest('Invalid nextToken.');
  const offset = Number(token ?? 0);
  const seen = new Set();
  const selected = matches.filter(match => {
    if (seen.has(String(match.id))) return false;
    seen.add(String(match.id));
    const home = String(match.home?.id) === String(teamId);
    const away = String(match.away?.id) === String(teamId);
    if (teamId !== undefined && !home && !away) return false;
    const time = Date.parse(match.date);
    const status = String(match.status).toLowerCase();
    const isCompleted = completed.has(status);
    if (period === 'past' && !isCompleted) return false;
    if (period === 'upcoming' && (isCompleted || /cancel/.test(status) || !Number.isFinite(time) || time < now)) return false;
    if (dates.some(Boolean)) {
      if (!Number.isFinite(time)) return false;
      const day = localDay.format(new Date(time));
      if (dates[0] && day < dates[0] || dates[1] && day > dates[1]) return false;
    }
    const opponents = teamId === undefined ? [match.home?.name, match.away?.name] : [home ? match.away?.name : match.home?.name];
    if (opponent && !opponents.some(name => String(name ?? '').toLocaleLowerCase('nl').includes(opponent))) return false;
    if (role && ![match.role, match.role_name].some(value => String(value ?? '').toLocaleLowerCase('nl').includes(role))) return false;
    return true;
  }).sort((a, b) => {
    const delta = (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0);
    return period === 'past' ? -delta : delta;
  });
  return {
    data: selected.slice(offset, offset + limit).map(match => compact({
      id: match.id, date: match.date, status: match.status,
      home: match.home, away: match.away, score: match.score, shootouts: match.shootouts,
      own_team_id: match.own_team_id, role: match.role, role_name: match.role_name,
      user_action_required: match.user_action_required, user_action_description: match.user_action_description,
      poule_id: match.poule_id, competition_name: match.competition_name, remarks: match.remarks,
    })),
    total: selected.length,
    ...(offset + limit < selected.length ? { nextToken: String(offset + limit) } : {}),
  };
}

export async function createAdapter() {
  const grants = new Map();
  let origin;
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const grant = grants.get(token);
    // Each request gets a short-lived one-use capability tied to its exact URL.
    grants.delete(token);
    if (!grant || grant.expiresAt < Date.now() || grant.path !== req.url || req.method !== 'GET') {
      res.writeHead(401).end(JSON.stringify({ error: 'Invalid KNHB request capability.' }));
      return;
    }
    try {
      const url = new URL(req.url, origin);
      let path = url.pathname;
      const teamMatches = path.match(/^\/teams\/([0-9]+)\/poules\/([0-9]+)\/matches$/);
      const metadata = /^\/poules\/[0-9]+\/teams\/[0-9]+$/.test(path);
      const feed = ['/my-matches', '/favorites/defaults/matches'].includes(path);
      const allowed = feed || metadata || teamMatches || ['/clubs', '/favorites', '/favorites/defaults'].includes(path) || /^\/clubs\/[a-zA-Z0-9_-]+$/.test(path) || /^\/matches\/[0-9]+$/.test(path);
      if (!allowed) throw Object.assign(new Error('Unknown KNHB operation.'), { status: 404 });
      const allowedQuery = feed || teamMatches ? ['period', 'from', 'to', 'opponent', 'role', 'limit', 'nextToken'] : [];
      for (const key of url.searchParams.keys()) if (!allowedQuery.includes(key)) throw badRequest(`Unsupported query parameter: ${key}`);
      // Validate filters before touching the provider.
      if (feed || teamMatches) selectMatches([], url.searchParams, teamMatches?.[1]);
      if (teamMatches) path = `/poules/${teamMatches[2]}/teams/${teamMatches[1]}`;
      const target = BASE + path;
      const result = await json(target, { headers: sign(target, grant.credentials), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      let output;
      if (teamMatches) {
        const data = result.data;
        if (!data || !Array.isArray(data.poules)) throw new Error('KNHB team response is missing its poules.');
        const matches = data.poules.flatMap(poule => poule.matches ?? []);
        output = { ...selectMatches(matches, url.searchParams, teamMatches[1]), coverage: { teamId: teamMatches[1], pouleId: teamMatches[2], season: data.season_name, source: 'Selected poule response only; follow team metadata neighbors for other seasons.' } };
      } else if (feed) {
        if (!Array.isArray(result.data)) throw new Error('KNHB match response is missing its match list.');
        output = { ...selectMatches(result.data, url.searchParams), coverage: { source: path, description: 'Provider feed only; use team queries for historical coverage.' } };
      } else if (metadata) {
        output = compact({ ...result, data: { ...result.data, poules: result.data?.poules?.map(({ matches, standings, ...poule }) => ({ ...poule, matchCount: matches?.length ?? 0 })) } });
      } else output = compact(result);
      res.end(JSON.stringify(output));
    } catch (error) {
      if (error.retryAfter) res.setHeader('retry-after', error.retryAfter);
      res.writeHead(error.status ?? 502).end(JSON.stringify({ error: error.status ? error.message : 'KNHB response could not be processed. Try again or reconnect.' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  origin = `http://127.0.0.1:${server.address().port}`;
  const sweep = setInterval(() => { for (const [key, value] of grants) if (value.expiresAt < Date.now()) grants.delete(key); }, 30_000);
  sweep.unref();
  return {
    origin,
    grant(url, credentials) {
      if (url.origin !== origin) throw new Error('Unsupported KNHB adapter origin.');
      if (grants.size >= 1000) throw new Error('Too many pending KNHB requests. Try again later.');
      const token = randomBytes(32).toString('base64url');
      grants.set(token, { credentials, path: url.pathname + url.search, expiresAt: Date.now() + 30_000 });
      return token;
    },
    async close() {
      clearInterval(sweep);
      grants.clear();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
