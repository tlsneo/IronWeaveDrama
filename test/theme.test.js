import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');

function loadTheme({ dark = false, saved = null, blocked = false } = {}) {
  const root = { dataset: {} };
  let ready = false;
  let onReady, onClick, onSystemChange;
  const button = { hidden: true, addEventListener: (event, callback) => { onClick = callback; } };
  const media = { matches: dark, addEventListener: (event, callback) => { onSystemChange = callback; } };
  runInNewContext(script, {
    window: { matchMedia: () => media },
    document: {
      documentElement: root,
      getElementById: () => ready ? button : null,
      addEventListener: (event, callback) => { onReady = callback; },
    },
    localStorage: {
      getItem: () => {
        if (blocked) throw new Error('Storage disabled');
        return saved;
      },
      setItem: (key, value) => {
        assert.equal(key, 'ironweave-theme');
        if (blocked) throw new Error('Storage disabled');
        saved = value;
      },
    },
  });
  const initialTheme = root.dataset.theme;
  ready = true;
  onReady();
  return {
    root, button, initialTheme,
    click: () => onClick(),
    systemChange: (dark) => { media.matches = dark; onSystemChange(); },
    get saved() { return saved; },
  };
}

test('无保存偏好时，在页面渲染前跟随系统，并响应系统变化', () => {
  const page = loadTheme({ dark: true });
  assert.equal(page.initialTheme, 'dark');
  assert.equal(page.button.hidden, false);
  assert.equal(page.button.textContent, '切换浅色');
  page.systemChange(false);
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.button.textContent, '切换深色');
});

test('手动切换可以往返，保存偏好并优先于系统，重新打开后仍生效', () => {
  const page = loadTheme();
  page.click();
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.saved, 'dark');
  page.systemChange(false);
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(loadTheme({ saved: page.saved }).initialTheme, 'dark');
  page.click();
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.saved, 'light');
  assert.equal(loadTheme({ dark: true, saved: page.saved }).initialTheme, 'light');
});

test('无效偏好退回系统；浏览器禁用存储时仍能手动切换', () => {
  assert.equal(loadTheme({ dark: true, saved: 'invalid' }).initialTheme, 'dark');
  const page = loadTheme({ dark: true, blocked: true });
  page.click();
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.button.textContent, '切换深色');
});
