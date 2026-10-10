import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';

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
