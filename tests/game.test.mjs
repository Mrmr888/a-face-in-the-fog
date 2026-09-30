import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { CHARACTERS, GameError, createGame, publicGame, validateAction, getAgentContext, applyOpening, applyMemory, applyTalk, accuse, collapseMemory } from '../src/game.mjs';

function rememberAll(game) {
  for (const clue of game.clues) applyMemory(game, { clueId: clue.id, narrative: '硝烟散开，一段清晰的往事浮上来。' });
}

test('every guest can be the fixed savior, with overlapping clues and one full match', () => {
  for (const character of CHARACTERS) {
    const game = createGame({ saviorId: character.id });
    assert.equal(game.saviorId, character.id);
    assert.throws(() => { game.saviorId = 'other'; }, TypeError);
    assert.throws(() => { game.clues[0].text = 'changed'; }, TypeError);
    assert.equal(new Set(game.clues.map((clue) => clue.id)).size, 5);
    for (const clue of game.clues) {
      assert.ok(clue.candidateIds.length > 1 && clue.candidateIds.length < CHARACTERS.length);
      assert.ok(clue.candidateIds.includes(character.id));
    }
    const matches = CHARACTERS.filter((guest) => game.clues.every((clue) => clue.candidateIds.includes(guest.id)));
    assert.deepEqual(matches.map((guest) => guest.id), [character.id]);
    const signatures = CHARACTERS.map((guest) => game.profiles[guest.id].facts.map((fact) => fact.fact).join('|'));
    assert.equal(new Set(signatures).size, 5);
    rememberAll(game);
    assert.equal(game.status, 'playing');
    assert.equal(game.memoryCount, 5);
    assert.equal(accuse(game, character.id).status, 'won');
    assert.equal(game.ending.type, 'success');
  }
});

test('different random draws reassign distractor evidence without changing the savior', (context) => {
  const draw = context.mock.method(crypto, 'randomInt', (maximum) => maximum - 1);
  try {
    syncBuiltinESMExports();
    const first = createGame({ saviorId: 'shen' });
    draw.mock.mockImplementation(() => 0);
    syncBuiltinESMExports();
    const second = createGame({ saviorId: 'shen' });
    assert.equal(first.saviorId, second.saviorId);
    assert.deepEqual(first.profiles.shen, second.profiles.shen);
    for (const character of CHARACTERS.filter((guest) => guest.id !== 'shen')) {
      assert.notDeepEqual(first.profiles[character.id].facts, second.profiles[character.id].facts);
    }
    assert.throws(() => { second.profiles.lu.facts[0].fact = 'changed'; }, TypeError);
    assert.throws(() => { second.clues[0].candidateIds.push('invented'); }, TypeError);
  } finally {
    draw.mock.restore();
    syncBuiltinESMExports();
  }
});

test('public snapshot is independent and hides all authoritative secrets during play', () => {
  const game = createGame({ saviorId: 'su' });
  const snapshot = publicGame(game);
  assert.deepEqual(Object.keys(snapshot).sort(), ['caseId', 'characters', 'conversations', 'ending', 'intro', 'memories', 'memoryCount', 'status']);
  const serialized = JSON.stringify(snapshot);
  for (const key of ['saviorId', 'profiles', 'candidateIds', 'excludedRanks', 'remainingClues']) assert.ok(!serialized.includes(key));
  snapshot.characters[0].name = 'mutated';
  snapshot.conversations.su.push({ role: 'user', text: 'mutated' });
  snapshot.memories.push({ id: 'fake' });
  assert.equal(game.conversations.su.length, 0);
  assert.equal(game.memories.length, 0);
  assert.equal(CHARACTERS[0].name, '沈砚舟');
});

