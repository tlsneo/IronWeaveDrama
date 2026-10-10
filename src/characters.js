export const characterFields = [
  { key: 'name', column: 'name', label: '角色名称', group: '基本信息', max: 80 },
  { key: 'age', column: 'age', label: '年龄', group: '基本信息', type: 'number' },
  { key: 'genderPresentation', column: 'gender_presentation', label: '性别／外形呈现', group: '基本信息', max: 80 },
  { key: 'skinTone', column: 'skin_tone', label: '肤色', group: '面部与头发', max: 120 },
  { key: 'faceFeatures', column: 'face_features', label: '脸型与五官', group: '面部与头发', max: 600, multiline: true },
  { key: 'hairStyle', column: 'hair_style', label: '发型', group: '面部与头发', max: 200 },
  { key: 'hairColor', column: 'hair_color', label: '发色', group: '面部与头发', max: 80 },
  { key: 'height', column: 'height', label: '身高', group: '身体', max: 80 },
  { key: 'bodyBuild', column: 'body_build', label: '体型', group: '身体', max: 200 },
  { key: 'bodyProportions', column: 'body_proportions', label: '身体比例', group: '身体', max: 300 },
  { key: 'identityFeatures', column: 'identity_features', label: '显著身份特征', group: '身份识别', max: 600, multiline: true },
  { key: 'appearanceNotes', column: 'appearance_notes', label: '外观补充', group: '身份识别', max: 1000, multiline: true },
];

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function findCharacter(database, projectId, id) {
  const character = database.prepare('SELECT * FROM characters WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!character) reject(404, '角色不存在');
  return character;
}

export function saveCharacter(database, projectId, id, form) {
  if (!database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) reject(404, '短剧项目不存在');
  if (id) findCharacter(database, projectId, id);
  const fields = id ? characterFields : characterFields.slice(0, 1);
  const values = fields.map(field => {
    if (form.getAll(field.key).length !== 1) reject(400, '角色资料不完整或字段重复，请刷新后重试。');
    const value = form.get(field.key).trim();
    if (field.type === 'number') {
      if (!value) return null;
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) reject(400, '年龄必须为非负整数，也可以留空。');
      return number;
    }
    if ((field.key === 'name' && !value) || value.length > field.max) reject(400, `${field.label}${field.key === 'name' ? '不能为空，且' : ''}最多 ${field.max} 字。`);
    return value;
  });
  if (id) {
    database.prepare(`UPDATE characters SET ${fields.map(field => `${field.column} = ?`).join(', ')} WHERE id = ? AND project_id = ?`).run(...values, id, projectId);
  } else {
    id = Number(database.prepare('INSERT INTO characters (project_id, name) VALUES (?, ?)').run(projectId, values[0]).lastInsertRowid);
  }
  const redirect = `/projects/${projectId}?resource=characters${fields.length > 1 ? `&character=${id}` : ''}`;
  return { id, name: values[0], redirect };
}
