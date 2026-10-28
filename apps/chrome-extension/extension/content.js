(() => {
  const HOST = 'page-gateway-local.nioint.com';
  if (location.protocol !== 'https:' || location.hostname !== HOST) return;
  const pageURL = () => `${location.origin}${location.pathname}`;
  const labels = {
    pending: '待处理', sending: '发送中', delivered: '已送达会话，等待开发者核实',
    unknown: '执行结果未知，等待核实', failed: '执行失败',
    awaiting_review: '待验收', verified: '已验收', changes_requested: '需继续修改',
  };
  let host, root, target, element = null, selecting = false;
  let pinnedPage = pageURL(), pending = null, submitted = false, sending = false;
  let authorized = false;
  const $ = selector => root.querySelector(selector);
  function node(tag, value) { const result = document.createElement(tag); result.textContent = value; return result; }
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '反馈服务未响应。');
    return result.data;
  }
  function status(message) { $('#status').textContent = message; }
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
    $('#context').textContent = JSON.stringify({ page: pinnedPage, element }, null, 2);
    $('#outer').disabled = !target?.parentElement || submitted || !!pending;
  }
  function exitSelection() {
    selecting = false;
    $('#hint').hidden = true; $('#panel').hidden = false;
    highlight(target);
  }
  function editable() {
    if (sending || pending) { status('先确认当前提交结果；不要修改后用同一编号重试。'); return false; }
    if (submitted) { status('请点击“继续反馈”新建反馈。'); return false; }
    return true;
  }
  function selectMode() {
    if (!editable()) return;
    selecting = true;
    $('#hint').hidden = false; $('#panel').hidden = true;
  }
  function freezeForm(value) {
    for (const selector of ['#description', '#steps', '#pick', '#whole', '#outer']) $(selector).disabled = value;
  }
  function reset() {
    if (pending) { status('提交结果待确认，请先用原编号重试查询。'); return; }
    target = null; element = null; submitted = false; pinnedPage = pageURL();
    $('#description').value = ''; $('#steps').value = '';
    freezeForm(false); highlight(null); summary(); status('');
    $('#submit').disabled = false;
  }
  async function submit() {
    if (sending || submitted) return;
    const description = $('#description').value.trim();
    if (!description) { status('请填写希望怎么改。'); return; }
    if (!pending) pending = {
      id: crypto.randomUUID(), page: pinnedPage, element,
      description, steps: $('#steps').value.trim(),
    };
    sending = true; freezeForm(true); $('#submit').disabled = true;
    status('正在提交；若响应丢失，可用原编号重试确认。');
    try {
      const record = await send({ type: 'feedback.create', feedback: pending });
      pending = null; submitted = true;
      status(`已提交 ${record.id.slice(0, 8)}，待开发者确认；未自动执行 AI。`);
    } catch (error) {
      status(`提交未确认：${error.message}。草稿已保留，点击提交使用原编号重试。`);
    } finally { sending = false; $('#submit').disabled = submitted; }
  }
  async function list() {
    try {
      const records = await send({ type: 'feedback.list' });
      $('#records').replaceChildren();
      for (const record of records.slice(0, 100)) {
        const card = node('article', '');
        card.append(node('b', `${labels[record.status] || record.status} · ${record.id.slice(0, 8)}`),
          node('p', record.description), node('small', record.page));
        if (record.note) card.append(node('p', record.note));
        if (record.status === 'awaiting_review') {
          for (const [label, next] of [['验收通过', 'verified'], ['仍需修改', 'changes_requested']]) {
            const button = node('button', label);
            button.onclick = async () => {
              const note = next === 'changes_requested' ? prompt('请说明还需要修改的地方（不会自动触发新一轮）：') : '';
              if (note === null || (next === 'changes_requested' && !note.trim())) return;
              button.disabled = true;
              try { await send({ type: 'feedback.verify', id: record.id, status: next, note }); await list(); }
              catch (error) { status(error.message); button.disabled = false; }
            };
            card.append(button);
          }
        }
        $('#records').append(card);
      }
      if (!records.length) $('#records').append(node('p', '此预览端口暂无反馈。'));
    } catch (error) { status(error.message); }
  }
  function mount(meta) {
    host = document.createElement('termrelay-feedback');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;inset:0!important;pointer-events:none!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host{font:14px/1.5 system-ui,sans-serif;color:#17233b}*{box-sizing:border-box}
        [hidden]{display:none!important}button,input,textarea{font:inherit}
        button{cursor:pointer;padding:7px 10px;margin:4px;border:1px solid #bdc9df;border-radius:6px;background:#fff;color:#17233b}
        button:disabled{opacity:.5;cursor:default}
        #toggle,#panel,#hint{pointer-events:auto}
        #toggle{position:fixed;right:20px;bottom:20px;background:#245bdb;color:white}
        #panel{position:fixed;right:12px;top:12px;bottom:76px;width:min(380px,calc(100vw - 24px));background:white;border:1px solid #cad2df;border-radius:12px;box-shadow:0 8px 40px #0003;padding:16px;overflow:auto}
        #hint{position:fixed;top:12px;left:20px;background:#17233b;color:white;padding:10px;border-radius:8px}
        #highlight{position:fixed;border:2px solid #245bdb;background:#245bdb18;pointer-events:none}
        textarea{width:100%;min-height:84px;resize:vertical;padding:8px}label{display:block;margin:10px 0}
        pre,small,#page,#status{white-space:pre-wrap;overflow-wrap:anywhere}pre{max-height:200px;overflow:auto;background:#f4f6fa;padding:8px}
        article{border-top:1px solid #ddd;margin-top:12px;padding-top:12px}#status{color:#8b3600}#close{float:right}
      </style>
      <div id="highlight" hidden></div>
      <div id="hint" hidden>移动鼠标定位，点击选中；Esc 退出 <button id="cancel-pick">取消选择</button></div>
      <button id="toggle">反馈</button>
      <section id="panel" hidden>
        <button id="close">收起</button><h3>页面反馈</h3><p id="environment"></p>
        <p>不采集截图；提交后由开发者确认执行。</p>
        <button id="pick">选择页面元素</button><button id="whole">反馈整个页面</button>
        <p id="object"></p><small id="page"></small><button id="outer">选择外层</button>
        <label>希望怎么改 *<textarea id="description" maxlength="4000"></textarea></label>
        <label>复现步骤（可选）<textarea id="steps" maxlength="2000"></textarea></label>
        <details><summary>查看将提交的上下文（元素文字最多 500 字符，不含查询参数、表单值）</summary><pre id="context"></pre></details>
        <p id="status" role="status"></p>
        <button id="submit">提交反馈 / 确认上次提交</button><button id="new">继续反馈 / 清空</button>
        <hr><button id="list">刷新本环境反馈</button>
        <p>此配对配置的验收者共享反馈列表。页面参数已省略，必要复现条件请自行补充，勿填敏感数据。</p>
        <div id="records"></div>
      </section>`;
    document.documentElement.append(host);
    $('#environment').textContent = meta.name;
    $('#toggle').onclick = () => { $('#panel').hidden = !$('#panel').hidden; if ($('#panel').hidden) highlight(null); else highlight(target); };
    $('#close').onclick = () => { $('#panel').hidden = true; highlight(null); };
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
    if (!(item instanceof HTMLElement)) { status('此元素暂不支持，请选择外层或反馈整个页面。'); exitSelection(); return; }
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
    else if (!submitted && pinnedPage !== pageURL()) status('页面已变化，草稿仍关联原页面；选新元素或整页反馈可明确重新采集。');
  }, 1000);
  async function ensure() {
    if (authorized) return;
    const meta = await send({ type: 'preview.meta' });
    authorized = true; mount(meta);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'panel.toggle') return;
    ensure().then(() => { $('#panel').hidden = !$('#panel').hidden; respond({ ok: true }); },
      error => { alert(`TermRelay：${error.message}`); respond({ ok: false }); });
    return true;
  });
  ensure().catch(error => console.info('TermRelay 反馈未启用：', error.message));
})();
