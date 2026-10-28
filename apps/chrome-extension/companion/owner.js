const $ = selector => document.querySelector(selector);
let token = '';
let loading = false;
const labels = { pending: '待处理', sending: '发送中', delivered: '已送达会话（不是修改完成）', unknown: '结果未知，需核实', failed: '发送失败', awaiting_review: '待验收', verified: '已验收', changes_requested: '需继续修改（请人工处理）' };
async function api(path, body) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function node(tag, text) { const result = document.createElement(tag); result.textContent = text; return result; }
function button(text, action) {
  const result = node('button', text);
  result.onclick = async () => {
    result.disabled = true;
    try { await action(); await refresh(); }
    catch (error) { $('#error').textContent = error.message; }
    finally { result.disabled = false; }
  };
  return result;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const state = await api('/api/state');
    $('#workspace').hidden = false;
    $('#error').textContent = '';
    $('#binding').textContent = `${state.binding.name} · ${state.binding.sessionId}`;
    $('#pairing').textContent = JSON.stringify({
      companionURL: 'http://<开发者局域网 IP>:18420',
      reviewerToken: state.reviewerToken, proxyToken: state.proxyToken,
      ports: state.ports,
    }, null, 2);
    $('#records').replaceChildren();
    for (const record of state.records) {
      const card = node('article', '');
      card.append(node('h3', `${labels[record.status] ?? record.status} · ${record.id.slice(0, 8)}`));
      card.append(node('p', record.page), node('pre', record.description));
      if (record.steps) card.append(node('pre', record.steps));
      if (record.element) card.append(node('pre', JSON.stringify(record.element, null, 2)));
      if (record.note) card.append(node('p', record.note));
      if (record.status === 'pending') card.append(button('确认交给此会话修改', async () => {
        if (confirm('确认项目绑定正确、会话空闲，且没有其他会话修改同一目录？提交后不会自动重试。')) {
          await api(`/api/feedback/${record.id}/deliver`, {});
        }
      }));
      if (['delivered', 'unknown'].includes(record.status)) {
        const summary = document.createElement('textarea');
        summary.placeholder = '先在 TermRelay 核实执行已经结束，再填写给业务方看的修改摘要。';
        card.append(summary, button('已核实执行结束，交业务方验收', async () => {
          if (!summary.value.trim()) throw new Error('请填写修改摘要。');
          if (confirm('已在 TermRelay 核实没有正在执行的轮次，且修改结果可验收？')) {
            await api(`/api/feedback/${record.id}/review`, { checked: true, note: summary.value });
          }
        }));
        card.append(button('已核实失败或未执行，结束此记录', async () => {
          if (!summary.value.trim()) throw new Error('请填写核实结果。');
          if (confirm('确认已经核实该轮未在运行？此记录将标记失败，不会自动重新发送。')) {
            await api(`/api/feedback/${record.id}/review`, { checked: true, outcome: 'failed', note: summary.value });
          }
        }));
      }
      $('#records').append(card);
    }
  } finally { loading = false; }
}
$('#login').onsubmit = async event => {
  event.preventDefault();
  token = $('#token').value;
  $('#token').value = '';
  try { await refresh(); } catch (error) { $('#error').textContent = error.message; }
};
$('#refresh').onclick = () => refresh().catch(error => { $('#error').textContent = error.message; });
