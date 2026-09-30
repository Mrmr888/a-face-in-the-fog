import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  CHARACTERS, GameError, createGame, publicGame, getAgentContext, applyOpening,
  applyMemory, applyTalk, accuse, collapseMemory, validateAction,
} from './src/game.mjs';
import { createDeepSeekAgent, AgentError, DEFAULT_MODEL, MODELS } from './src/deepseek.mjs';

const COOKIE_NAME = 'fifth_echo_session';
const BODY_LIMIT = 16 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['hotel', 'shen', 'lu', 'gu', 'su', 'zhou', 'mark'].map((name) => [`/art/${name}.svg`, [`art/${name}.svg`, 'image/svg+xml']]),
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'content_type', '请以 JSON 格式发送请求。');
  }
  if (Number(request.headers['content-length']) > BODY_LIMIT) {
    request.resume();
    throw new HttpError(413, 'body_too_large', '请求内容过长。');
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body_too_large', '请求内容过长。'));
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolveBody(value);
      } catch {
        reject(new HttpError(400, 'invalid_json', '请求 JSON 无效。'));
      }
    });
    request.on('error', () => reject(new HttpError(400, 'request_interrupted', '请求已中断，请重试。')));
  });
}

function sessionId(request) {
  const cookies = (request.headers.cookie ?? '').split(';');
  const entry = cookies.map((value) => value.trim()).find((value) => value.startsWith(`${COOKIE_NAME}=`));
  const id = entry?.slice(COOKIE_NAME.length + 1);
  return /^[a-f0-9]{64}$/.test(id ?? '') ? id : null;
}

function cookie(id, ttlMs) {
  return `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}`;
}

function validateLocalRequest(request, port) {
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) {
    throw new HttpError(403, 'invalid_host', '此游戏只接受本机访问。');
  }
  const expected = new URL(`http://${host}`);
  if (Number(expected.port || 80) !== port) throw new HttpError(403, 'invalid_host', '访问地址端口不匹配。');
  if (request.headers.origin && request.headers.origin !== expected.origin) {
    throw new HttpError(403, 'invalid_origin', '不允许跨站请求。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'invalid_origin', '不允许跨站请求。');
}

export function createAppServer({ agent = createDeepSeekAgent(), sessionTtlMs = 2 * 60 * 60 * 1000, maxSessions = 128 } = {}) {
  const sessions = new Map();
  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now && !session.busy) sessions.delete(id);
    }
  }
  function currentSession(request) {
    const id = sessionId(request);
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session && !session.busy) sessions.delete(id);
      return null;
    }
    return { id, session };
  }
  const cleanup = setInterval(prune, Math.min(60_000, sessionTtlMs));
  cleanup.unref();

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      validateLocalRequest(request, server.address()?.port);
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        response.setHeader('Cache-Control', 'no-store');
        if (path === '/api/config' && request.method === 'GET') {
          return sendJson(response, 200, { characters: CHARACTERS, models: MODELS, defaultModel: DEFAULT_MODEL });
        }
        if (path === '/api/session' && request.method === 'GET') {
          const found = currentSession(request);
          return sendJson(response, 200, { game: found?.session.game ? publicGame(found.session.game) : null, ...(found?.session.game ? { model: found.session.model } : {}) });
        }
        if (!['/api/start', '/api/action', '/api/reset'].includes(path)) throw new HttpError(404, 'not_found', '接口不存在。');
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '此操作需要 POST 请求。');
        const body = await readJson(request);
        const found = currentSession(request);
        if (path === '/api/reset') {
          if (found?.session.busy) throw new HttpError(409, 'busy', '上一段剧情仍在生成，请稍候。');
          if (found) sessions.delete(found.id);
          response.setHeader('Set-Cookie', cookie('', 0));
          return sendJson(response, 200, { ok: true });
        }
        if (path === '/api/start') {
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
          if (!apiKey || apiKey.length > 256 || /\s|[^\x21-\x7e]/.test(apiKey)) throw new HttpError(400, 'invalid_key', '请输入有效的 DeepSeek API Key（最多 256 个字符）。');
          const model = body.model ?? DEFAULT_MODEL;
          if (!MODELS.some((item) => item.id === model)) throw new HttpError(400, 'invalid_model', '请选择支持的 DeepSeek 模型。');
          if (found?.session.busy) throw new HttpError(409, 'busy', '上一段剧情仍在生成，请稍候。');
          prune();
          if (!found && sessions.size >= maxSessions) throw new HttpError(503, 'session_capacity', '当前游戏会话较多，请稍后再试。');
          const id = found?.id ?? randomBytes(32).toString('hex');
          const session = found?.session ?? { game: null, expiresAt: Date.now() + sessionTtlMs };
          session.busy = true;
          sessions.set(id, session);
          try {
            const game = createGame();
            const action = { type: 'opening' };
            const result = await agent({ apiKey, model, action, context: getAgentContext(game, action) });
            applyOpening(game, result);
            Object.assign(session, { apiKey, model, game, expiresAt: Date.now() + sessionTtlMs });
            response.setHeader('Set-Cookie', cookie(id, sessionTtlMs));
            return sendJson(response, 200, { game: publicGame(game), model });
          } catch (error) {
            if (!found) sessions.delete(id);
            throw error;
          } finally {
            session.busy = false;
          }
        }
        if (!found?.session.game) throw new HttpError(401, 'no_session', '游戏会话已过期，请重新输入 API Key 开始。');
        const { session } = found;
        if (session.busy) throw new HttpError(409, 'busy', '上一段剧情仍在生成，请稍候。');
        const action = { type: body.type, characterId: body.characterId, message: body.message };
        if (!['talk', 'memory', 'accuse'].includes(action.type)) throw new HttpError(400, 'invalid_action', '未知的游戏操作。');
        validateAction(session.game, action);
        session.busy = true;
        try {
          if (action.type === 'accuse') accuse(session.game, action.characterId);
          else if (action.type === 'memory' && session.game.memoryCount === 5) collapseMemory(session.game);
          else {
            const result = await agent({ apiKey: session.apiKey, model: session.model, action, context: getAgentContext(session.game, action) });
            if (action.type === 'memory') applyMemory(session.game, result);
            else applyTalk(session.game, { characterId: action.characterId, message: action.message, reply: result.reply });
          }
          return sendJson(response, 200, { game: publicGame(session.game) });
        } finally {
          session.busy = false;
        }
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method_not_allowed', '不支持此请求方式。');
      if (path === '/favicon.ico') {
        response.writeHead(204);
        return response.end();
      }
      const staticFile = STATIC_FILES.get(path);
      if (!staticFile) throw new HttpError(404, 'not_found', '页面不存在。');
      let content;
      try { content = await readFile(resolve(PUBLIC_DIR, staticFile[0])); }
      catch { throw new HttpError(404, 'not_found', '页面不存在。'); }
      response.writeHead(200, { 'Content-Type': staticFile[1], 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const safe = error instanceof HttpError || error instanceof AgentError || error instanceof GameError;
      sendJson(response, safe ? error.status : 500, {
        error: safe ? error.message : '剧情暂时无法继续，请重试。本次进度未改变。',
        code: safe ? error.code : 'internal_error',
      });
    }
  });
  server.requestTimeout = 70_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { clearInterval(cleanup); sessions.clear(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须为 1 至 65535 的整数。');
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : '游戏服务无法启动。');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`游戏已启动：http://127.0.0.1:${port}`));
  }
}
