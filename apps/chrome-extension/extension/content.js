(() => {
  if (!['http:', 'https:'].includes(location.protocol) || globalThis.__termrelayFeedbackLoaded) return;
  globalThis.__termrelayFeedbackLoaded = true;
  const pageURL = () => `${location.origin}${location.pathname}`;
  const labels = {
    pending: '已排队，等待 Chat 空闲', sending: 'App 正在启动修改', running: 'AI 正在修改',
    awaiting_approval: '等待 Chat 工具审批', awaiting_input: '等待 Chat 问题回复',
    delivered: '已送达会话，等待开发者核实',
    unknown: '执行结果未知，等待核实', failed: '执行失败',
    awaiting_review: '本轮修改完成，刷新看看效果', verified: '效果已确认', changes_requested: '已记录调整意见',
  };
  let host, root, target, element = null, selecting = false;
  let pinnedPage = pageURL(), pending = null, submitted = false, sending = false;
  let submittedID = null;
  let synchronizing = false;
  let screenshot = null, screenshotSupported = false, screenshotSelecting = false, capturing = false, drag = null;
  let openedScreenshot = null, openedScreenshotID = null;
  const $ = selector => root.querySelector(selector);
  function node(tag, value) { const result = document.createElement(tag); result.textContent = value; return result; }
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '点点改服务未响应，请检查 App 连接。');
    return result.data;
  }
  function status(message, tone = 'info') {
    $('#status').textContent = message;
    $('#status').hidden = !message;
    $('#status').dataset.tone = tone;
  }
  function semantic(item) {
    return item?.closest('button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]') || item;
  }
  function safeText(item) {
    if (item.closest('input,textarea,select,[contenteditable],script,style,[hidden]')) return '';
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let text = '', current;
    while ((current = walker.nextNode()) && text.length < 500) {
      const parent = current.parentElement;
      if (!parent || parent.closest('input,textarea,select,[contenteditable],script,style,[hidden]') || !parent.getClientRects().length) continue;
      text += ` ${current.textContent}`;
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  function capture(item) {
    const chain = [];
    for (let cursor = item; cursor && chain.length < 8; cursor = cursor.parentElement) {
      const siblings = cursor.parentElement ? [...cursor.parentElement.children].filter(other => other.localName === cursor.localName) : [cursor];
      chain.unshift(`${cursor.localName}:nth-of-type(${siblings.indexOf(cursor) + 1})`);
    }
    return {
      tag: item.localName.slice(0, 32), role: (item.getAttribute('role') || '').slice(0, 64),
      text: safeText(item), locator: chain.join(' > ').slice(0, 512),
      ancestors: chain.join(' > ').slice(0, 1024),
    };
  }
  function highlight(item) {
    const box = $('#highlight');
    if (!item?.isConnected) { box.hidden = true; return; }
    const rect = item.getBoundingClientRect();
    box.hidden = false;
    Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function summary() {
    $('#object').textContent = screenshot ? '截图区域' : element ? `${element.tag} · ${element.text.slice(0, 80) || element.role || '无可见文字'}` : '整个页面';
    $('#page').textContent = pinnedPage;
    $('#page').title = pinnedPage;
    $('#context').textContent = JSON.stringify({ page: pinnedPage, element }, null, 2);
    $('#outer').disabled = !target?.parentElement || submitted || !!pending;
  }
  function exitSelection() {
    selecting = false;
    $('#hint').hidden = true; $('#panel').hidden = false;
    $('#toggle').setAttribute('aria-expanded', 'true');
    highlight(target);
  }
  function togglePanel() {
    if (selecting) { exitSelection(); return; }
    $('#panel').hidden = !$('#panel').hidden;
    $('#toggle').setAttribute('aria-expanded', String(!$('#panel').hidden));
    highlight($('#panel').hidden ? null : target);
  }
  function editable() {
    if (capturing || screenshotSelecting) return false;
    if (sending || pending) { status('先确认当前提交结果；不要修改后用同一编号重试。'); return false; }
    if (submitted) { status('这个想法已经提交，点击“再来一个想法”就能继续。'); return false; }
    return true;
  }
  function selectMode() {
    if (!editable()) return;
    selecting = true;
    $('#hint').hidden = false; $('#panel').hidden = true;
    $('#toggle').setAttribute('aria-expanded', 'false');
  }
  function freezeForm(value) {
    for (const selector of ['#description', '#steps', '#pick', '#whole', '#outer', '#screenshot', '#remove-screenshot', '#screenshot-consent']) $(selector).disabled = value;
    $('#screenshot').disabled = value || !screenshotSupported;
  }
  function showScreenshot(value) {
    screenshot = value;
    $('#screenshot-preview').hidden = !value;
    $('#screenshot-image').src = value?.dataURL || '';
    $('#screenshot-size').textContent = value ? `${value.width} × ${value.height}` : '';
    $('#screenshot-consent').checked = false;
    summary();
  }
  function viewScreenshot(value) {
    $('#viewer-image').src = value.dataURL;
    if (!$('#image-viewer').open) $('#image-viewer').showModal();
  }
  function finishScreenshotSelection() {
    screenshotSelecting = false; drag = null;
    $('#screenshot-overlay').hidden = true;
    $('#panel').hidden = false;
    $('#toggle').setAttribute('aria-expanded', 'true');
  }
  function beginScreenshot() {
    if (!editable()) return false;
    if (!screenshotSupported) { status('当前 AI 会话不支持图片输入，请联系开发者更换会话。', 'error'); return false; }
    if (selecting) exitSelection();
    screenshotSelecting = true;
    $('#panel').hidden = true; $('#highlight').hidden = true;
    $('#toggle').setAttribute('aria-expanded', 'false');
    $('#screenshot-overlay').hidden = false;
    $('#screenshot-region').hidden = true;
    $('#cancel-screenshot').focus();
    return true;
  }
  async function captureScreenshot(rect) {
    const viewport = { width: innerWidth, height: innerHeight };
    const locationBefore = location.href, scrollBefore = { x: scrollX, y: scrollY };
    finishScreenshotSelection();
    capturing = true; freezeForm(true); $('#submit').disabled = true;
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const image = await send({ type: 'screenshot.capture', rect, viewport });
      if (location.href !== locationBefore || scrollX !== scrollBefore.x || scrollY !== scrollBefore.y
        || innerWidth !== viewport.width || innerHeight !== viewport.height) throw new Error('页面或窗口已变化，请重新截图。');
      target = null; element = null; pinnedPage = pageURL(); highlight(null); summary();
      showScreenshot(image);
      status('截图已准备，确认图片内容后填写修改建议。');
    } catch (error) { status(error.message, 'error'); }
    finally {
      host.style.removeProperty('visibility');
      capturing = false; freezeForm(false); $('#submit').disabled = submitted;
      $('#description').focus();
    }
  }
  function reset() {
    if (pending) { status('提交结果待确认，请先用原编号重试查询。'); return; }
    target = null; element = null; submitted = false; pinnedPage = pageURL();
    submittedID = null;
    $('#description').value = ''; $('#steps').value = '';
    $('#count').textContent = '0 / 4000';
    showScreenshot(null);
    freezeForm(false); highlight(null); summary(); status('');
    $('#submit').disabled = false;
    $('#submit').textContent = '交给 AI 改一改';
  }
  async function submit() {
    if (sending || submitted) return;
    const description = $('#description').value.trim();
    if (!description) { status('先说说你的想法，比如希望哪里变得更好。', 'error'); $('#description').focus(); return; }
    if (capturing || screenshotSelecting) return;
    if (screenshot && !$('#screenshot-consent').checked) { status('请先确认截图内容可以发送给 AI。', 'error'); $('#screenshot-consent').focus(); return; }
    const draft = {
      page: pinnedPage, element,
      description, steps: $('#steps').value.trim(),
      ...(screenshot ? { screenshot } : {}),
    };
    sending = true; freezeForm(true); $('#submit').disabled = true;
    $('#submit').textContent = '正在传递你的想法…';
    status('正在提交；若响应丢失，可用原编号重试确认。');
    try {
      if (!pending) pending = { ...draft, id: await send({ type: 'feedback.id' }) };
      const record = await send({ type: 'feedback.create', feedback: pending });
      pending = null; submitted = true;
      submittedID = record.id;
      status(`已提交 ${record.id.slice(0, 8)}，已排队自动执行；AI 工具审批遵循 Chat 原设置。`);
      await list();
    } catch (error) {
      status(`提交未确认：${error.message}。草稿已保留，点击“确认上次提交”使用原编号查询，不会重复创建。`, 'error');
    } finally {
      sending = false; $('#submit').disabled = submitted;
      $('#submit').textContent = submitted ? '已提交，进度见下方' : '确认上次提交';
      if (!$('#panel').hidden) $('#status').scrollIntoView({ block: 'nearest' });
    }
  }
  async function list() {
    try {
      const records = await send({ type: 'feedback.list' });
      const current = records.find(record => record.id === submittedID);
      if (current) status(`已提交 ${current.id.slice(0, 8)} · ${labels[current.status] || current.status}${current.note ? `：${current.note}` : ''}`);
      $('#records').replaceChildren();
      for (const record of records.slice(0, 100)) {
        const card = node('article', '');
        const heading = node('div', ''), badge = node('span', labels[record.status] || record.status);
        heading.className = 'record-heading'; badge.className = 'record-badge'; badge.dataset.state = record.status;
        heading.append(badge, node('small', record.id.slice(0, 8)));
        const page = node('small', record.page); page.className = 'record-page'; page.title = record.page;
        card.append(heading, node('p', record.description), page);
        if (record.screenshot) {
          const button = node('button', `查看截图 · ${record.screenshot.width} × ${record.screenshot.height}`);
          button.onclick = async () => {
            button.disabled = true;
            try {
              if (openedScreenshotID !== record.id) {
                openedScreenshot = await send({ type: 'feedback.screenshot', id: record.id });
                openedScreenshotID = record.id;
              }
              viewScreenshot(openedScreenshot);
            } catch (error) { status(error.message, 'error'); }
            finally { button.disabled = false; }
          };
          card.append(button);
        }
        if (record.note) { const note = node('p', record.note); note.className = 'record-note'; card.append(note); }
        if (record.status === 'awaiting_review') {
          for (const [label, next] of [['效果满意', 'verified'], ['再调一调', 'changes_requested']]) {
            const button = node('button', label);
            button.onclick = async () => {
              const note = next === 'changes_requested' ? prompt('还有哪里想调整？会保存你的补充意见，不会自动启动新一轮修改：') : '';
              if (note === null || (next === 'changes_requested' && !note.trim())) return;
              button.disabled = true;
              try { await send({ type: 'feedback.verify', id: record.id, status: next, note }); await list(); }
              catch (error) { status(error.message, 'error'); button.disabled = false; }
            };
            card.append(button);
          }
        }
        $('#records').append(card);
      }
      if (!records.length) {
        const empty = node('p', '还没有小想法。点选一个位置，说说你想怎么改。');
        empty.className = 'empty'; $('#records').append(empty);
      }
    } catch (error) { status(error.message, 'error'); }
  }
  function mount(meta) {
    host = document.createElement('termrelay-feedback');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;inset:0!important;pointer-events:none!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box}[hidden]{display:none!important}
        #toggle,#panel,#hint,#screenshot-overlay,#image-viewer{pointer-events:auto;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;text-align:left;letter-spacing:0;color-scheme:light}
        button,textarea{font:inherit}button,textarea,summary{outline-offset:3px}
        :focus-visible{outline:2px solid #555}
        button{cursor:pointer;border:1px solid #ccc;border-radius:4px;background:white;color:#333;padding:7px 10px;font-size:13px}
        button:hover:not(:disabled){background:#f5f5f5}
        button:disabled{opacity:.45;cursor:not-allowed}
        #toggle{position:fixed;right:20px;bottom:20px;background:#292929;color:white;border-color:#292929;padding:9px 16px;font-size:13px}
        #toggle:hover{background:#444}
        #panel{position:fixed;right:16px;top:16px;bottom:76px;width:min(380px,calc(100vw - 32px));display:flex;flex-direction:column;background:#fff;border:1px solid #ccc;border-radius:6px;overflow:hidden}
        .panel-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e5e5}
        .panel-header h2{margin:0;font-size:15px;font-weight:600}
        #close{border:0;padding:3px 6px;font-size:12px;color:#666}
        .panel-body{overflow:auto;overscroll-behavior:contain;padding:0 16px 16px;scrollbar-width:thin}
        .connection{padding:12px 0;border-bottom:1px solid #e5e5e5;margin-bottom:16px}
        #environment{margin:0 0 4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555}
        #connection{margin:0;font-size:12px;color:#666;overflow-wrap:anywhere}
        #connection[data-state=error]{color:#a12727}
        .step-heading{display:block;margin:0 0 8px;font-size:13px;font-weight:600}
        .pick-actions{display:flex;gap:8px;flex-wrap:wrap}
        .selection{margin:10px 0 16px;min-width:0}
        .selection-heading{display:flex;gap:8px;align-items:center;justify-content:space-between}
        #object{margin:0;font-size:12px;overflow-wrap:anywhere}
        #outer{flex-shrink:0;font-size:12px;padding:3px 0;border:0}
        #page{display:block;font-size:11px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
        textarea{display:block;width:100%;min-height:96px;resize:vertical;max-height:280px;padding:9px 10px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#222;font-size:13px;line-height:1.6}
        textarea::placeholder{color:#888}
        #count{display:block;text-align:right;font-size:11px;color:#777;margin-top:4px}
        details{font-size:12px;color:#666;margin:10px 0}
        summary{cursor:pointer}details textarea{margin-top:8px;min-height:78px}
        .privacy-copy{font-size:11px;color:#666;margin:8px 0}
        pre{max-height:170px;overflow:auto;background:#f7f7f7;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
        .submit-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
        #submit{background:#292929;border-color:#292929;color:white}
        #submit:hover:not(:disabled){background:#444}
        #status{font-size:12px;border-left:2px solid #ccc;padding:4px 10px;color:#555;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}
        #status[data-tone=error]{border-color:#a12727;color:#a12727}
        .history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:16px;margin-top:16px;border-top:1px solid #e5e5e5}
        .history-heading h3{margin:0;font-size:13px;font-weight:600}.history-heading button{padding:3px 0;font-size:12px;border:0}
        .history-help{font-size:11px;color:#777;margin:4px 0 12px}
        article{border-top:1px solid #eee;margin:12px 0 0;padding:12px 0 0}
        .record-heading{display:flex;gap:7px;align-items:flex-start;justify-content:space-between}
        .record-heading>small{font:11px/1.6 ui-monospace,monospace;color:#777}
        .record-badge{font-size:12px;color:#555;overflow-wrap:anywhere}
        .record-badge[data-state=failed],.record-badge[data-state=unknown]{color:#a12727}
        article p{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 6px}
        .record-page{display:block;font-size:11px;color:#777;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
        article .record-note{font-size:12px;color:#666;margin:8px 0}
        article button{font-size:12px;margin:8px 6px 0 0}
        .empty{font-size:12px;color:#777;margin:12px 0 0}
        #hint{position:fixed;top:16px;left:16px;max-width:calc(100vw - 32px);background:#fff;padding:10px 12px;border:1px solid #ccc;border-radius:4px}
        #hint button{margin-left:8px;font-size:12px}
        #highlight{position:fixed;border:2px solid #444;background:#00000008;pointer-events:none}
        #screenshot-overlay{position:fixed;inset:0;z-index:3;cursor:crosshair;touch-action:none;background:#0002;overflow:hidden}
        #screenshot-toolbar{position:absolute;top:16px;left:16px;display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #ccc;padding:8px 12px;border-radius:4px}
        #screenshot-region{position:absolute;border:2px solid #21764d;background:#ffffff20;pointer-events:none;box-shadow:0 0 0 30000px #0003}
        #screenshot-preview{margin:0 0 16px}
        #screenshot-expand{display:block;width:100%;padding:0;overflow:hidden;background:#f5f5f5}
        #screenshot-image{display:block;width:100%;height:auto;max-height:200px;object-fit:contain}
        .screenshot-actions{display:flex;align-items:center;justify-content:space-between;margin-top:5px;font-size:11px;color:#666}
        #remove-screenshot{border:0;padding:2px 0;font-size:12px}
        .screenshot-consent{display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:11px;color:#666}
        .screenshot-consent input{flex-shrink:0;margin-top:4px}
        #image-viewer{max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);padding:12px;border:1px solid #ccc;border-radius:6px;background:#fff;overflow:auto}
        #image-viewer::backdrop{background:#0007}
        #viewer-image{display:block;max-width:100%;max-height:calc(100vh - 110px);object-fit:contain;margin-top:8px}
        @media(max-width:440px){#panel{right:10px;top:10px;bottom:70px;width:calc(100vw - 20px)}#toggle{right:14px;bottom:14px}}
      </style>
      <div id="highlight" hidden></div>
      <div id="hint" hidden>移动鼠标定位，点击选中；Esc 退出 <button id="cancel-pick">取消选择</button></div>
      <div id="screenshot-overlay" hidden><div id="screenshot-region" hidden></div><div id="screenshot-toolbar"><span>框选截图区域</span><button id="cancel-screenshot">取消</button></div></div>
      <dialog id="image-viewer" aria-label="反馈截图"><button id="close-viewer">关闭</button><img id="viewer-image" alt="反馈截图"></dialog>
      <button id="toggle" aria-controls="panel" aria-expanded="false">点点改</button>
      <section id="panel" aria-labelledby="panel-title" hidden>
        <header class="panel-header"><h2 id="panel-title">点点改</h2><button id="close" aria-label="收起点点改">收起</button></header>
        <div class="panel-body">
          <div class="connection"><p id="environment"></p><p id="connection" role="status"></p></div>
          <h3 class="step-heading">修改范围</h3>
          <div class="pick-actions"><button id="pick">点选页面位置</button><button id="whole">改改整个页面</button><button id="screenshot" disabled>框选截图</button></div>
          <div class="selection"><div class="selection-heading"><p id="object"></p><button id="outer">扩大范围</button></div><small id="page"></small></div>
          <div id="screenshot-preview" hidden><button id="screenshot-expand" title="查看截图"><img id="screenshot-image" alt="待提交截图"></button><div class="screenshot-actions"><span id="screenshot-size"></span><button id="remove-screenshot">移除截图</button></div><label class="screenshot-consent"><input id="screenshot-consent" type="checkbox"><span>我确认图片可发送给绑定 AI，已检查其中的表单、账号及其他敏感内容。</span></label></div>
          <label for="description" class="step-heading">修改描述</label>
          <textarea id="description" maxlength="4000" required placeholder="比如：查询按钮换成主色，再和旁边的输入框对齐。"></textarea><small id="count">0 / 4000</small>
          <details><summary>补充重现步骤（选填）</summary><textarea id="steps" maxlength="2000" aria-label="重现步骤" placeholder="如果需要特定操作才能看到问题，可以写在这里。"></textarea></details>
          <details><summary>会带上哪些页面信息？</summary><p class="privacy-copy">当前页面地址、选中元素的有限文字与结构，以及你明确添加的局部截图。截图可能包含可见的表单和账号信息，确认后随建议发送给绑定 AI；不自动采集图片或网址查询参数。</p><pre id="context"></pre></details>
          <p class="privacy-copy">提交即自动进入绑定 Chat；AI 工具审批沿用 Chat 原设置。</p>
          <div class="submit-actions"><button id="submit">交给 AI 改一改</button><button id="new">再来一个想法</button></div>
          <p id="status" role="status" aria-live="polite" hidden></p>
          <div class="history-heading"><h3>改动进度</h3><button id="list">刷新进度</button></div>
          <p class="history-help">本预览端口的记录共享可见 · 进度自动更新</p>
          <div id="records"></div>
        </div>
      </section>`;
    document.documentElement.append(host);
    $('#environment').textContent = meta.name;
    $('#toggle').onclick = togglePanel;
    $('#close').onclick = () => { $('#panel').hidden = true; $('#toggle').setAttribute('aria-expanded', 'false'); highlight(null); $('#toggle').focus(); };
    $('#description').oninput = () => { $('#count').textContent = `${$('#description').value.length} / 4000`; };
    $('#pick').onclick = selectMode;
    $('#screenshot').onclick = beginScreenshot;
    $('#remove-screenshot').onclick = () => { if (editable()) showScreenshot(null); };
    $('#screenshot-expand').onclick = () => { if (screenshot) viewScreenshot(screenshot); };
    $('#close-viewer').onclick = () => $('#image-viewer').close();
    $('#cancel-screenshot').onclick = event => { event.stopPropagation(); finishScreenshotSelection(); $('#screenshot').focus(); };
    const overlay = $('#screenshot-overlay');
    overlay.onpointerdown = event => {
      if (event.button !== 0 || event.target.closest('#screenshot-toolbar')) return;
      event.preventDefault(); event.stopPropagation();
      drag = { x: event.clientX, y: event.clientY };
      overlay.setPointerCapture(event.pointerId);
      $('#screenshot-region').hidden = true;
    };
    overlay.onpointermove = event => {
      if (!drag) return;
      event.preventDefault(); event.stopPropagation();
      const endX = Math.max(0, Math.min(innerWidth, event.clientX)), endY = Math.max(0, Math.min(innerHeight, event.clientY));
      const region = $('#screenshot-region'); region.hidden = false;
      Object.assign(region.style, { left: `${Math.min(drag.x, endX)}px`, top: `${Math.min(drag.y, endY)}px`, width: `${Math.abs(endX - drag.x)}px`, height: `${Math.abs(endY - drag.y)}px` });
    };
    overlay.onpointerup = event => {
      if (!drag) return;
      event.preventDefault(); event.stopPropagation();
      const endX = Math.max(0, Math.min(innerWidth, event.clientX)), endY = Math.max(0, Math.min(innerHeight, event.clientY));
      const rect = { x: Math.min(drag.x, endX), y: Math.min(drag.y, endY), width: Math.abs(endX - drag.x), height: Math.abs(endY - drag.y) };
      overlay.releasePointerCapture(event.pointerId);
      if (rect.width < 8 || rect.height < 8) { drag = null; $('#screenshot-region').hidden = true; return; }
      captureScreenshot(rect);
    };
    overlay.onpointercancel = () => finishScreenshotSelection();
    overlay.onclick = event => { event.preventDefault(); event.stopPropagation(); };
    overlay.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
    $('#cancel-pick').onclick = exitSelection;
    $('#whole').onclick = () => { if (!editable()) return; target = null; element = null; pinnedPage = pageURL(); showScreenshot(null); highlight(null); summary(); };
    $('#outer').onclick = () => {
      if (!editable() || !target?.parentElement) return;
      target = target.parentElement; element = capture(target); highlight(target); summary();
    };
    $('#submit').onclick = submit;
    $('#new').onclick = () => {
      if (!editable() && !submitted) return;
      if ((pending || (!submitted && ($('#description').value || screenshot))) && !confirm('丢弃未提交内容？结果未知的提交不能丢弃或重发新编号。')) return;
      reset();
    };
    $('#list').onclick = list;
    summary();
  }
  document.addEventListener('pointermove', event => {
    if (!selecting || event.composedPath().includes(host)) return;
    highlight(semantic(event.target));
  }, true);
  const intercept = event => {
    if ((screenshotSelecting || capturing) && !event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const item = semantic(event.target);
    if (!(item instanceof HTMLElement)) { status('这个位置暂时无法选中，试试外层容器，或选择“改改整个页面”。'); exitSelection(); return; }
    target = item; element = capture(item); pinnedPage = pageURL(); showScreenshot(null); exitSelection(); summary();
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, intercept, true);
  }
  document.addEventListener('keydown', event => {
    if (screenshotSelecting) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finishScreenshotSelection(); $('#screenshot').focus(); }
      else if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (selecting) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); exitSelection(); }
      else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }, true);
  const reposition = () => { if (screenshotSelecting) finishScreenshotSelection(); if (root && !$('#panel').hidden) highlight(target); };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  setInterval(() => {
    if (!root || $('#panel').hidden) return;
    if (target && !target.isConnected) { highlight(null); status('原元素已变化，保留原摘要；可以重新选择。'); }
    else if (!submitted && pinnedPage !== pageURL()) status('页面已变化，草稿仍关联原页面；重新点选位置或选择“改改整个页面”可更新范围。');
  }, 1000);
  async function ensure() {
    const meta = await send({ type: 'preview.meta' });
    if (!root) mount(meta);
    screenshotSupported = meta.screenshotSupported === true;
    $('#screenshot').disabled = !screenshotSupported || sending || !!pending || submitted || capturing;
    $('#screenshot').title = screenshotSupported ? '截取当前可见页面的指定区域' : '当前 AI 会话未宣告图片输入能力';
    $('#environment').textContent = meta.name;
    $('#connection').textContent = '已连接 App · 执行状态自动同步';
    $('#connection').dataset.state = 'success';
    $('#submit').disabled = sending || submitted || capturing;
  }
  async function synchronize() {
    if (synchronizing || capturing || screenshotSelecting) return;
    synchronizing = true;
    try { await ensure(); await list(); }
    catch (error) {
      if (!root) mount({ name: 'TermRelay 本机预览' });
      $('#connection').textContent = `App 未连接：${error.message}`;
      $('#connection').dataset.state = 'error';
      $('#submit').disabled = true;
    } finally { synchronizing = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['panel.toggle', 'screenshot.select'].includes(message.type)) return;
    ensure().then(() => {
      if (message.type === 'screenshot.select') {
        const selected = beginScreenshot();
        respond({ ok: selected, error: selected ? undefined : '当前有未确认的反馈或会话不支持图片，请先处理。' });
      } else { togglePanel(); respond({ ok: true }); }
    },
      error => { alert(`点点改：${error.message}`); respond({ ok: false }); });
    return true;
  });
  synchronize();
  setInterval(synchronize, 3000);
})();