test('agent sees only scoped evidence and gets isolated copies', () => {
  const game = createGame({ saviorId: 'lu' });
  const opening = getAgentContext(game, { type: 'opening' });
  assert.equal(opening.remainingClues, undefined);
  assert.equal(opening.speaker, undefined);
  assert.equal(opening.saviorId, undefined);
  const talk = getAgentContext(game, { type: 'talk', characterId: 'shen', message: '你当晚穿什么？' });
  assert.equal(talk.speaker.facts.length, 5);
  assert.equal(talk.remainingClues, undefined);
  assert.equal(talk.saviorId, undefined);
  assert.equal(talk.profiles, undefined);
  assert.ok(!JSON.stringify(talk).includes('candidateIds'));
  talk.speaker.facts[0].fact = 'mutated';
  assert.notEqual(game.profiles.shen.facts[0].fact, 'mutated');
  applyMemory(game, { clueId: 'hand', narrative: '一只手从烟里伸过来。' });
  const memory = getAgentContext(game, { type: 'memory' });
  assert.equal(memory.remainingClues.length, 4);
  assert.ok(!memory.remainingClues.some((clue) => clue.id === 'hand'));
  assert.ok(memory.remainingClues.every((clue) => !('candidateIds' in clue)));
  assert.equal(memory.knownMemories[0].clue, game.clues[0].text);
});

test('agent contexts project allowed data and never forward server or action extras', () => {
  const game = createGame({ saviorId: 'gu' });
  game.apiKey = 'server-canary-value';
  game.internalNotes = { answer: 'hidden-canary-value' };
  applyTalk(game, { characterId: 'su', message: '当时在哪里？', reply: '我在救护队。' });
  applyMemory(game, { clueId: 'hand', narrative: '烟里一只手。' });
  const actions = [
    { type: 'opening' },
    { type: 'memory' },
    { type: 'talk', characterId: 'su', message: '袖口是什么样？' },
  ];
  for (const action of actions) {
    const context = getAgentContext(game, { ...action, apiKey: 'action-canary-value', profiles: game.profiles });
    const serialized = JSON.stringify(context);
    for (const forbidden of ['server-canary-value', 'hidden-canary-value', 'action-canary-value', 'saviorId', 'candidateIds', 'excludedRanks', 'apiKey', 'profiles']) {
      assert.ok(!serialized.includes(forbidden));
    }
    context.knownMemories[0].clue = 'mutated';
    context.characters[0].name = 'mutated';
    if (context.conversation) context.conversation[0].text = 'mutated';
    if (context.recentConversation) context.recentConversation[0].text = 'mutated';
    if (context.remainingClues) context.remainingClues[0].text = 'mutated';
  }
  assert.notEqual(game.memories[0].clue, 'mutated');
  assert.equal(game.conversations.su[0].text, '当时在哪里？');
  assert.equal(CHARACTERS[0].name, '沈砚舟');
  assert.ok(game.clues.every((clue) => clue.text !== 'mutated'));
});

test('fifth memory leaves play open; sixth deterministically collapses and blocks all actions', () => {
  const game = createGame({ saviorId: 'zhou' });
  rememberAll(game);
  assert.equal(validateAction(game, { type: 'talk', characterId: 'zhou', message: '再说说当晚。' }), true);
  applyTalk(game, { characterId: 'zhou', message: '你还记得吗？', reply: '记得些细节。' });
  assert.equal(game.memoryCount, 5);
  assert.throws(() => getAgentContext(game, { type: 'memory' }), (error) => error.code === 'MEMORY_LIMIT');
  assert.throws(() => applyMemory(game, { clueId: 'hand', narrative: '重复' }), (error) => error.code === 'MEMORY_LIMIT');
  const result = collapseMemory(game);
  assert.equal(result.memoryCount, 6);
  assert.equal(result.status, 'lost');
  assert.equal(result.ending.type, 'collapse');
  assert.equal(result.memories[5].id, 'fabricated-sixth');
  assert.match(result.memories[5].clue, /虚构记忆/);
  const before = JSON.stringify(game);
  for (const action of [() => collapseMemory(game), () => accuse(game, 'zhou'), () => applyTalk(game, { characterId: 'zhou', message: '再来', reply: '好' }), () => applyOpening(game, { narrative: '重开' })]) {
    assert.throws(action, (error) => error.status === 409 && error.code === 'GAME_ENDED');
    assert.equal(JSON.stringify(game), before);
  }
});

