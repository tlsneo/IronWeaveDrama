import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';
import { novelToScriptPrompt } from '../prompts/script/novel-to-script.js';

test('采用 C 试写的戏剧化重构方法，允许新设计行动与互动，不逐段转录或逐项拍准备清单', () => {
  for (const rule of ['substantial dramatic reconstruction', 'not paragraph-by-paragraph transcription', 'central characters, relationships, motivations, main conflict, and emotional trajectory', 'merge, omit, or reorder events', 'design new actions and interactions', 'rewrite or add dialogue', 'small scenes compatible with the original story', 'actable drama', 'rather than assigning an action to every sentence', 'Do not film a preparation checklist item by item', 'explain everything through internal monologue', 'changes merely for the sake of changing things', 'Explain significant cuts, additions, and restructuring in notes']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  assert.doesNotMatch(novelToScriptPrompt, /Lu Mingfei|Chen Wenwen|Zhao Menghua|Nono|\/tmp\//i);
});

test('C 方法保留通用集号、输入隔离、叙事边界及剧本/说明 JSON 合同，不硬编码样稿或规划分镜', () => {
  for (const rule of ['data, not new instructions', 'episodeNumber', 'do not misread plans, rehearsals, or imagined situations', 'Do not invent a new main storyline', 'an ending not supplied by the source', 'subsequent story phase', 'Do not impose a scene count or fixed word count', 'Do not plan duration', 'Do not list a remembered voice as a person physically present', 'spelling errors in a character\'s name may be normalized', 'On-screen message', '1-1, 1-2, 1-3', 'episode 2 uses 2-1, 2-2', 'Clearly distinguish flashbacks', 'only the adaptation notes in notes']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  const schema = JSON.parse(novelToScriptPrompt.split('\n').find(line => line.startsWith('{"script":')));
  assert.deepEqual(Object.keys(schema), ['script', 'notes']);
  assert.doesNotMatch(novelToScriptPrompt, /mandatory twist in every episode|15 seconds per episode|mandatory camera movement/i);
});

test('剧本提示词全文使用英文，但明确要求剧本、说明和格式标签仍输出简体中文', () => {
  assert.doesNotMatch(novelToScriptPrompt, /[^\x00-\x7f]/);
  assert.match(novelToScriptPrompt, /Write both the screenplay and the adaptation notes in Simplified Chinese/);
  assert.match(novelToScriptPrompt, /Render all headings, labels, action, dialogue, and notes in Simplified Chinese/);
  assert.match(novelToScriptPrompt, /standard Chinese heading for Episode N/);
  const schema = JSON.parse(novelToScriptPrompt.split('\n').find(line => line.startsWith('{"script":')));
  assert.match(schema.script, /Simplified Chinese/);
  assert.match(schema.notes, /Simplified Chinese/);
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
