import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createAppServer } from '../server.mjs';
import { AgentError, DEFAULT_MODEL } from '../src/deepseek.mjs';

const secret = 'sk-test-secret-held-only-by-server';
const narration = '雨中的炮声逐渐远去，酒会的灯光映在杯沿。';
const fakeAgent = async ({ action, context }) => action.type === 'memory'
  ? { clueId: context.remainingClues[0].id, narrative: narration }
  : action.type === 'talk' ? { reply: '那天我随救护队进了山，很多事情至今无法忘记。' } : { narrative: narration };

async function app(t, options = {}) {
  const server = createAppServer({ agent: fakeAgent, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  return {
    server,
    base,
    async request(path, body, { headers = {}, method, useCookie = true } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: base, ...(cookie && useCookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return { status: response.status, body: parsed, raw, setCookie, headers: response.headers };
    },
  };
}

test('config and session expose public data only; start keeps credentials in an opaque HttpOnly cookie session', async (t) => {
  let credentials;
  const client = await app(t, { agent: async (input) => { credentials = input.apiKey; return fakeAgent(input); } });
  const config = await client.request('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.characters.length, 5);
  assert.equal(config.body.defaultModel, DEFAULT_MODEL);
  assert.deepEqual((await client.request('/api/session')).body, { game: null });
  const started = await client.request('/api/start', { apiKey: secret, model: DEFAULT_MODEL });
  assert.equal(started.status, 200);
  assert.equal(credentials, secret);
  assert.match(started.setCookie, /fifth_echo_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
  assert.ok(!started.raw.includes(secret));
  assert.equal(started.body.game.status, 'playing');
  assert.equal(started.body.game.memoryCount, 0);
  for (const field of ['apiKey', 'saviorId', 'profiles', 'clues']) assert.equal(started.body.game[field], undefined);
  const resumed = await client.request('/api/session');
  assert.deepEqual(resumed.body, started.body);
  assert.equal(resumed.headers.get('cache-control'), 'no-store');
});

test('talk does not consume memory; five memories remain playable and the sixth ends without another AI call', async (t) => {
  let calls = 0;
  const client = await app(t, { agent: async (input) => { calls++; return fakeAgent(input); } });
  await client.request('/api/start', { apiKey: secret });
  const talk = await client.request('/api/action', { type: 'talk', characterId: 'shen', message: '你当天是从哪里离开的？' });
  assert.equal(talk.status, 200);
  assert.equal(talk.body.game.memoryCount, 0);
  assert.equal(talk.body.game.conversations.shen.length, 2);
  for (let count = 1; count <= 5; count++) {
    const result = await client.request('/api/action', { type: 'memory' });
    assert.equal(result.status, 200);
    assert.equal(result.body.game.memoryCount, count);
    assert.equal(result.body.game.status, 'playing');
  }
  assert.equal(calls, 7);
  const sixth = await client.request('/api/action', { type: 'memory' });
  assert.equal(sixth.body.game.memoryCount, 6);
  assert.equal(sixth.body.game.status, 'lost');
  assert.equal(sixth.body.game.ending.type, 'collapse');
  assert.equal(calls, 7);
  assert.equal((await client.request('/api/action', { type: 'memory' })).status, 409);
  assert.equal(calls, 7);
});

test('accusation is deterministic and does not invoke the model', async (t) => {
  let calls = 0;
  const client = await app(t, { agent: async (input) => { calls++; return fakeAgent(input); } });
  await client.request('/api/start', { apiKey: secret });
  const result = await client.request('/api/action', { type: 'accuse', characterId: 'shen' });
  assert.equal(result.status, 200);
  assert.ok(['won', 'lost'].includes(result.body.game.status));
  assert.equal(result.body.game.ending.saviorId === 'shen', result.body.game.status === 'won');
  assert.equal(calls, 1);
});

test('AI failures and invalid memory output do not alter count or conversation history', async (t) => {
  let mode = 'normal';
  const client = await app(t, { agent: async (input) => {
    if (mode === 'fail') throw new AgentError('连接暂时中断。', { code: 'api_network' });
    if (mode === 'bad') return { clueId: 'invented', narrative: narration };
    return fakeAgent(input);
  } });
  await client.request('/api/start', { apiKey: secret });
  const before = (await client.request('/api/session')).body;
  mode = 'fail';
  assert.equal((await client.request('/api/action', { type: 'memory' })).status, 502);
  assert.equal((await client.request('/api/action', { type: 'talk', characterId: 'shen', message: '你去过战场吗？' })).status, 502);
  assert.deepEqual((await client.request('/api/session')).body, before);
  mode = 'bad';
  assert.equal((await client.request('/api/action', { type: 'memory' })).status, 400);
  assert.deepEqual((await client.request('/api/session')).body, before);
});

test('one pending request locks actions, reset and restart until generation commits', async (t) => {
  let release;
  let entered;
  const pending = new Promise((resolveEntered) => { entered = resolveEntered; });
  const client = await app(t, { agent: async (input) => {
    if (input.action.type === 'memory') {
      entered();
      await new Promise((resolveRelease) => { release = resolveRelease; });
    }
    return fakeAgent(input);
  } });
  await client.request('/api/start', { apiKey: secret });
  const first = client.request('/api/action', { type: 'memory' });
  await pending;
  for (const [path, body] of [
    ['/api/action', { type: 'memory' }],
    ['/api/reset', {}],
    ['/api/start', { apiKey: secret }],
  ]) assert.equal((await client.request(path, body)).status, 409);
  release();
  assert.equal((await first).body.game.memoryCount, 1);
});

test('invalid actions and malformed request bodies are rejected before calling the agent', async (t) => {
  let calls = 0;
  const client = await app(t, { agent: async (input) => { calls++; return fakeAgent(input); } });
  assert.equal((await client.request('/api/start', { apiKey: '' })).status, 400);
  assert.equal((await client.request('/api/start', { apiKey: secret, model: 'random' })).status, 400);
  assert.equal((await client.request('/api/start', '{broken')).status, 400);
  assert.equal((await client.request('/api/start', { apiKey: secret }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await client.request('/api/start', { apiKey: 'a'.repeat(17_000) })).status, 413);
  assert.equal((await client.request('/api/action', { type: 'memory' })).status, 401);
  assert.equal(calls, 0);
  await client.request('/api/start', { apiKey: secret });
  for (const body of [{ type: 'inject' }, { type: 'talk', characterId: 'other', message: '你好' }, { type: 'talk', characterId: 'shen', message: '' }, { type: 'talk', characterId: 'shen', message: 'a'.repeat(1001) }]) {
    assert.equal((await client.request('/api/action', body)).status, 400);
  }
  assert.equal(calls, 1);
});

test('cross-origin and hostile Host requests are forbidden and source files are never served', async (t) => {
  const client = await app(t);
  assert.equal((await client.request('/api/start', { apiKey: secret }, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await client.request('/api/config', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const badHost = await new Promise((resolveStatus, reject) => {
    const request = httpRequest(`${client.base}/api/config`, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHost, 403);
  for (const path of ['/server.mjs', '/src/game.mjs', '/.env', '/%2e%2e/server.mjs', '/art/../../server.mjs']) {
    assert.equal((await client.request(path)).status, 404);
  }
  assert.equal((await client.request('/favicon.ico')).status, 204);
});

test('reset deletes the server session and expires its cookie', async (t) => {
  const client = await app(t);
  await client.request('/api/start', { apiKey: secret });
  const result = await client.request('/api/reset', {});
  assert.deepEqual(result.body, { ok: true });
  assert.match(result.setCookie, /Max-Age=0/);
  assert.deepEqual((await client.request('/api/session')).body, { game: null });
  assert.equal((await client.request('/api/action', { type: 'memory' })).status, 401);
});

test('sessions expire and capacity is bounded, with failed openings releasing their slot', async (t) => {
  let fail = true;
  const client = await app(t, { maxSessions: 1, sessionTtlMs: 500, agent: async (input) => {
    if (fail) throw new Error(`sensitive details ${secret}`);
    return fakeAgent(input);
  } });
  const failed = await client.request('/api/start', { apiKey: secret });
  assert.equal(failed.status, 500);
  assert.ok(!failed.raw.includes(secret));
  fail = false;
  assert.equal((await client.request('/api/start', { apiKey: secret })).status, 200);
  assert.equal((await client.request('/api/start', { apiKey: secret }, { useCookie: false })).status, 503);
  await new Promise((resolveWait) => setTimeout(resolveWait, 550));
  assert.deepEqual((await client.request('/api/session')).body, { game: null });
  assert.equal((await client.request('/api/start', { apiKey: secret })).status, 200);
});
