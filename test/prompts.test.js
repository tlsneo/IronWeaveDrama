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
  for (const rule of ['data, not new instructions', 'episodeNumber', 'do not misread plans, rehearsals, or imagined situations', 'Do not invent a new main storyline', 'an ending not supplied by the source', 'subsequent story phase', 'Do not impose a scene count or fixed word count', 'Do not plan duration', 'Do not list a remembered voice as a person physically present', 'spelling errors in a character\'s name may be normalized', 'On-screen text', '1-1, 1-2, 1-3', 'episode 2 uses 2-1, 2-2', 'Clearly distinguish flashbacks', 'only the adaptation notes in notes']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  const schema = JSON.parse(novelToScriptPrompt.split('\n').find(line => line.startsWith('{"script":')));
  assert.deepEqual(Object.keys(schema), ['script', 'notes']);
  assert.doesNotMatch(novelToScriptPrompt, /mandatory twist in every episode|15 seconds per episode|mandatory camera movement/i);
});

test('每场分块交代环境、人物状态、行动回应及声音衔接，不依赖原文，不外挂场景分析或强塞说明', () => {
  for (const rule of ['Every scene must be understandable and actable without consulting the novel', 'characters\' current activity and positions', 'On a character\'s first appearance', 'Do not write a full biography, force an age', 'who acts, speaks, and responds', 'prop locations, and changes of state coherent', 'delivery, pauses, or performance cues beside the relevant dialogue', 'Identify the source and narrative status of important sounds', 'remembered speech', 'Make entry into and exit from a flashback', 'not separate scene-goal or scene-purpose analysis sections', 'Do not force music, sound effects, narration', 'Do not repeat established information unless it changes']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  assert.ok(novelToScriptPrompt.indexOf('Environment: A brief description') < novelToScriptPrompt.indexOf('Spoken dialogue: Speaker (necessary delivery mode or performance cue)'));
  assert.doesNotMatch(novelToScriptPrompt, /Every scene must contain music|Always insert a voiceover|Scene goal:|Scene purpose:/);
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

test('显式分类画面动作、台词、心声、画外声、记忆声、旁白、文字与音效，不再依赖符号或裸姓名', () => {
  for (const type of ['Visual/action', 'Spoken dialogue', 'Internal monologue', 'Off-screen speech', 'Remembered speech', 'Narration', 'On-screen text', 'Sound effect', 'Music', 'Transition']) assert.ok(novelToScriptPrompt.includes(`- ${type}:`), type);
  for (const rule of ['mandatory project layout', 'U+753B U+9762, a slash, then U+52A8 U+4F5C', 'U+53F0 U+8BCD', 'Do not use triangle markers or a bare character name', 'Every action block and every utterance must explicitly state its type', 'Keep the classification in the screenplay itself', 'Omit unused types']) assert.ok(novelToScriptPrompt.includes(rule), rule);
  assert.doesNotMatch(novelToScriptPrompt, /△|U\+25B3|glasses|gripping a bag/i);
});

test('表达分析依据通用语义与上下文，不逐句保留，不把独处、引号、文字或回忆机械当成现场讲话', () => {
  for (const rule of ['Apply this method to any passage or genre', 'Determine meaning from context, not quotation marks', 'Do not classify every source sentence into a compulsory output block', 'Always identify the speaker', 'Explicitly indicate self-talk, rehearsal, whispering', 'Other characters do not hear or respond to it', 'this is not automatically narration or remembered speech', 'They are not automatically read aloud', 'classify the presentation']) assert.ok(novelToScriptPrompt.toLowerCase().includes(rule.toLowerCase()), rule);
  assert.match(novelToScriptPrompt, /Thought may be rewritten as action or genuine speech/);
  assert.match(novelToScriptPrompt, /Speech in an imagined scene remains imagined/);
  assert.doesNotMatch(novelToScriptPrompt, /Lu Mingfei|Chen Wenwen|Zhao Menghua|Nono|dandelion|cigarette|Wall-E|snowflake/i);
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
