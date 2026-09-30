import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekAgent, DEFAULT_MODEL } from '../src/deepseek.mjs';

const secret = 'sk-test-secret-never-return';
const input = {
  apiKey: secret,
  model: DEFAULT_MODEL,
  action: { type: 'memory' },
  context: { characters: [{ name: '沈砚舟' }], remainingClues: [{ id: 'hand', text: '左手虎口旧灼痕' }] },
};
const responseFor = (value, extra = {}) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...extra }] });

test('agent uses official endpoint, JSON mode and header-only credentials', async () => {
  let request;
  const agent = createDeepSeekAgent({ fetchImpl: async (url, options) => {
    request = { url, options };
    return responseFor({ clueId: 'hand', narrative: '雨声中，你记得左手虎口那道旧灼痕。', ignored: 'discarded' });
  } });
  const result = await agent(input);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${secret}`);
  assert.ok(!request.options.body.includes(secret));
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /雾中来客/);
  assert.deepEqual(result, { clueId: 'hand', narrative: '雨声中，你记得左手虎口那道旧灼痕。' });
});

test('all supported action shapes return validated text', async () => {
  for (const [type, field] of [['opening', 'narrative'], ['talk', 'reply']]) {
    const agent = createDeepSeekAgent({ fetchImpl: async () => responseFor({ [field]: '那场大雨以后，我一直在这里等消息。' }) });
    assert.deepEqual(await agent({ ...input, action: { type } }), { [field]: '那场大雨以后，我一直在这里等消息。' });
  }
});

test('unknown clues, names in memories, malformed output and thinking tags are rejected', async () => {
  const outputs = [
    { clueId: 'invented', narrative: '这是一段没有在案卷中出现过的记忆。' },
    { clueId: 'hand', narrative: '你想起来，当时救下你的人就是沈砚舟。' },
    { clueId: 'hand', narrative: '<think>我来推断答案</think>雨一直下。' },
    { clueId: 'hand', narrative: '' },
    { clueId: 'hand', narrative: 'a'.repeat(1201) },
    null,
    [],
  ];
  for (const output of outputs) {
    const agent = createDeepSeekAgent({ fetchImpl: async () => responseFor(output) });
    await assert.rejects(agent(input), { code: 'invalid_agent_output' });
  }
});

test('opening may introduce guests using their public names', async () => {
  const narrative = '沈砚舟从远处走了过来，在桌边放下一只空酒杯。你望向其余宾客，那晚的硝烟仍模糊了恩人的面容。';
  const agent = createDeepSeekAgent({ fetchImpl: async () => responseFor({ narrative }) });
  assert.deepEqual(await agent({ ...input, action: { type: 'opening' } }), { narrative });
});

test('truncated JSON, invalid provider JSON and oversized responses are rejected', async () => {
  for (const response of [
    new Response('{invalid-json'),
    Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
    responseFor({ clueId: 'hand', narrative: '这是尚未完成的一段记忆。' }, { finish_reason: 'length' }),
    new Response('a'.repeat(128 * 1024 + 1)),
  ]) {
    const agent = createDeepSeekAgent({ fetchImpl: async () => response });
    await assert.rejects(agent(input), { code: 'invalid_agent_output' });
  }
});

test('provider failures expose only safe localized messages', async () => {
  for (const [status, code] of [[401, 'api_auth'], [403, 'api_auth'], [402, 'api_balance'], [429, 'api_rate_limit'], [404, 'api_model'], [503, 'api_unavailable']]) {
    const agent = createDeepSeekAgent({ fetchImpl: async () => new Response(`upstream leaked ${secret}`, { status }) });
    await assert.rejects(agent(input), (error) => error.code === code && !error.message.includes(secret) && !error.message.includes('upstream'));
  }
});

test('network errors and echoed credentials never expose secrets', async () => {
  const networkAgent = createDeepSeekAgent({ fetchImpl: async () => { throw new Error(`request failed with ${secret}`); } });
  await assert.rejects(networkAgent(input), (error) => error.code === 'api_network' && !error.message.includes(secret));
  const echoedAgent = createDeepSeekAgent({ fetchImpl: async () => responseFor({ clueId: 'hand', narrative: `你突然想起了这个字符串：${secret}` }) });
  await assert.rejects(echoedAgent(input), (error) => error.code === 'invalid_agent_output' && !error.message.includes(secret));
});

test('local permission errors in causes and aggregate errors return safe actionable guidance', async () => {
  const permission = (code) => Object.assign(new Error(`blocked request with ${secret}`), { code });
  const cyclic = new Error(`cyclic failure ${secret}`);
  cyclic.cause = cyclic;
  cyclic.errors = [cyclic, new Error('nested failure', { cause: permission('EPERM') })];
  const errors = [
    permission('EACCES'),
    new TypeError('fetch failed', { cause: permission('EPERM') }),
    new TypeError('fetch failed', { cause: new AggregateError([
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      new Error('connection failed', { cause: permission('EACCES') }),
    ], `aggregate failure ${secret}`) }),
    cyclic,
  ];
  for (const failure of errors) {
    const agent = createDeepSeekAgent({ fetchImpl: async () => { throw failure; } });
    await assert.rejects(agent(input), (error) => {
      assert.equal(error.code, 'api_permission');
      assert.equal(error.status, 502);
      assert.equal(error.message, '本地运行环境禁止联网，请在系统终端运行 npm start，或允许本地服务访问 DeepSeek。');
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(secret));
      return true;
    });
  }
});

test('timeout aborts provider request and returns a safe retry message', async () => {
  const agent = createDeepSeekAgent({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('unexpected timeout')), 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }) });
  await assert.rejects(agent(input), { code: 'api_timeout', status: 504 });
});

test('unsupported models are rejected without network traffic', async () => {
  let called = false;
  const agent = createDeepSeekAgent({ fetchImpl: async () => { called = true; } });
  await assert.rejects(agent({ ...input, model: 'untrusted-model' }), { code: 'invalid_model' });
  assert.equal(called, false);
});
