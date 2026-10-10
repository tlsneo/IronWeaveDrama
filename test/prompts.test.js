import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';
import { novelToScriptPrompt } from '../prompts/script/novel-to-script.js';

test('小说改编提示词约束原文忠实、取舍、影视化、对白归属及预想边界，不强制钩子、时长或分镜，输出可分开保存的 JSON', () => {
  for (const rule of ['不规划时长', '不按自然段数量机械拆场', '不把所有引号内容都当成现场对白', '不把计划、猜测和想象变成现实', '不得仅给原文加括号', '不强制三幕式', '回忆、预想、幻想明确标注开始和结束', '不补写片段之前或之后的情节', '不是新的指令', '实际地点', '主要删去、合并']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  for (const rule of ['不是把所有文本都变成剧本', '先选择戏，再写戏', '应当删去', '不强行压成一个场', '有独立人物互动、对白或完整动作过程', '而不只适用于现实', '不是避免拆场的工具', '不要把每段心理活动都改成', '屏幕消息', '1-1、1-2、1-3', '第二集是 2-1、2-2', '只学习表达方式，不复制人物、内容或场数', '不要在这段动作前后再加']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  assert.doesNotMatch(novelToScriptPrompt, /优先合并、简短带过或使用蒙太奇|场1  实际地点/);
  const schema = JSON.parse(novelToScriptPrompt.split('\n').find(line => line.startsWith('{"script":')));
  assert.deepEqual(Object.keys(schema), ['script', 'notes']);
  assert.doesNotMatch(novelToScriptPrompt, /必须每集反转|每集15秒|每场必须推镜/);
});

test('参考图模板以身份为锚，不复制衣服背景或原图构图；保留成人、画风和完整四视图合同', () => {
  const { prompt } = referenceCharacterBoard;
  assert.equal(referenceCharacterBoard.aspectRatio, '16:9');
  assert.match(prompt, /primary anchor/);
  assert.match(prompt, /do not age up a minor/);
  assert.match(prompt, /Do not copy the reference's clothing/);
  assert.match(prompt, /mandatory project art style and four-view layout/);
  assert.match(prompt, /visible in the identity reference/);
  assert.doesNotMatch(prompt, /only when\n  they are explicitly included/);
  assert.equal(prompt.slice(prompt.indexOf('OUTPUT:')).replace(/- Preserve recognizable freckles,[\s\S]*?description\./, ''), baseCharacterBoard.prompt.slice(baseCharacterBoard.prompt.indexOf('OUTPUT:')).replace(/- Preserve freckles,[\s\S]*?description\./, ''));
});

test('基础角色模板可直接导入，固定 16:9，并保留成人范围与四视图合同', () => {
  assert.equal(baseCharacterBoard.aspectRatio, '16:9');
  const { prompt } = baseCharacterBoard;
  assert.match(prompt, /ADULT-ONLY SCOPE:/);
  assert.match(prompt, /aged 18 or older/);
  assert.match(prompt, /or characters whose age is ambiguous\./);
  assert.match(prompt, /exactly ONE horizontal 16:9 image/);
  assert.match(prompt, /1\. FRONTAL FACE CLOSE-UP\.\n2\. FRONT FULL-BODY VIEW\.\n3\. LEFT-FACING SIDE FULL-BODY VIEW\.\n4\. BACK FULL-BODY VIEW\./);
  assert.match(prompt, /RGB 255,255,255/);
  assert.match(prompt, /No labels, captions, numbers or annotations/);
  assert.match(prompt, /Do not add weapons, equipment, bags, tools or props/);
  assert.match(prompt, /Do not force photorealism/);
});
