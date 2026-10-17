(() => {
  const active = new Map();
  const key = 'ironweave-pending-operations';
  function pending() { try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; } }
  function remember(url, value) { const all = pending(); if (value) all[url] = value; else delete all[url]; sessionStorage.setItem(key, JSON.stringify(all)); }
  function history(url) { return `${/^\/projects\/\d+/.exec(url)?.[0] || ''}/operations`; }
  function panel(url) {
    const box = document.createElement('aside'); box.setAttribute('role', 'status'); box.style.cssText = 'position:fixed;bottom:16px;right:16px;max-width:440px;padding:16px;background:Canvas;color:CanvasText;border:1px solid;z-index:1000';
    const status = document.createElement('p'), stop = document.createElement('button'), link = document.createElement('a');
    stop.textContent = '停止本次传输'; link.textContent = '历史 / 恢复 / 人工采用'; link.href = history(url);
    box.append(status, stop, link); document.body.append(box); return { box, status, stop };
  }
  async function request(url, options = {}) {
    if (active.has(url) || (pending()[url] && !url.endsWith('/recover'))) throw new Error('存在尚未核对的生成操作，请先在历史中恢复或解除防重锁；不会自动再次生成。');
    const controller = new AbortController(), ui = panel(url);
    active.set(url, controller); remember(url, { submittedAt: Date.now() });
    ui.status.textContent = '正在提交；提交未知时不自动重发。';
    ui.stop.onclick = () => controller.abort();
    try {
      const response = await fetch(url, { ...options, headers: { ...options.headers, Accept: 'application/x-ndjson' }, signal: controller.signal });
      if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) { remember(url, null); return response; }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', final;
      while (true) {
        const { value, done } = await reader.read(); text += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (text.length > 131072) throw new Error('进度响应超过控制缓冲上限。');
        let newline;
        while ((newline = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, newline); text = text.slice(newline + 1);
          if (line.length > 65536 || final) throw new Error('进度响应无效。');
          const event = JSON.parse(line);
          if (event.type === 'operation') remember(url, { operationId: event.operationId });
          else if (event.type === 'progress') {
            const p = event.event.progress;
            ui.status.textContent = `${event.event.state}${p ? ` · ${p.current}/${p.total} ${p.unit}` : ''}；停止或离页会中止当前传输，可交付后不重新推理。`;
          } else if (event.type === 'result' && Number.isSafeInteger(event.status)) final = event;
          else throw new Error('未知进度事件。');
        }
        if (done) break;
      }
      if (!final || text) throw new Error('未收到完整最终业务结果，请在历史核对。');
      if (final.status < 400) remember(url, null);
      ui.status.textContent = final.result.message || final.result.error || '接收结束；请在历史核对交付状态并人工采用。';
      return { ok: final.status >= 200 && final.status < 300, status: final.status, json: async () => final.result };
    } catch (error) {
      controller.abort(); ui.status.textContent = '传输已停止或结果未确认；请恢复同一操作，不要重复生成。'; throw error;
    } finally { active.delete(url); ui.stop.remove(); }
  }
  window.addEventListener('pagehide', () => { for (const controller of active.values()) controller.abort(); });
  const old = pending();
  if (Object.keys(old).length) {
    const url = Object.keys(old)[0], ui = panel(url); ui.stop.textContent = '我已在历史核对，清除浏览器提醒';
    ui.status.textContent = '有未确认操作。返回页面不会自动生成，请先在历史恢复 / 核对。';
    ui.stop.onclick = () => { if (window.confirm('仅清除本浏览器提醒，不等于远端已取消；确认已在操作历史核对？')) { for (const u of Object.keys(old)) remember(u, null); ui.box.remove(); } };
  }
  window.IronGeneration = { request };
})();
