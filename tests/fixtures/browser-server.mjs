// UI verification only; the production entry point never imports this file.
import { createAppServer } from '../../server.mjs';
import { AgentError } from '../../src/deepseek.mjs';

const server = createAppServer({
  agent: async ({ apiKey, action, context }) => {
    if (apiKey !== 'offline-ui-check') {
      throw new AgentError('离线测试口令应为 offline-ui-check，请勿输入真实密钥。', { status: 401, code: 'test_key' });
    }
    if (action.type === 'opening') {
      return { narrative: '【离线界面测试 · 非真实模型】你推开澄江饭店的门。雨声留在门外，五位来宾在灯下举杯。青石岭的硝烟早已散尽，那只将你拉起的手，却仿佛仍带着温度。今夜，你要从这些陌生的面孔里认出故人。' };
    }
    if (action.type === 'memory') {
      const clue = context.remainingClues[0];
      return { clueId: clue.id, narrative: `你轻轻闭上眼。雨水与硝烟渐渐退去，某个细节从旧事深处浮现：${clue.text}` };
    }
    if (action.message.includes('模拟故障')) {
      throw new AgentError('离线模拟：请求失败，进度未改变。', { code: 'test_failure' });
    }
    return { reply: `“我记得的，是这些。”${context.speaker.name}放下酒杯。\n${context.speaker.facts.map((item) => item.fact).join('\n')}` };
  },
});

server.listen(3001, '127.0.0.1', () => console.log('仅离线 UI 测试：http://localhost:3001（测试口令 offline-ui-check）'));
