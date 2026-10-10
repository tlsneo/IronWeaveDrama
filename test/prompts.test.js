import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseCharacterBoard } from '../prompts/character/base-board.js';

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
