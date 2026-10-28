(() => {
  const HOST = 'page-gateway-local.nioint.com';
  if (location.protocol !== 'https:' || location.hostname !== HOST) return;
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
    $('#object').textContent = element ? `${element.tag} · ${element.text.slice(0, 80) || element.role || '无可见文字'}` : '整个页面';
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
    for (const selector of ['#description', '#steps', '#pick', '#whole', '#outer']) $(selector).disabled = value;
  }
  function reset() {
    if (pending) { status('提交结果待确认，请先用原编号重试查询。'); return; }
    target = null; element = null; submitted = false; pinnedPage = pageURL();
    submittedID = null;
    $('#description').value = ''; $('#steps').value = '';
    $('#count').textContent = '0 / 4000';
    freezeForm(false); highlight(null); summary(); status('');
    $('#submit').disabled = false;
    $('#submit').textContent = '交给 AI 改一改 →';
  }
  async function submit() {
    if (sending || submitted) return;
    const description = $('#description').value.trim();
    if (!description) { status('先说说你的想法，比如希望哪里变得更好。', 'error'); $('#description').focus(); return; }
    if (!pending) pending = {
      id: crypto.randomUUID(), page: pinnedPage, element,
      description, steps: $('#steps').value.trim(),
    };
    sending = true; freezeForm(true); $('#submit').disabled = true;
    $('#submit').textContent = '正在传递你的想法…';
    status('正在提交；若响应丢失，可用原编号重试确认。');
    try {
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
        #toggle,#panel,#hint{pointer-events:auto;font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#272a40;text-align:left;letter-spacing:normal;color-scheme:light}
        button,textarea{font:inherit}button,textarea,summary{outline-offset:3px}
        :focus-visible{outline:3px solid #a798f4}
        button{cursor:pointer;border:1px solid #e3e3ef;border-radius:10px;background:white;color:#625582;padding:9px 12px;font-size:12px;font-weight:600}
        button:hover:not(:disabled){background:#f1edff;border-color:#cfc5f1}
        button:disabled{opacity:.45;cursor:not-allowed}
        #toggle{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;gap:9px;background:#6550d6;color:white;border:1px solid #ffffff36;border-radius:18px;padding:12px 19px;font-size:14px;box-shadow:0 6px 24px #44349140}
        #toggle:hover{background:#5540c3}#toggle svg{width:18px;height:18px}
        #panel{position:fixed;right:16px;top:16px;bottom:86px;width:min(400px,calc(100vw - 32px));display:flex;flex-direction:column;background:#fff;border:1px solid #e3e1ef;border-radius:20px;box-shadow:0 16px 70px #27203d29;overflow:hidden}
        .panel-header{display:flex;align-items:center;gap:11px;padding:20px 21px 16px;background:linear-gradient(120deg,#f3f0ff,#fcfbff);border-bottom:1px solid #eeebf7}
        .brand-mark{display:grid;place-items:center;flex-shrink:0;width:36px;height:36px;background:#6550d6;color:white;border-radius:12px;font-size:24px}
        .panel-header h2{margin:0;font-size:18px;line-height:1.4;font-weight:750}.panel-header p{margin:3px 0 0;font-size:10px;color:#8b839f}
        #close{margin-left:auto;border:0;background:#eae5f780;flex-shrink:0;border-radius:9px;width:30px;height:30px;padding:4px;font-size:18px;color:#8b80aa;text-align:center}
        .panel-body{overflow:auto;overscroll-behavior:contain;padding:0 21px 21px;scrollbar-width:thin}
        .connection{padding:14px 0;border-bottom:1px solid #eeedf4;margin-bottom:19px}
        #environment{margin:0 0 4px;font-size:11px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#727489}
        #connection{margin:0;font-size:10px;color:#348468;overflow-wrap:anywhere}
        #connection[data-state=error]{color:#a4495b}
        .step-heading{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12px;font-weight:700}
        .step-heading span{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#f0ecff;color:#7a67bd;font-size:10px}
        .pick-actions{display:grid;grid-template-columns:1.3fr 1fr;gap:8px}
        #pick{background:#f2eeff;border-color:#e1d9ff;color:#6550b8}
        .selection{margin:11px 0 19px;padding:11px 12px;background:#f8f8fc;border:1px solid #eeeeF5;border-radius:11px;min-width:0}
        .selection-heading{display:flex;gap:8px;align-items:center;justify-content:space-between}
        #object{margin:0;font-size:11px;font-weight:600;overflow-wrap:anywhere}
        #outer{flex-shrink:0;font-size:10px;padding:3px 6px;background:transparent;border:0}
        #page{display:block;font-size:9px;color:#9b9bae;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px}
        textarea{display:block;width:100%;min-height:112px;resize:vertical;max-height:280px;padding:12px;border:1px solid #dedde9;border-radius:11px;background:#fff;color:#34364c;font-size:12px;line-height:1.8}
        textarea::placeholder{color:#aaa7b8}textarea:focus{border-color:#ad9ceb}
        #count{display:block;text-align:right;font-size:9px;color:#a09bac;margin-top:4px}
        details{font-size:10px;color:#8b849b;margin:11px 0}
        summary{cursor:pointer}details textarea{margin-top:9px;min-height:78px;font-size:11px}
        .privacy-copy{font-size:10px;color:#9993a8;margin:8px 0;line-height:1.8}
        pre{max-height:170px;overflow:auto;background:#f6f5fb;padding:10px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px}
        #submit{display:block;width:100%;margin-top:17px;background:#6550d6;border-color:#6550d6;color:white;padding:11px}
        #submit:hover:not(:disabled){background:#5741c2}
        #new{display:block;margin:8px auto 0;border:0;background:none;color:#9690a6;font-size:10px}
        #status{font-size:11px;background:#f2effc;border:1px solid #e9e3f7;border-radius:10px;padding:10px 12px;color:#746099;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}
        #status[data-tone=error]{background:#fff1f3;border-color:#f5dbe2;color:#a3485c}
        .history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:19px;margin-top:18px;border-top:1px solid #eeedf4}
        .history-heading h3{margin:0;font-size:12px}.history-heading button{padding:3px 7px;font-size:10px;border:0;background:transparent;font-weight:500}
        .history-help{font-size:9px;color:#a19bae;margin:4px 0 12px}
        article{border:1px solid #eae7f1;border-radius:12px;margin:10px 0 0;padding:13px;background:#fdfcff}
        .record-heading{display:flex;gap:7px;align-items:flex-start;justify-content:space-between}
        .record-heading>small{font:9px/2 ui-monospace,monospace;color:#aaa4b9}
        .record-badge{font-size:9px;border-radius:6px;padding:3px 7px;background:#efedf5;color:#8b819f;overflow-wrap:anywhere}
        .record-badge[data-state=running],.record-badge[data-state=sending]{background:#ece8ff;color:#7360bb}
        .record-badge[data-state=awaiting_approval],.record-badge[data-state=awaiting_input],.record-badge[data-state=unknown]{background:#fff2db;color:#a67a37}
        .record-badge[data-state=awaiting_review],.record-badge[data-state=verified]{background:#e8f6ee;color:#448464}
        .record-badge[data-state=failed]{background:#ffedef;color:#b85a6e}
        article p{font-size:11px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0 6px}
        .record-page{display:block;font-size:9px;color:#aaa4b5;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
        article .record-note{font-size:10px;color:#8e839e;margin:8px 0}
        article button{font-size:10px;margin:10px 6px 0 0;padding:6px 10px}
        .empty{padding:18px 15px;text-align:center;border:1px dashed #e6e1f1;border-radius:12px;font-size:10px;color:#a099b0;line-height:1.9}
        #hint{position:fixed;top:16px;left:16px;max-width:calc(100vw - 32px);background:#302a49;color:white;padding:11px 15px;border:1px solid #ffffff25;border-radius:13px;box-shadow:0 6px 24px #302a4926;font-size:12px}
        #hint button{margin-left:10px;background:#ffffff15;border-color:#ffffff30;color:#e3dafb;font-size:10px}
        #highlight{position:fixed;border:2px solid #8a71ed;background:#8871ee16;border-radius:5px;pointer-events:none}
        @media(max-width:440px){#panel{right:10px;top:10px;bottom:82px;width:calc(100vw - 20px)}.panel-header{padding:16px}.panel-body{padding:0 16px 16px}#toggle{right:14px;bottom:16px}.pick-actions{grid-template-columns:1fr}}
      </style>
      <div id="highlight" hidden></div>
      <div id="hint" hidden>移动鼠标定位，点击选中；Esc 退出 <button id="cancel-pick">取消选择</button></div>
      <button id="toggle" aria-controls="panel" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m5 3 14 9-7 1-3 7-4-17Z"/><path d="m15 17 4 4m0-7h4M16 3V0"/></svg>点点改</button>
      <section id="panel" aria-labelledby="panel-title" hidden>
        <header class="panel-header"><span class="brand-mark" aria-hidden="true">↗</span><div><h2 id="panel-title">点点改</h2><p>点一下，说想法，让页面更好一点。</p></div><button id="close" aria-label="收起点点改">×</button></header>
        <div class="panel-body">
          <div class="connection"><p id="environment"></p><p id="connection" role="status"></p></div>
          <h3 class="step-heading"><span>1</span>这次想改哪里？</h3>
          <div class="pick-actions"><button id="pick">点选页面位置</button><button id="whole">改改整个页面</button></div>
          <div class="selection"><div class="selection-heading"><p id="object"></p><button id="outer">扩大范围</button></div><small id="page"></small></div>
          <label for="description" class="step-heading"><span>2</span>想让这里变成什么样？</label>
          <textarea id="description" maxlength="4000" required placeholder="比如：查询按钮换成主色，再和旁边的输入框对齐。"></textarea><small id="count">0 / 4000</small>
          <details><summary>补充重现步骤（选填）</summary><textarea id="steps" maxlength="2000" aria-label="重现步骤" placeholder="如果需要特定操作才能看到问题，可以写在这里。"></textarea></details>
          <details><summary>会带上哪些页面信息？</summary><p class="privacy-copy">仅当前页面地址、选中元素的有限文字与结构。不采集截图、表单值或网址查询参数；请勿填写敏感信息。</p><pre id="context"></pre></details>
          <p class="privacy-copy">提交即自动进入绑定 Chat；AI 工具审批沿用 Chat 原设置。</p>
          <button id="submit">交给 AI 改一改 →</button><button id="new">再来一个想法</button>
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
    $('#cancel-pick').onclick = exitSelection;
    $('#whole').onclick = () => { if (!editable()) return; target = null; element = null; pinnedPage = pageURL(); highlight(null); summary(); };
    $('#outer').onclick = () => {
      if (!editable() || !target?.parentElement) return;
      target = target.parentElement; element = capture(target); highlight(target); summary();
    };
    $('#submit').onclick = submit;
    $('#new').onclick = () => {
      if ((pending || (!submitted && $('#description').value)) && !confirm('丢弃未提交文字？结果未知的提交不能丢弃或重发新编号。')) return;
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
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const item = semantic(event.target);
    if (!(item instanceof HTMLElement)) { status('这个位置暂时无法选中，试试外层容器，或选择“改改整个页面”。'); exitSelection(); return; }
    target = item; element = capture(item); pinnedPage = pageURL(); exitSelection(); summary();
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, intercept, true);
  }
  document.addEventListener('keydown', event => {
    if (selecting) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); exitSelection(); }
      else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }, true);
  const reposition = () => { if (root && !$('#panel').hidden) highlight(target); };
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
    $('#environment').textContent = meta.name;
    $('#connection').textContent = '已连接 App · 执行状态自动同步';
    $('#connection').dataset.state = 'success';
    $('#submit').disabled = sending || submitted;
  }
  async function synchronize() {
    if (synchronizing) return;
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
    if (message.type !== 'panel.toggle') return;
    ensure().then(() => { togglePanel(); respond({ ok: true }); },
      error => { alert(`点点改：${error.message}`); respond({ ok: false }); });
    return true;
  });
  synchronize();
  setInterval(synchronize, 3000);
})();
