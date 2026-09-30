const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { game: null, model: 'deepseek-flash', selected: 'shen', busy: false, configReady: false };
let toastTimer;
let confirmCallback;

const previewCharacters = [
  { id: 'shen', name: '沈砚舟', role: '随军医生', quote: '活下来的人，都欠过一条命。' },
  { id: 'lu', name: '陆映棠', role: '战地记者', quote: '报纸写不下每个人的名字。' },
  { id: 'gu', name: '顾怀章', role: '航运行商', quote: '船也能载几个人回家。' },
  { id: 'su', name: '苏曼卿', role: '戏班歌者', quote: '台下的人，未必等得到团圆。' },
  { id: 'zhou', name: '周渡', role: '电报译员', quote: '有些话，只差一步。' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function portrait(character) {
  const img = el('img');
  img.src = `/art/${character.id}.svg`;
  img.alt = `${character.name}的人物画像`;
  return img;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(75000),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '等待故事回应超时，请稍后重试。' : '无法连接本地服务。请确认 npm start 仍在运行。');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('服务返回了无法读取的内容，请稍后重试。'); }
  if (!response.ok) {
    const error = new Error(data.error || '这次请求没有完成，请重试。');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function setBusy(busy, message = '有人正在回忆往事……') {
  state.busy = busy;
  $('#busy-indicator').hidden = !busy;
  $('#busy-text').textContent = message;
  $$('button').forEach((button) => { button.disabled = busy; });
  $('#message-input').disabled = busy || (state.game !== null && state.game.status !== 'playing');
  $('#api-key').disabled = busy;
  $('#model-select').disabled = busy;
  if (!busy && state.game?.status !== 'playing' && state.game) {
    $('#talk-form button').disabled = true;
    $$('.suggestion').forEach((button) => { button.disabled = true; });
  }
  $('#enter-button').replaceChildren(document.createTextNode(busy ? '故事正在落笔，请稍候…' : '推开酒会的门 '), el('span', '', busy ? '…' : '↗'));
}

function renderPreviews(characters) {
  $('#guest-previews').replaceChildren(...characters.map((character, index) => {
    const card = el('button', 'guest-card');
    card.type = 'button';
    card.setAttribute('aria-label', `了解${character.name}并开始游戏`);
    card.addEventListener('click', openSetup);
    const imageWrap = el('div', 'guest-image-wrap');
    imageWrap.append(portrait(character), el('span', 'guest-index', `NO. 0${index + 1}`));
    const info = el('div', 'guest-card-info');
    const title = el('div', 'guest-card-title');
    title.append(el('h3', '', character.name), el('span', '', character.role));
    info.append(title, el('p', '', `“${character.quote}”`));
    card.append(imageWrap, info);
    return card;
  }));
}

function openSetup() {
  if (state.busy) return;
  if (state.game) { showGame(); return; }
  $('#setup-error').hidden = true;
  $('#setup-dialog').showModal();
  $('#api-key').focus();
}

function showGame() {
  $('#landing').hidden = true;
  $('#play').hidden = false;
  $$('.top-nav a').forEach((a) => { a.hidden = true; });
  renderGame();
}

function renderPeople() {
  $('#people-list').replaceChildren(...state.game.characters.map((character) => {
    const button = el('button', `person-button${state.selected === character.id ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.selected === character.id));
    button.setAttribute('aria-label', `与${character.name}交谈`);
    const labels = el('span');
    labels.append(el('span', 'person-name', character.name), el('span', 'person-role', character.role));
    button.append(portrait(character), labels, el('span', 'person-indicator', '↗'));
    button.addEventListener('click', () => {
      if (state.busy) return;
      state.selected = character.id;
      $('#message-input').value = '';
      renderPeople();
      renderConversation();
      setBusy(false);
    });
    return button;
  }));
}

function renderConversation() {
  const character = state.game.characters.find((guest) => guest.id === state.selected);
  const profile = el('div', 'active-profile');
  const description = el('div');
  description.append(el('h2', '', character.name), el('span', 'profile-role', `${character.role} / ${character.age} 岁`), el('p', '', character.description));
  profile.append(portrait(character), description);
  $('#active-profile').replaceChildren(profile);
  const messages = state.game.conversations[character.id] || [];
  $('#conversation-count').textContent = messages.length ? `${messages.length / 2} 次交谈` : '尚未交谈';
  if (!messages.length) {
    const empty = el('div', 'conversation-empty');
    empty.append(el('span', 'empty-flower', '✧'), el('p', '', `“${character.quote}”`), el('p', '', '走近一些，听听这位来宾的往事。'));
    $('#conversation').replaceChildren(empty);
  } else {
    $('#conversation').replaceChildren(...messages.map((message) => {
      const entry = el('div', `chat-entry ${message.role === 'user' ? 'user' : 'assistant'}`);
      entry.append(el('span', '', message.role === 'user' ? '你 · 轻声问道' : character.name), el('p', '', message.text));
      return entry;
    }));
  }
  const questions = state.game.memories.length
    ? ['能让我看看你的左手吗？', '那时你的衣袖和随身物品是什么样？', '青石岭那晚，你从哪里撤离？']
    : ['那年秋天，你也去过青石岭吗？', '你为什么来参加这场酒会？'];
  $('#suggestions').replaceChildren(...questions.map((question) => {
    const button = el('button', 'suggestion', question);
    button.type = 'button';
    button.addEventListener('click', () => { $('#message-input').value = question; $('#message-input').focus(); });
    return button;
  }));
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
}

function renderMemories() {
  const game = state.game;
  const openIds = new Set($$('.memory-card[open]').map((node) => node.dataset.id));
  $('#memory-used').textContent = String(game.memoryCount).padStart(2, '0');
  $('#memory-pips').replaceChildren(...Array.from({ length: 5 }, (_, index) => el('span', `memory-pip${index < game.memoryCount ? ' used' : ''}`)));
  $('#memory-pips').setAttribute('aria-label', `已回忆 ${Math.min(game.memoryCount, 5)} 段真实记忆，最多 5 段`);
  const items = game.memories.map((memory, index) => {
    const card = el('details', `memory-card${memory.number === 6 ? ' false-memory' : ''}`);
    card.dataset.id = memory.id;
    card.open = openIds.has(memory.id) || index === game.memories.length - 1;
    const title = el('summary');
    title.append(el('span', '', String(memory.number).padStart(2, '0')), document.createTextNode(memory.title));
    const clue = el('p', 'memory-clue');
    clue.append(el('b', '', memory.number === 6 ? '虚构 · 从未发生' : '可核实的记忆'), document.createTextNode(memory.clue));
    card.append(title, el('p', 'memory-narrative', memory.text), clue);
    return card;
  });
  for (let index = game.memoryCount; index < 5; index++) {
    const row = el('div', 'memory-empty-row');
    row.append(el('span', '', String(index + 1).padStart(2, '0')), el('p', '', index === game.memoryCount ? '有些往事，尚待想起' : '隐没在硝烟之中'));
    items.push(row);
  }
  $('#memory-list').replaceChildren(...items);
  $('#memory-description').textContent = game.memoryCount >= 5 ? '真实的记忆已全部浮现。现在，请相信你的判断。' : '硝烟散了，有些细节却仍留在身体里。';
  $('#recall-label').textContent = game.status !== 'playing' ? '重读这一夜的结局' : game.memoryCount === 5 ? '执意回想第六次' : '唤起一段记忆';
  $('#memory-warning').textContent = game.memoryCount === 5 && game.status === 'playing' ? '你仍可继续交谈并相认。再次回想将立即失败。' : game.status !== 'playing' ? '此刻尘埃落定，你可以回看全部线索。' : '每次回想消耗一段记忆，第六次将触发失败结局。';
  $('#memory-warning').classList.toggle('danger', game.memoryCount === 5);
}

function renderGame() {
  const game = state.game;
  if (!game) return;
  $('#scene-intro').textContent = game.intro;
  $('#case-id').textContent = `卷宗 ${game.caseId.slice(0, 8).toUpperCase()}`;
  $('#model-label').textContent = state.model === 'deepseek-flash' ? 'DEEPSEEK V4.1 FLASH' : 'DEEPSEEK V4 PRO';
  $('#game-location').textContent = game.status === 'playing' ? '澄江饭店 · 酒会进行中' : '澄江饭店 · 夜已深';
  $('#recognize-button').replaceChildren(document.createTextNode(game.status === 'playing' ? '我认出你了 ' : '重赴酒会 '), el('span', '', '↗'));
  renderPeople();
  renderConversation();
  renderMemories();
  setBusy(state.busy);
}

function showEnding() {
  const ending = state.game?.ending;
  if (!ending) return;
  const success = ending.type === 'success';
  $('#ending-dialog').classList.toggle('success', success);
  $('#ending-eyebrow').textContent = success ? 'THE ONE YOU REMEMBERED' : ending.type === 'collapse' ? 'A MEMORY THAT NEVER WAS' : 'A STRANGER AFTER ALL';
  $('#ending-mark').textContent = success ? '逢' : ending.type === 'collapse' ? '妄' : '憾';
  $('#ending-title').textContent = ending.title;
  $('#ending-text').textContent = ending.text;
  $('#ending-explanation').textContent = ending.explanation;
  const guest = state.game.characters.find((character) => character.id === ending.saviorId);
  const labels = el('div');
  labels.append(el('span', '', '那年伸出手的人'), el('strong', '', `${ending.saviorName} · ${guest.role}`));
  $('#ending-truth').replaceChildren(portrait(guest), labels);
  if (!$('#ending-dialog').open) $('#ending-dialog').showModal();
}

function confirmChoice(title, description, actionLabel, callback) {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-action').replaceChildren(document.createTextNode(`${actionLabel} `), el('span', '', '↗'));
  confirmCallback = callback;
  $('#confirm-dialog').showModal();
}

async function performAction(action) {
  if (state.busy) return;
  setBusy(true, action.type === 'memory' ? '闭上眼，硝烟中的旧事正在浮现……' : action.type === 'talk' ? '对面的来宾放下酒杯，想了片刻……' : '你终于说出了那个名字……');
  const previousCount = state.game.memoryCount;
  try {
    const data = await request('/api/action', action);
    state.game = data.game;
    if (action.type === 'talk') $('#message-input').value = '';
    renderGame();
    if (state.game.ending) showEnding();
    else if (action.type === 'memory') {
      toast(`第 ${state.game.memoryCount} 段记忆已记入手账。${state.game.memoryCount === 5 ? '仍可继续交谈，现在请作出判断。' : '试着与来宾的说法相互印证。'}`);
      if (window.innerWidth < 901) $('.memory-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    // A response can be lost after a successful commit. Resync before retrying.
    try {
      const current = await request('/api/session');
      if (current.game) {
        state.game = current.game;
        renderGame();
        if (state.game.ending) showEnding();
      } else if (error.status === 401 || error.code === 'SESSION_EXPIRED') {
        state.game = null;
        showLanding();
      }
    } catch { /* Keep the last known state; server remains authoritative. */ }
    const synced = state.game && state.game.memoryCount > previousCount;
    toast(synced ? '回应传输中断，已同步最新记忆，无需重复回想。' : error.message);
  } finally { setBusy(false); }
}

function showLanding() {
  $('#landing').hidden = false;
  $('#play').hidden = true;
  $$('.top-nav a').forEach((a) => { a.hidden = false; });
  $('#player-notes').value = '';
  $('#message-input').value = '';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function resetGame(openNext = false) {
  if (state.busy) return;
  setBusy(true, '将这一夜的往事轻轻合上……');
  try {
    await request('/api/reset', {});
    state.game = null;
    state.selected = 'shen';
    $$('dialog[open]').forEach((dialog) => dialog.close());
    showLanding();
    setBusy(false);
    if (openNext) openSetup();
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

const actions = {
  start: openSetup,
  rules: () => $('#rules-dialog').showModal(),
  memory: () => {
    if (!state.game || state.busy) return;
    if (state.game.ending) return showEnding();
    if (state.game.memoryCount === 5) {
      confirmChoice('这一次，记忆会撒谎。', '你已经找回五段真实记忆，仍可自由交谈、选择恩人。执意回想第六次，会产生不存在的记忆，并立即结束本局。', '仍要回想', () => performAction({ type: 'memory' }));
    } else performAction({ type: 'memory' });
  },
  accuse: () => {
    if (!state.game || state.busy) return;
    if (state.game.ending) return resetGame(true);
    const guest = state.game.characters.find((character) => character.id === state.selected);
    confirmChoice(`是你，${guest.name}。`, `你认定${guest.name}就是青石岭上救你的人。相认只有一次机会，选对即获胜，认错则本局结束。你确定吗？`, '与故人相认', () => performAction({ type: 'accuse', characterId: guest.id }));
  },
  restart: () => confirmChoice('今夜，就此离席？', '离席会清除本局进度与服务内存中的 API Key。下次入席将重新安排真相。', '确认离席', () => resetGame()),
  replay: () => resetGame(true),
};

$$('[data-action]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) actions[button.dataset.action]?.(); }));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) button.closest('dialog').close(); }));
$$('dialog').forEach((dialog) => dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); }));
$('.brand').addEventListener('click', (event) => {
  if (state.game) { event.preventDefault(); if (!state.busy) actions.restart(); }
});
$('#confirm-action').addEventListener('click', () => {
  if (state.busy) return;
  $('#confirm-dialog').close();
  const callback = confirmCallback;
  confirmCallback = undefined;
  callback?.();
});
$('#toggle-key').addEventListener('click', () => {
  const input = $('#api-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('#toggle-key').textContent = show ? '隐藏' : '显示';
  $('#toggle-key').setAttribute('aria-label', show ? '隐藏密钥' : '显示密钥');
});

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const apiKey = $('#api-key').value.trim();
  if (!apiKey) { $('#api-key').focus(); return; }
  $('#setup-error').hidden = true;
  setBusy(true, '请柬已递出，故事正在开场……');
  try {
    const data = await request('/api/start', { apiKey, model: $('#model-select').value });
    state.game = data.game;
    state.model = data.model || $('#model-select').value;
    state.selected = state.game.characters[0].id;
    $('#api-key').value = '';
    $('#api-key').type = 'password';
    $('#toggle-key').textContent = '显示';
    $('#toggle-key').setAttribute('aria-label', '显示密钥');
    $('#setup-dialog').close();
    showGame();
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) {
    $('#setup-error').textContent = error.message;
    $('#setup-error').hidden = false;
  } finally { setBusy(false); }
});

$('#talk-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const message = $('#message-input').value.trim();
  if (!message || state.busy || state.game?.status !== 'playing') return;
  performAction({ type: 'talk', characterId: state.selected, message });
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#talk-form').requestSubmit();
  }
});

async function bootstrap() {
  renderPreviews(previewCharacters);
  const results = await Promise.allSettled([request('/api/config'), request('/api/session')]);
  if (results[0].status === 'fulfilled') {
    const config = results[0].value;
    state.configReady = true;
    renderPreviews(config.characters);
    $('#model-select').replaceChildren(...config.models.map((model) => {
      const option = el('option', '', `${model.name}${model.description ? ` · ${model.description}` : ''}`);
      option.value = model.id;
      return option;
    }));
    $('#model-select').value = config.defaultModel;
  } else { toast('未能连接游戏服务，请通过 npm start 启动后访问本地网址。'); }
  if (results[1].status === 'fulfilled' && results[1].value.game) {
    state.game = results[1].value.game;
    state.model = results[1].value.model || state.model;
    showGame();
    if (state.game.ending) showEnding();
  }
}

bootstrap();
