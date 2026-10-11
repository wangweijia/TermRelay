<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import type { AiProfile } from '@termrelay/contracts';
import type { NotificationSettings } from '../types';

interface ProjectKey { id: string; projectId: string; revoked: boolean; grants: {deviceIds: string[]; profiles: string[]; capacity: number} }
interface Target { deviceId: string; name: string; online: boolean; profiles: AiProfile[] }
const keys = ref<ProjectKey[]>([]);
const targets = ref<Target[]>([]);
const projectId = ref('invest');
const deviceId = ref('');
const profiles = ref<string[]>([]);
const capacity = ref(2);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const message = ref('');
const generated = ref<{projectId: string; apiKey: string}>();
const saved = ref(false);
const secretField = ref<HTMLTextAreaElement>();
const notifications = ref<NotificationSettings>();
const notificationBusy = ref(false);
const selectedTarget = computed(() => targets.value.find(t => t.deviceId === deviceId.value));
const canCreate = computed(() => /^[a-zA-Z0-9_-]{1,64}$/.test(projectId.value) && deviceId.value && profiles.value.length > 0 && Number.isInteger(capacity.value) && capacity.value >= 1 && capacity.value <= 16);
const visibleKeys = computed(() => [...keys.value].sort((a,b) => a.projectId.localeCompare(b.projectId) || Number(a.revoked)-Number(b.revoked)));

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url,{cache:'no-store',...(body === undefined ? {}:{method:'POST',headers:{'Content-Type':'application/json','X-TermRelay-Settings':'1'},body:JSON.stringify(body)})});
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as {message?: string};
    const reasons: Record<string,string> = {lan_only:'请使用局域网地址打开配置页；此功能不支持公网或代理入口。',ai_requires_database:'请先启用 Server 数据库并执行迁移。',project_grants_conflict:'此项目已有不同权限的 Key。请使用“生成替换 Key”保留原权限，或先撤销旧 Key 再修改权限。',same_origin_required:'配置操作仅允许同站点请求。',invalid_key_settings:'请检查项目名称、设备、Profile 和并发上限。'};
    throw new Error(reasons[detail.message ?? ''] ?? `操作失败（${response.status}），请刷新后重试。`);
  }
  return response.json() as Promise<T>;
}
function selectTarget() { profiles.value = selectedTarget.value?.profiles.map(p => p.id) ?? []; }
async function refresh() {
  loading.value = true; error.value = '';
  try {
    const data = await request<{keys:ProjectKey[]; targets:Target[]}>('/api/settings/ai');
    keys.value = data.keys; targets.value = data.targets;
    if (!deviceId.value) { deviceId.value = data.targets.find(t => t.online && t.profiles.length)?.deviceId ?? ''; selectTarget(); }
    else profiles.value = profiles.value.filter(id => selectedTarget.value?.profiles.some(p => p.id === id));
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '读取配置失败'; }
  finally { loading.value = false; }
}
async function generate(existing?: ProjectKey) {
  if (busy.value || generated.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await request<ProjectKey & {apiKey:string}>(existing ? `/api/settings/ai/keys/${existing.id}/rotate`:'/api/settings/ai/keys',existing ? {}:{projectId:projectId.value,deviceIds:[deviceId.value],profiles:profiles.value,capacity:capacity.value});
    generated.value = {projectId:result.projectId,apiKey:result.apiKey}; saved.value = false;
    keys.value.push(result);
    // Keep the secret only in the temporary reveal panel, not the key list or browser storage.
    keys.value = keys.value.map(k => ({id:k.id,projectId:k.projectId,grants:k.grants,revoked:k.revoked}));
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
  if (busy.value || !window.confirm(`撤销 ${key.projectId} 的这把 Key？使用它的新请求将立即失效，已有任务不会被取消。`)) return;
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
    <div class="settings-heading"><div><h1>配置</h1><p>项目接入与服务配置的统一入口</p></div><RouterLink to="/">返回会话</RouterLink><RouterLink to="/mobile">手机会话</RouterLink></div>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section class="settings-card">
      <div class="settings-heading"><h2>项目 API Key</h2><button :disabled="loading || busy" @click="refresh">{{ loading ? '读取中…' : '刷新' }}</button></div>
      <p>仅供受信局域网管理。Key 只能调用 AI 接口，不能操作配置页；每个项目使用自己的 Key。</p>
      <form class="settings-form" @submit.prevent="generate()">
        <label>项目标识<input v-model="projectId" maxlength="64" pattern="[a-zA-Z0-9_-]+" required placeholder="invest"></label>
        <label>执行设备<select v-model="deviceId" required @change="selectTarget"><option value="" disabled>请选择 Mac</option><option v-for="target in targets" :key="target.deviceId" :value="target.deviceId">{{ target.name }} · {{ target.online ? '在线' : '离线' }}</option></select></label>
        <fieldset><legend>允许的 Profiles</legend><label v-for="profile in selectedTarget?.profiles ?? []" :key="profile.id" class="settings-check"><input v-model="profiles" type="checkbox" :value="profile.id">{{ profile.id }} · {{ profile.provider }}</label><p v-if="!selectedTarget?.profiles.length">请让 Mac 连接局域网 Server，并在 Mac 设置中开放 AI Profiles，然后刷新。</p></fieldset>
        <label>项目并发上限<input v-model.number="capacity" type="number" min="1" max="16" required></label>
        <button type="submit" :disabled="!canCreate || busy || loading || !!generated">生成 Key</button>
      </form>
      <div v-if="generated" class="settings-secret" role="region" aria-label="新生成的 API Key">
        <strong>{{ generated.projectId }} 的新 Key（只显示这一次）</strong>
        <textarea ref="secretField" :value="generated.apiKey" readonly aria-label="API Key" spellcheck="false" />
        <button @click="copyKey">复制 Key</button>
        <p>保存到项目后端的 TERMRELAY_API_KEY，不要放在前端、URL 或提交到 Git。替换 Key 时先更新项目配置，再撤销旧 Key。</p>
        <label class="settings-check"><input v-model="saved" type="checkbox">我已保存 Key</label>
        <button :disabled="!saved" @click="generated = undefined; message = ''">关闭显示</button>
      </div>
      <h3>已生成的 Key</h3>
      <p v-if="!keys.length && !loading">还没有项目 Key。</p>
      <article v-for="key in visibleKeys" :key="key.id" class="settings-key">
        <div><strong>{{ key.projectId }}</strong> · {{ key.revoked ? '已撤销' : '有效' }}<small>标识：{{ key.id }}</small><small>设备：{{ key.grants.deviceIds.map(id => targets.find(t => t.deviceId === id)?.name ?? id).join('、') }}</small><small>Profiles：{{ key.grants.profiles.join('、') }} · 并发 {{ key.grants.capacity }}</small></div>
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
.settings-form { display: grid; gap: 14px; }
.settings-form > label { display: grid; gap: 6px; }
input:not([type=checkbox]), select, textarea { width: 100%; box-sizing: border-box; padding: 10px; color: inherit; background: #172337; border: 1px solid #475569; border-radius: 6px; }
fieldset { border: 1px solid #475569; border-radius: 6px; }
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
