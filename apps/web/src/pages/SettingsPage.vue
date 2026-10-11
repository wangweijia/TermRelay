<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import type { NotificationSettings } from '../types';

interface ProjectKey { id: string; revoked: boolean; legacy: boolean }
const keys = ref<ProjectKey[]>([]);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const message = ref('');
const generated = ref<{apiKey: string}>();
const saved = ref(false);
const secretField = ref<HTMLTextAreaElement>();
const notifications = ref<NotificationSettings>();
const notificationBusy = ref(false);
const visibleKeys = computed(() => [...keys.value].sort((a,b) => Number(a.revoked)-Number(b.revoked)));

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url,{cache:'no-store',...(body === undefined ? {}:{method:'POST',headers:{'Content-Type':'application/json','X-TermRelay-Settings':'1'},body:JSON.stringify(body)})});
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as {message?: string};
    const reasons: Record<string,string> = {ai_requires_database:'请先启用 Server 数据库并执行迁移。',same_origin_required:'配置操作仅允许同站点请求。',invalid_key_settings:'生成 Key 不需要配置参数，请刷新后重试。'};
    throw new Error(reasons[detail.message ?? ''] ?? `操作失败（${response.status}），请刷新后重试。`);
  }
  return response.json() as Promise<T>;
}
async function refresh() {
  loading.value = true; error.value = '';
  try {
    const data = await request<{keys:ProjectKey[]}>('/api/settings/ai');
    keys.value = data.keys;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '读取配置失败'; }
  finally { loading.value = false; }
}
async function generate(existing?: ProjectKey) {
  if (busy.value || generated.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await request<ProjectKey & {apiKey:string}>(existing ? `/api/settings/ai/keys/${existing.id}/rotate`:'/api/settings/ai/keys',{});
    generated.value = {apiKey:result.apiKey}; saved.value = false;
    // Keep the secret only in the temporary reveal panel, not the key list or browser storage.
    keys.value.push({id:result.id,revoked:result.revoked,legacy:result.legacy});
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '生成失败'; }
  finally { busy.value = false; }
}
async function copyKey() {
  if (!generated.value) return;
  try {
    await navigator.clipboard.writeText(generated.value.apiKey);
    message.value = '已复制，请保存到项目后端的环境配置中。';
  } catch { secretField.value?.focus(); secretField.value?.select(); message.value = '当前浏览器不支持自动复制，已选中文本，请手动复制。'; }
}
async function revoke(key: ProjectKey) {
  if (busy.value || !window.confirm('撤销这把 Key？使用它的新请求将立即失效，已有任务不会被取消。')) return;
  busy.value = true; error.value = '';
  try { const updated = await request<ProjectKey>(`/api/settings/ai/keys/${key.id}/revoke`,{}); keys.value = keys.value.map(k => k.id === updated.id ? updated:k); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '撤销失败'; }
  finally { busy.value = false; }
}
async function toggleNotifications() {
  if (!notifications.value || notificationBusy.value) return;
  notificationBusy.value = true;
  try {
    const response = await fetch('/api/notifications/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!notifications.value.enabled})});
    if (!response.ok) throw new Error('通知设置保存失败');
    notifications.value = await response.json() as NotificationSettings;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; }
  finally { notificationBusy.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (generated.value && !saved.value) event.preventDefault(); }
onBeforeRouteLeave(() => !generated.value || saved.value || window.confirm('Key 只显示一次。确定离开？未保存时需要重新生成。'));
onMounted(() => {
  void refresh();
  void fetch('/api/notifications/settings',{cache:'no-store'}).then(async r => { if (r.ok) notifications.value = await r.json() as NotificationSettings; }).catch(() => undefined);
  window.addEventListener('beforeunload',beforeUnload);
});
onBeforeUnmount(() => { generated.value = undefined; window.removeEventListener('beforeunload',beforeUnload); });
</script>

<template>
  <main class="settings-page">
    <div class="settings-heading"><div><h1>配置</h1><p>服务配置的统一入口</p></div><RouterLink to="/">返回会话</RouterLink><RouterLink to="/mobile">手机会话</RouterLink></div>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section class="settings-card">
      <div class="settings-heading"><h2>API Key</h2><button :disabled="loading || busy" @click="refresh">{{ loading ? '读取中…' : '刷新' }}</button></div>
      <p>直接生成并交给调用方即可。不绑定项目、设备或用途，也不需要 Mac 在线。</p>
      <p>持有有效 Key 的调用方可以调用 AI 接口、查询和控制 AI 任务；不能用它管理配置页。请只交给可信调用方。</p>
      <div class="settings-actions"><button type="button" :disabled="busy || !!generated" @click="generate()">{{ busy ? '处理中…' : '生成 Key' }}</button></div>
      <div v-if="generated" class="settings-secret" role="region" aria-label="新生成的 API Key">
        <strong>新 API Key（只显示这一次）</strong>
        <textarea ref="secretField" :value="generated.apiKey" readonly aria-label="API Key" spellcheck="false" />
        <button @click="copyKey">复制 Key</button>
        <p>保存到项目后端的 TERMRELAY_API_KEY，不要放在前端、URL 或提交到 Git。替换 Key 时先更新项目配置，再撤销旧 Key。</p>
        <label class="settings-check"><input v-model="saved" type="checkbox">我已保存 Key</label>
        <button :disabled="!saved" @click="generated = undefined; message = ''">关闭显示</button>
      </div>
      <h3>已生成的 Key</h3>
      <p v-if="!keys.length && !loading">还没有 API Key。</p>
      <article v-for="key in visibleKeys" :key="key.id" class="settings-key">
        <div><strong>Key {{ key.id.slice(0,8) }}</strong> · {{ key.revoked ? '已撤销' : '有效' }}<small>标识：{{ key.id }}</small><small v-if="key.legacy">旧版受限 Key，可生成替换 Key 改用通用鉴权。</small></div>
        <div v-if="!key.revoked" class="settings-actions"><button :disabled="busy || !!generated" @click="generate(key)">生成替换 Key</button><button :disabled="busy || !!generated" @click="revoke(key)">撤销</button></div>
      </article>
    </section>
    <section class="settings-card"><h2>审批通知</h2><p v-if="!notifications">暂时无法读取通知配置。</p><template v-else><p>{{ notifications.configured ? '通知服务已配置' : '尚未配置 Bark 服务，请先完成 Server 环境配置' }} · {{ notifications.enabled ? '已开启' : '已关闭' }}</p><button :disabled="notificationBusy || (!notifications.configured && !notifications.enabled)" @click="toggleNotifications">{{ notifications.enabled ? '关闭通知' : '开启通知' }}</button></template></section>
  </main>
</template>

<style scoped>
.settings-page { width: 100%; max-width: 960px; margin: 0 auto; padding: 24px; overflow: auto; flex: 1; min-height: 0; box-sizing: border-box; }
.settings-heading, .settings-actions { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.settings-heading > div:first-child { flex: 1; }
.settings-heading h2 { flex: 1; }
h1, h2 { margin: 0 0 8px; }
p { line-height: 1.6; color: #a9b4c4; }
.settings-card { border: 1px solid #334155; border-radius: 12px; padding: 20px; margin: 20px 0; background: #101b2b; }
textarea { width: 100%; box-sizing: border-box; padding: 10px; color: inherit; background: #172337; border: 1px solid #475569; border-radius: 6px; }
.settings-check { display: flex; align-items: center; gap: 8px; padding: 6px 0; overflow-wrap: anywhere; }
.settings-secret { background: #182d36; border: 1px solid #4b9e86; padding: 16px; border-radius: 8px; margin-top: 20px; }
textarea { margin: 12px 0; font-family: monospace; resize: vertical; }
.settings-key { border-top: 1px solid #334155; padding: 16px 0; display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; overflow-wrap: anywhere; }
small { display: block; margin-top: 6px; color: #a9b4c4; }
.settings-error { color: #ffb4b4; }
button { padding: 8px 12px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
@media (max-width: 640px) { .settings-page { padding: 14px; } .settings-card { padding: 14px; } }
</style>
