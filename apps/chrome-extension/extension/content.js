(() => {
  if (!['http:', 'https:'].includes(location.protocol) || globalThis.__termrelayFeedbackLoaded) return;
  globalThis.__termrelayFeedbackLoaded = true;
  const pageURL = () => `${location.origin}${location.pathname}`;
  const labels = {
    pending: '已排队，等待 Chat 空闲', sending: '正在向 AI 发送消息', running: 'AI 正在处理', completed: 'AI 已回复',
    awaiting_approval: '等待 Chat 工具审批', awaiting_input: '等待 Chat 问题回复',
    delivered: '已送达会话，等待开发者核实',
    unknown: '执行结果未知，等待核实', failed: '执行失败',
    awaiting_review: '本轮修改完成，刷新看看效果', verified: '效果已确认', changes_requested: '已记录调整意见',
  };
  let host, root, target, element = null, selecting = false;
  let pinnedPage = pageURL(), pending = null, submitted = false, sending = false;
  let submittedID = null, replyTo = null, displayedReplyID = null;
  let recordsKey = null;
  let synchronizing = false;
  let screenshot = null, screenshotSupported = false, screenshotSelecting = false, capturing = false, drag = null;
  let openedScreenshot = null, openedScreenshotID = null;
  const $ = selector => root.querySelector(selector);
  function node(tag, value) { const result = document.createElement(tag); result.textContent = value; return result; }
  function messageContent(text) {
    const content = node('div', '');
    content.className = 'message-content';
    const lines = text.split('\n');
    let paragraph = [], code = null, language = '';
    const flush = () => {
      if (paragraph.length) content.append(node('p', paragraph.join('\n')));
      paragraph = [];
    };
    const appendCode = () => {
      const block = node('div', '');
      block.className = 'code-block';
      block.append(node('small', language || '代码'));
      const pre = node('pre', '');
      pre.append(node('code', code.join('\n')));
      block.append(pre); content.append(block);
      code = null;
    };
    for (const line of lines) {
      const fence = line.match(/^\s*```([\w.+-]*)\s*$/);
      if (code !== null) {
        if (fence) appendCode();
        else code.push(line);
      } else if (fence) {
        flush(); code = []; language = fence[1];
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
    if (code !== null) appendCode();
    flush();
    return content;
  }
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '插件服务未响应，请检查 App 连接。');
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
    $('#object').textContent = element ? `${element.tag} · ${element.text.slice(0, 80) || element.role || '无可见文字'}${screenshot ? ' · 已附截图' : ''}` : screenshot ? '截图区域' : '整个页面';
    $('#page').textContent = pinnedPage;
    $('#page').title = pinnedPage;
    $('#context').textContent = JSON.stringify({ page: pinnedPage, element }, null, 2);
    $('#outer').disabled = !target?.parentElement || submitted || !!pending;
    $('#attachments').open = !!element || !!screenshot;
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
    if (submitted) { status('消息已发送，可在回复下继续对话，或开启新话题。'); return false; }
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
    $('#screenshot-size').textContent = value ? `${value.width} × ${value.height} · 尚未上传，随消息发送` : '';
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
      status('截图已准备，确认图片内容后输入问题或请求。');
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
    submittedID = null; displayedReplyID = null;
    replyTo = null; $('#reply-context').hidden = true; $('#reply-context').textContent = '';
    $('#description').value = ''; $('#steps').value = '';
    $('#count').textContent = '0 / 4000';
    showScreenshot(null);
    freezeForm(false); highlight(null); summary(); status('');
    $('#submit').disabled = false;
    $('#submit').textContent = '发送给 AI';
  }
  async function submit() {
    if (sending || submitted) return;
    const description = $('#description').value.trim();
    if (!description) { status('请输入问题或请求。', 'error'); $('#description').focus(); return; }
    if (capturing || screenshotSelecting) return;
    if (screenshot && !$('#screenshot-consent').checked) { status('请先确认截图内容可以发送给 AI。', 'error'); $('#screenshot-consent').focus(); return; }
    const draft = {
      page: pinnedPage, element,
      description, steps: $('#steps').value.trim(),
      imageCount: screenshot ? 1 : 0,
      ...(replyTo ? { parentId: replyTo } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
    sending = true; freezeForm(true); $('#submit').disabled = true;
    $('#submit').textContent = '正在传递你的想法…';
    status('正在提交；若响应丢失，可用原编号重试确认。');
    try {
      if (!pending) pending = { ...draft, id: await send({ type: 'feedback.id' }) };
      const record = await send({ type: 'feedback.create', feedback: pending });
      if (pending.screenshot && (!record.screenshot || record.screenshot.width !== pending.screenshot.width
        || record.screenshot.height !== pending.screenshot.height)) {
        throw new Error('App 未确认接收截图，不能确认本次附图发送成功。请保留当前编号，到 App 核实，勿作为纯文字重新发送');
      }
      pending = null; submitted = true;
      submittedID = record.id;
      target = null; element = null; pinnedPage = pageURL();
      $('#description').value = ''; $('#steps').value = ''; $('#count').textContent = '0 / 4000';
      showScreenshot(null); highlight(null);
      status(`已发送 ${record.id.slice(0, 8)}，等待 AI 处理；工具审批遵循 Chat 原设置。`);
      await list();
    } catch (error) {
      status(`提交未确认：${error.message}。草稿已保留，点击“确认上次提交”使用原编号查询，不会重复创建。`, 'error');
    } finally {
      sending = false; $('#submit').disabled = submitted;
      $('#submit').textContent = submitted ? '已发送' : '确认上次提交';
      if (!$('#panel').hidden) $('#status').scrollIntoView({ block: 'nearest' });
    }
  }
  async function list() {
    try {
      const records = await send({ type: 'feedback.list' });
      const current = records.find(record => record.id === submittedID);
      if (current) status(`已发送 ${current.id.slice(0, 8)} · ${current.screenshot ? `App 已接收截图 ${current.screenshot.width} × ${current.screenshot.height} · ` : '本条无图片 · '}${labels[current.status] || current.status}${current.note ? `：${current.note}` : ''}`);
      if (current && submitted && !sending && ['completed', 'awaiting_review', 'verified', 'changes_requested', 'failed'].includes(current.status)) {
        submitted = false;
        replyTo = current.status === 'failed' ? null : current.id;
        $('#reply-context').textContent = replyTo ? `继续对话 · ${current.description.slice(0, 80)}` : '';
        $('#reply-context').hidden = !replyTo;
        freezeForm(false); summary();
        $('#submit').disabled = false; $('#submit').textContent = '发送给 AI';
      }
      const key = JSON.stringify(records.slice(0, 100));
      if (key === recordsKey && (displayedReplyID === submittedID || $('#panel').hidden || current?.status !== 'completed')) return;
      recordsKey = key;
      const history = $('#history'), previousTop = history.scrollTop;
      const nearEnd = history.scrollHeight - history.clientHeight - previousTop < 48;
      $('#records').replaceChildren();
      let latestReply = null;
      for (const record of records.slice(0, 100).reverse()) {
        const card = node('article', '');
        card.className = 'conversation-turn'; card.dataset.id = record.id;
        const heading = node('div', ''), badge = node('span', labels[record.status] || record.status);
        heading.className = 'record-heading'; badge.className = 'record-badge'; badge.dataset.state = record.status;
        heading.append(badge, node('small', record.id.slice(0, 8)));
        const user = node('section', '');
        user.className = 'message message-user';
        user.append(node('strong', '你'), messageContent(record.description));
        if (record.steps) {
          const extra = node('details', '');
          extra.append(node('summary', '补充上下文'), node('p', record.steps)); user.append(extra);
        }
        const attachment = node('details', '');
        attachment.className = 'message-attachment';
        attachment.append(node('summary', record.element ? `附带选区 · ${record.element.tag} · ${record.element.text.slice(0, 60) || record.element.role || '无可见文字'}` : '附带页面'));
        const page = node('small', record.page); page.className = 'record-page'; page.title = record.page;
        attachment.append(page);
        user.append(attachment);
        card.append(user);
        if (record.parentId) user.append(node('small', `接续 ${record.parentId.slice(0, 8)}`));
        if (record.screenshot) {
          const button = node('button', `查看截图 · ${record.screenshot.width} × ${record.screenshot.height}`);
          const thumbnail = () => {
            const image = node('img', '');
            image.src = openedScreenshot.dataURL; image.alt = '本条消息附带的截图';
            button.append(image);
          };
          if (openedScreenshotID === record.id) thumbnail();
          button.onclick = async () => {
            button.disabled = true;
            try {
              if (openedScreenshotID !== record.id) {
                openedScreenshot = await send({ type: 'feedback.screenshot', id: record.id });
                openedScreenshotID = record.id;
              }
              if (!button.querySelector('img')) thumbnail();
              viewScreenshot(openedScreenshot);
            } catch (error) { status(error.message, 'error'); }
            finally { button.disabled = false; }
          };
          button.className = 'image-attachment';
          user.append(button);
        }
        const assistant = node('section', '');
        assistant.className = 'message message-assistant';
        assistant.append(node('strong', 'AI'), heading);
        card.append(assistant);
        if (record.note) { const note = node('p', record.note); note.className = 'record-note'; assistant.append(note); }
        if (record.response) {
          const response = messageContent(record.response); response.classList.add('record-response');
          assistant.append(response);
          if (record.id === submittedID && record.status === 'completed') latestReply = response;
        }
        const actions = node('div', ''); actions.className = 'record-actions'; assistant.append(actions);
        if (['completed', 'awaiting_review', 'verified', 'changes_requested'].includes(record.status)) {
          const followup = node('button', '继续对话');
          followup.onclick = () => {
            if (sending || pending || capturing || screenshotSelecting) { status('请先处理当前未确认的消息或截图。'); return; }
            if (!submitted && ($('#description').value.trim() || screenshot) && !confirm('丢弃当前草稿，继续这条对话？')) return;
            reset(); replyTo = record.id;
            $('#reply-context').textContent = `接续对话：${record.description.slice(0, 120)}`;
            $('#reply-context').hidden = false;
            summary(); $('#description').focus(); $('#description').scrollIntoView({ block: 'nearest' });
          };
          actions.append(followup);
        }
        if (record.status === 'completed') {
          const verify = node('button', '确认结果');
          verify.onclick = async () => {
            verify.disabled = true;
            try { await send({ type: 'feedback.verify', id: record.id, status: 'verified', note: '' }); await list(); }
            catch (error) { status(error.message, 'error'); verify.disabled = false; }
          };
          actions.append(verify);
        }
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
            actions.append(button);
          }
        }
        $('#records').append(card);
      }
      if (latestReply && displayedReplyID !== submittedID && !$('#panel').hidden) {
        latestReply.scrollIntoView({ block: 'nearest' }); displayedReplyID = submittedID;
      } else history.scrollTop = nearEnd ? history.scrollHeight : previousTop;
      if (!records.length) {
        const empty = node('div', '');
        empty.append(node('h3', '围绕这一页，聊一聊'), node('p', '提问、讨论交互，或告诉 AI 你想怎么改。选区和截图都只是消息的附件。'));
        empty.className = 'empty'; $('#records').append(empty);
      }
    } catch (error) { status(error.message, 'error'); }
  }
  function mount(meta) {
    const chatIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14a4 4 0 0 1-4 4H9l-5 3V7a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4Z"/><path d="M8 8h8M8 12h5"/></svg>';
    host = document.createElement('termrelay-feedback');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;inset:0!important;pointer-events:none!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box}[hidden]{display:none!important}
        #toggle,#panel,#hint,#screenshot-overlay,#image-viewer{pointer-events:auto;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#24342e;text-align:left;letter-spacing:0;color-scheme:light}
        button,textarea{font:inherit}button,textarea,summary{outline-offset:3px}
        :focus-visible{outline:2px solid #237651}
        button{cursor:pointer;border:1px solid #dfe7e2;border-radius:9px;background:white;color:#52655b;padding:7px 11px;font-size:12px;transition:background .15s,border-color .15s}
        button:hover:not(:disabled){background:#edf5f0;border-color:#b9cfc1;color:#214e38}
        button:disabled{opacity:.45;cursor:not-allowed}
        #toggle{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;justify-content:center;width:46px;height:46px;background:#fff;color:#24563d;border:1px solid #dbe7df;border-radius:50%;padding:11px;box-shadow:0 4px 20px #163c2014}
        #toggle svg,.panel-brand svg{display:block;width:22px;height:22px;flex-shrink:0}
        #toggle:hover{background:#edf5f0}
        #panel{position:fixed;right:16px;top:16px;bottom:76px;width:min(432px,calc(100vw - 32px));display:flex;flex-direction:column;background:#f8faf9;border:1px solid #dfe7e2;border-radius:18px;box-shadow:0 12px 48px #163c2024;overflow:hidden}
        .panel-header{display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding:14px 18px;background:#fff;border-bottom:1px solid #e7ede9}
        .panel-header h2{margin:0;font-size:16px;font-weight:600}
        .panel-brand{display:flex;align-items:center}
        .sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
        #close{border:0;padding:5px 8px;font-size:12px;color:#728278;background:#f4f7f5}
        .panel-body{display:flex;flex:1;flex-direction:column;min-height:0}
        .connection{flex-shrink:0;padding:9px 18px;border-bottom:1px solid #e7ede9;background:#fff}
        #environment{margin:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#52655b}
        #connection{margin:2px 0 0;font-size:11px;color:#6b8273;overflow-wrap:anywhere}
        #connection[data-state=error]{color:#a12727}
        #history{flex:1;min-height:100px;overflow:auto;overscroll-behavior:contain;padding:0 16px 16px;scrollbar-width:thin}
        .composer{flex-shrink:0;max-height:52%;overflow:auto;overscroll-behavior:contain;padding:12px 16px;background:#fff;border-top:1px solid #e1e9e4;scrollbar-width:thin}
        .step-heading{display:block;margin:0 0 6px;font-size:12px;font-weight:600}
        .pick-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
        .selection{margin:8px 0;min-width:0;padding:8px 10px;background:#f1f6f3;border:1px solid #e0eae3;border-radius:9px}
        .selection-heading{display:flex;gap:8px;align-items:center;justify-content:space-between}
        #object{margin:0;font-size:12px;overflow-wrap:anywhere}
        #outer{flex-shrink:0;font-size:12px;padding:3px 0;border:0}
        #page{display:block;font-size:11px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
        textarea{display:block;width:100%;min-height:76px;resize:vertical;max-height:160px;padding:10px 12px;border:1px solid #dce5df;border-radius:11px;background:#fafcfb;color:#24342e;font-size:13px;line-height:1.6}
        textarea:focus{border-color:#78a58a;background:#fff}
        textarea::placeholder{color:#888}
        #count{font-size:10px;color:#89968e;margin-left:auto}
        details{font-size:12px;color:#6b7b71;margin:6px 0}
        #attachments>summary{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#4b6c58;list-style:none;padding:4px 0}
        #attachments>summary::after{content:"展开";font-size:10px;color:#89968e}
        #attachments[open]>summary::after{content:"收起"}
        summary{cursor:pointer}details textarea{margin-top:8px;min-height:78px}
        .privacy-copy{font-size:11px;color:#666;margin:8px 0}
        pre{max-height:170px;overflow:auto;background:#f7f7f7;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
        .submit-actions{display:flex;align-items:center;gap:8px;margin-top:8px}
        #submit{background:#246344;border-color:#246344;color:white;padding:8px 14px}
        #submit:hover:not(:disabled){background:#194d33}
        #new{border:0;background:transparent;padding:5px 0}
        #status{flex-shrink:0;max-height:64px;overflow:auto;font-size:11px;border-left:2px solid #b9cfbf;padding:6px 12px;color:#6b7b71;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 16px 8px}
        #status[data-tone=error]{border-color:#a12727;color:#a12727}
        .history-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px}
        .history-heading h3{margin:0;font-size:11px;font-weight:500;color:#89968e}.history-heading button{padding:3px 0;font-size:11px;border:0;background:transparent}
        .history-help{font-size:10px;color:#89968e;margin:0 0 12px}
        article{margin:18px 0 0;min-width:0}
        .message{padding:12px 14px;border:1px solid #e2eae5;border-radius:13px;margin:10px 0;min-width:0}
        .message-user{margin-left:24px;background:#edf5ef;border-color:#dfeae2;border-bottom-right-radius:4px}
        .message-assistant{margin-right:12px;background:#fff;border-bottom-left-radius:4px}
        .record-heading{display:flex;gap:7px;align-items:flex-start;justify-content:space-between}
        .record-heading>small{font:11px/1.6 ui-monospace,monospace;color:#777}
        .record-badge{font-size:10px;color:#718378;overflow-wrap:anywhere}
        .record-badge[data-state=failed],.record-badge[data-state=unknown]{color:#a12727}
        article p{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
        .record-page{display:block;font-size:11px;color:#777;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
        article .record-note{font-size:12px;color:#666;margin:8px 0}
        article .record-response{overflow-wrap:anywhere;line-height:1.7}
        article strong{display:block;font-size:11px;color:#5e7566;margin-bottom:4px}
        article small{font-size:10px;color:#89968e}
        .record-actions{display:flex;gap:6px;flex-wrap:wrap}
        .record-actions button{border:0;background:#f3f7f4;padding:4px 8px;font-size:11px;margin-top:8px}
        .message-attachment{border-top:1px solid #dce8df;padding-top:6px;margin-top:8px}
        .image-attachment{margin-top:8px;width:100%;text-align:left;background:#f8fbf9;font-size:11px}
        .image-attachment img{display:block;width:100%;max-height:160px;object-fit:contain;border-radius:6px;margin-top:8px}
        .code-block{border:1px solid #dfe7e2;border-radius:8px;overflow:hidden;margin:10px 0;background:#f5f8f6}
        .code-block>small{display:block;padding:5px 10px;border-bottom:1px solid #dfe7e2}
        .code-block pre{margin:0;max-height:240px;padding:10px;white-space:pre;overflow:auto;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}
        #reply-context{font-size:11px;color:#52745f;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;margin:0 0 7px}
        .empty{color:#819088;margin:36px 12px;text-align:center}
        .empty h3{font-size:17px;font-weight:500;color:#3c5847;margin:0 0 8px}.empty p{font-size:12px;line-height:1.9;margin:0}
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
        @media(prefers-reduced-motion:reduce){*{transition:none!important}}
      </style>
      <div id="highlight" hidden></div>
      <div id="hint" hidden>移动鼠标定位，点击选中；Esc 退出 <button id="cancel-pick">取消选择</button></div>
      <div id="screenshot-overlay" hidden><div id="screenshot-region" hidden></div><div id="screenshot-toolbar"><span>框选截图区域</span><button id="cancel-screenshot">取消</button></div></div>
      <dialog id="image-viewer" aria-label="对话截图"><button id="close-viewer">关闭</button><img id="viewer-image" alt="对话截图"></dialog>
      <button id="toggle" aria-controls="panel" aria-expanded="false" aria-label="打开或收起页面对话" title="页面对话">${chatIcon}</button>
      <section id="panel" aria-labelledby="panel-title" hidden>
        <header class="panel-header"><div class="panel-brand">${chatIcon}<h2 id="panel-title" class="sr-only">页面对话</h2></div><button id="close" aria-label="收起页面对话">收起</button></header>
        <div class="panel-body">
          <div class="connection"><p id="environment"></p><p id="connection" role="status"></p></div>
          <div id="history" role="region" aria-label="对话记录" tabindex="0">
            <div class="history-heading"><h3>对话记录</h3><button id="list">刷新</button></div>
            <p class="history-help">本共享连接内的对话与答复共享可见</p>
            <div id="records"></div>
          </div>
          <p id="status" role="status" aria-live="polite" hidden></p>
          <div class="composer">
          <p id="reply-context" hidden></p>
          <label for="description" class="step-heading">消息</label>
          <textarea id="description" maxlength="4000" required placeholder="聊聊这一页，或说说你想怎么改…"></textarea>
          <details id="attachments"><summary>附带页面、选区或图片</summary>
          <div class="pick-actions"><button id="pick">选择元素</button><button id="whole">当前页面</button><button id="screenshot" disabled>框选截图</button></div>
          <div class="selection"><div class="selection-heading"><p id="object"></p><button id="outer">扩大范围</button></div><small id="page"></small></div>
          <div id="screenshot-preview" hidden><button id="screenshot-expand" title="查看截图"><img id="screenshot-image" alt="待提交截图"></button><div class="screenshot-actions"><span id="screenshot-size"></span><button id="remove-screenshot">移除截图</button></div><label class="screenshot-consent"><input id="screenshot-consent" type="checkbox"><span>我确认图片可发送给绑定 AI，已检查其中的表单、账号及其他敏感内容。</span></label></div>
          <p class="privacy-copy">选区和截图仅随本条消息发送，不自动附到下一条。</p>
          </details>
          <details><summary>补充上下文（选填）</summary><textarea id="steps" maxlength="2000" aria-label="补充上下文" placeholder="操作步骤、预期行为或其他背景"></textarea></details>
          <details><summary>页面信息</summary><p class="privacy-copy">发送当前页面地址、可选的元素文字与结构，以及明确添加的截图。截图可能含敏感信息，发送前请确认。AI 答复会在本共享连接中可见。</p><pre id="context"></pre></details>
          <div class="submit-actions"><button id="new">新话题</button><small id="count">0 / 4000</small><button id="submit">发送给 AI</button></div>
          </div>
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
    $('#whole').onclick = () => {
      if (!editable()) return;
      if (screenshot && pinnedPage !== pageURL()) { status('页面已变化，请先移除旧截图或重新截图，避免发送错误的图片。', 'error'); return; }
      target = null; element = null; pinnedPage = pageURL(); highlight(null); summary();
    };
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
    if (screenshot && pinnedPage !== pageURL()) {
      exitSelection(); status('页面已变化，请先移除旧截图或重新截图，避免发送错误的图片。', 'error'); return;
    }
    target = item; element = capture(item); pinnedPage = pageURL(); exitSelection(); summary();
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
    else if (!submitted && pinnedPage !== pageURL()) status('页面已变化，草稿仍关联原页面；重新选择元素或“当前页面”可更新上下文。');
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
      error => { alert(`插件：${error.message}`); respond({ ok: false }); });
    return true;
  });
  synchronize();
  setInterval(synchronize, 3000);
})();
