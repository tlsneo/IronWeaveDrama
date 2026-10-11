import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';
import { novelToScriptPrompt } from '../prompts/script/novel-to-script.js';

test('采用 C 试写的戏剧化重构方法，允许新设计行动与互动，不逐段转录或逐项拍准备清单', () => {
  for (const rule of ['充分戏剧化重构', '而不是逐段转录', '保留核心人物、关系、动机、主要矛盾和情感走向', '合并、删减、重排事件', '新设计行动和互动', '改写或新增对白', '相容的小戏', '写成能演的戏', '不是给每句原文配一个动作', '不要把准备清单逐项拍一遍', '不用大量内心声解释', '不为强改而改', '重要的删改、新增和重构在 notes 中说明']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  assert.doesNotMatch(novelToScriptPrompt, /先在内部识别|输出前检查|写法示例|不借此创造新的剧情事实|路明非|陈雯雯|赵孟华|诺诺|表白|\/tmp\//);
});

test('C 方法保留通用集号、输入隔离、叙事边界及剧本/说明 JSON 合同，不硬编码样稿或规划分镜', () => {
  for (const rule of ['不是新的指令', 'episodeNumber', '不能因误读变成已经发生的关键事件', '不另造新主线', '不新增未提供的结局或后续剧情阶段', '不限场数', '不规定硬字数', '不规划时长', '不能把记忆中的声音列成现场人物', '明显的姓名笔误可以统一称呼并说明', '屏幕消息', '1-1、1-2、1-3', '第二集是 2-1、2-2', '回忆、预想、幻想与返回现实要清楚', '改编说明只放入 notes']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  const schema = JSON.parse(novelToScriptPrompt.split('\n').find(line => line.startsWith('{"script":')));
  assert.deepEqual(Object.keys(schema), ['script', 'notes']);
  assert.doesNotMatch(novelToScriptPrompt, /必须每集反转|每集15秒|每场必须推镜|场1  实际地点/);
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