test('invalid actions and invalid model outputs do not spend memories or alter state', () => {
  const game = createGame({ saviorId: 'shen' });
  const before = JSON.stringify(game);
  const invalid = [
    () => applyOpening(game, null),
    () => applyOpening(game, { narrative: [] }),
    () => applyMemory(game, null),
    () => applyMemory(game, []),
    () => applyMemory(game, { clueId: 'nonexistent', narrative: '假线索' }),
    () => applyMemory(game, { clueId: 'hand', narrative: '' }),
    () => applyMemory(game, { clueId: 'hand', narrative: 'x'.repeat(6001) }),
    () => applyTalk(game, { characterId: '__proto__', message: '你好', reply: '你好' }),
    () => applyTalk(game, { characterId: 'shen', message: ' ', reply: '你好' }),
    () => applyTalk(game, { characterId: 'shen', message: 'x'.repeat(1001), reply: '你好' }),
    () => applyTalk(game, null),
    () => applyTalk(game, { characterId: 'shen', message: '你好', reply: null }),
    () => accuse(game, 'absent'),
    () => collapseMemory(game),
    () => validateAction(game, { type: 'invent' }),
    () => validateAction(game, null),
    () => validateAction(game, []),
    () => createGame({ saviorId: 'missing' }),
    () => createGame(null),
  ];
  for (const action of invalid) {
    assert.throws(action, GameError);
    assert.equal(JSON.stringify(game), before);
  }
  applyMemory(game, { clueId: 'hand', narrative: '真实片段。' });
  const after = JSON.stringify(game);
  assert.throws(() => applyMemory(game, { clueId: 'hand', narrative: '再次回忆。' }), (error) => error.code === 'DUPLICATE_CLUE');
  assert.equal(JSON.stringify(game), after);
  assert.equal(game.memoryCount, 1);
  assert.equal(game.memories[0].clue, game.clues[0].text);
});

test('a response prepared before an ending cannot mutate the finished game', () => {
  const game = createGame({ saviorId: 'zhou' });
  const action = { type: 'talk', characterId: 'zhou', message: '回想那天。' };
  assert.equal(validateAction(game, action), true);
  const clue = getAgentContext(game, { type: 'memory' }).remainingClues[0];
  accuse(game, 'zhou');
  const before = JSON.stringify(game);
  for (const commit of [
    () => applyTalk(game, { ...action, reply: '迟来的回答。' }),
    () => applyMemory(game, { clueId: clue.id, narrative: '迟来的记忆。' }),
  ]) {
    assert.throws(commit, (error) => error.code === 'GAME_ENDED');
    assert.equal(JSON.stringify(game), before);
  }
});

test('accusation works before five memories and wrong choice ends play with explanation', () => {
  const correct = createGame({ saviorId: 'gu' });
  applyOpening(correct, { narrative: '  酒会已开始。  ' });
  assert.equal(correct.intro, '酒会已开始。');
  assert.throws(() => applyOpening(correct, { narrative: '第二开场' }), (error) => error.code === 'ALREADY_STARTED');
  assert.equal(accuse(correct, 'gu').status, 'won');
  assert.equal(correct.memoryCount, 0);
  const wrong = createGame({ saviorId: 'lu' });
  const result = accuse(wrong, 'shen');
  assert.equal(result.status, 'lost');
  assert.equal(result.ending.type, 'wrong');
  assert.equal(result.ending.saviorId, 'lu');
  assert.match(result.ending.explanation, /陆映棠/);
  assert.throws(() => accuse(wrong, 'lu'), (error) => error.code === 'GAME_ENDED');
});
