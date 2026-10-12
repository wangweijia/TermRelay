<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import type { NotificationSettings } from '../types';
import { copyText, selectCopyText } from '../clipboard';
import { activeCredentials, activeKeys, availableTargets } from '../settings';
import type { AITarget, ClientCredentialSummary, ProjectKey } from '../settings';

const targets = ref<AITarget[]>([]);
const targetsLoading = ref(false);
const targetsError = ref('');
const copiedDeviceId = ref('');
const deviceIdField = ref<HTMLInputElement>();
const visibleTargets = computed(() => availableTargets(targets.value));
const keys = ref<ProjectKey[]>([]);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const message = ref('');
const generated = ref<{apiKey: string}>();
const saved = ref(false);
const secretField = ref<HTMLTextAreaElement>();
const keyCopyMessage = ref('');
const keyCopyState = ref<'idle' | 'copied' | 'manual'>('idle');
const copyingKey = ref(false);
const notifications = ref<NotificationSettings>();
const notificationBusy = ref(false);
const notificationsLoading = ref(false);
const notificationsError = ref('');
const credentials = ref<ClientCredentialSummary[]>([]);
const credentialsLoading = ref(false);
const credentialsError = ref('');
const revokingCredentialId = ref<string>();
const now = ref(Date.now());
let expiryTimer: number | undefined;
const visibleKeys = computed(() => activeKeys(keys.value));
const visibleCredentials = computed(() => activeCredentials(credentials.value, now.value));

async function refreshCredentials() {
  if (credentialsLoading.value || revokingCredentialId.value) return;
  credentialsLoading.value = true;
  credentialsError.value = '';
  try {
    credentials.value = await request<ClientCredentialSummary[]>('/api/client-credentials');
    now.value = Date.now();
  } catch (reason) {
    credentialsError.value = reason instanceof Error ? reason.message : '读取 Mac 授权失败';
  } finally { credentialsLoading.value = false; }
}
async function revokeCredential(credential: ClientCredentialSummary) {
  if (revokingCredentialId.value || !window.confirm('撤销此 Mac 授权？设备的公网连接将断开，需要重新配对才能连接。')) return;
  revokingCredentialId.value = credential.id;
  credentialsError.value = '';
  try {
    const updated = await request<ClientCredentialSummary>(`/api/client-credentials/${encodeURIComponent(credential.id)}/revoke`, {});
    credentials.value = credentials.value.map(item => item.id === updated.id ? updated : item);
  } catch (reason) {
    credentialsError.value = reason instanceof Error ? reason.message : '撤销 Mac 授权失败';
  } finally { revokingCredentialId.value = undefined; }
}
async function refreshNotifications() {
  if (notificationsLoading.value || notificationBusy.value) return;
  notificationsLoading.value = true;
  notificationsError.value = '';
  try { notifications.value = await request<NotificationSettings>('/api/notifications/settings'); }
  catch (reason) { notificationsError.value = reason instanceof Error ? reason.message : '读取通知配置失败'; }
  finally { notificationsLoading.value = false; }
}
function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '尚未连接';
}

async function refreshTargets() {
  if (targetsLoading.value) return;
  targetsLoading.value = true; targetsError.value = '';
  try { targets.value = await request<AITarget[]>('/api/settings/ai/targets'); }
  catch (reason) {
    targets.value = [];
    targetsError.value = reason instanceof Error ? reason.message : '读取设备失败';
  } finally { targetsLoading.value = false; }
}
async function copyDeviceId(id: string) {
  copiedDeviceId.value = id;
  await nextTick();
  const copied = await copyText(id, deviceIdField.value);
  message.value = copied ? '设备 ID 已复制，可填入调用方的 device_id 或请求的 target.deviceId。' : '自动复制失败，设备 ID 已全选，请按 ⌘C / Ctrl+C 或长按复制。';
}

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
  if (loading.value || busy.value) return;
  loading.value = true; error.value = '';
  try {
    const data = await request<{keys:ProjectKey[]}>('/api/settings/ai');
    keys.value = data.keys;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '读取配置失败'; }
  finally { loading.value = false; }
}
async function generate(existing?: ProjectKey) {
  if (loading.value || busy.value || generated.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await request<ProjectKey & {apiKey:string}>(existing ? `/api/settings/ai/keys/${existing.id}/rotate`:'/api/settings/ai/keys',{});
    generated.value = {apiKey:result.apiKey}; saved.value = false;
    keyCopyMessage.value = ''; keyCopyState.value = 'idle';
    // Keep the secret only in the temporary reveal panel, not the key list or browser storage.
    keys.value.push({id:result.id,revoked:result.revoked,legacy:result.legacy});
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '生成失败'; }
  finally { busy.value = false; }
}
async function copyKey() {
  if (!generated.value || copyingKey.value) return;
  copyingKey.value = true;
  try {
    const copied = await copyText(generated.value.apiKey, secretField.value);
    keyCopyState.value = copied ? 'copied' : 'manual';
    keyCopyMessage.value = copied ? '完整 Key 已复制，请粘贴到调用方的 API Key 配置并保存。' : '自动复制失败，完整 Key 已全选。请按 ⌘C / Ctrl+C，或在手机上长按复制。';
  } finally { copyingKey.value = false; }
}
function selectKey() {
  if (!generated.value || !secretField.value) return;
  selectCopyText(generated.value.apiKey, secretField.value);
  keyCopyState.value = 'manual';
  keyCopyMessage.value = '完整 Key 已全选，请按 ⌘C / Ctrl+C，或长按复制，然后粘贴到调用方配置。';
}
async function revoke(key: ProjectKey) {
  if (loading.value || busy.value || generated.value || !window.confirm('撤销这把 Key？使用它的新请求将立即失效，已有任务不会被取消。')) return;
  busy.value = true; error.value = '';
  try { const updated = await request<ProjectKey>(`/api/settings/ai/keys/${key.id}/revoke`,{}); keys.value = keys.value.map(k => k.id === updated.id ? updated:k); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '撤销失败'; }
  finally { busy.value = false; }
}
async function toggleNotifications() {
  if (!notifications.value || notificationsLoading.value || notificationBusy.value) return;
  notificationBusy.value = true;
  notificationsError.value = '';
  try {
    const response = await fetch('/api/notifications/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!notifications.value.enabled})});
    if (!response.ok) throw new Error('通知设置保存失败');
    notifications.value = await response.json() as NotificationSettings;
  } catch (reason) { notificationsError.value = reason instanceof Error ? reason.message : '保存失败'; }
  finally { notificationBusy.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (generated.value && !saved.value) event.preventDefault(); }
onBeforeRouteLeave(() => !generated.value || saved.value || window.confirm('Key 只显示一次。确定离开？未保存时需要重新生成。'));
onMounted(() => {
  void refresh();
  void refreshTargets();
  void refreshCredentials();
  void refreshNotifications();
  expiryTimer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
  window.addEventListener('beforeunload',beforeUnload);
});
onBeforeUnmount(() => {
  generated.value = undefined;
  if (expiryTimer !== undefined) window.clearInterval(expiryTimer);
  window.removeEventListener('beforeunload',beforeUnload);
});
</script>

<template>
  <main class="settings-page">
    <div class="settings-page-heading"><h1>配置</h1><p>管理调用凭据、可用设备与通知。</p></div>
    <div class="settings-grid">
    <section class="settings-card settings-ai">
      <div class="settings-heading"><div><h2>可用 AI 设备 <span class="settings-count">{{ visibleTargets.length }}</span></h2><p>复制设备 ID，供调用方选择目标设备。</p></div><button :disabled="targetsLoading" @click="refreshTargets">{{ targetsLoading ? '读取中…' : '刷新' }}</button></div>
      <p v-if="targetsError" class="settings-error" role="alert">{{ targetsError }}</p>
      <p v-else-if="targetsLoading && !targets.length" class="settings-empty" role="status">正在读取设备…</p>
      <p v-else-if="!visibleTargets.length" class="settings-empty">暂无可调用设备。请让 Mac 上线并开启 AI 服务，然后刷新。</p>
      <article v-for="target in visibleTargets" :key="target.deviceId" class="settings-device">
        <div class="settings-heading"><strong class="device-name">{{ target.name }}</strong><span class="device-state available">可调用</span></div>
        <div class="device-id"><code>{{ target.deviceId }}</code><button @click="copyDeviceId(target.deviceId)">复制设备 ID</button></div>
        <div v-for="provider in target.providers" :key="provider.provider" class="device-provider">
          <strong>{{ provider.provider }}</strong><small>{{ provider.workspaceEnabled ? '已授权工作目录' : '隔离执行' }} · 会话容量 {{ provider.capacity }}</small>
        </div>
      </article>
      <label v-if="copiedDeviceId" class="device-copy">设备 ID（可手动复制）<input ref="deviceIdField" :value="copiedDeviceId" readonly aria-label="设备 ID" @focus="deviceIdField?.select()"></label>
      <p v-if="message" class="settings-notice" role="status">{{ message }}</p>
      <small v-if="visibleTargets.length">可用状态以提交时检查为准，设备容量由各 Provider 共用。</small>
    </section>
    <section class="settings-card settings-keys">
      <div class="settings-heading"><div><h2>API Key <span class="settings-count">{{ visibleKeys.length }}</span></h2><p>用于调用 AI 和管理任务，仅交给可信调用方。</p></div><button :disabled="loading || busy" @click="refresh">{{ loading ? '读取中…' : '刷新' }}</button></div>
      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <div class="settings-actions"><button class="primary" type="button" :disabled="loading || busy || !!generated" @click="generate()">{{ busy ? '处理中…' : '生成 Key' }}</button></div>
      <div v-if="generated" class="settings-secret" role="region" aria-label="新生成的 API Key">
        <strong>新 API Key（只显示这一次）</strong>
        <textarea ref="secretField" :value="generated.apiKey" readonly aria-label="完整 API Key" spellcheck="false" autocomplete="off" autocapitalize="off" rows="2" @click="selectKey" />
        <div class="settings-actions"><button type="button" :disabled="copyingKey" @click="copyKey">{{ copyingKey ? '复制中…' : keyCopyState === 'copied' ? '已复制 · 再次复制' : '复制完整 Key' }}</button><button type="button" @click="selectKey">全选手动复制</button></div>
        <p v-if="keyCopyMessage" class="key-copy-result" :class="{ 'copy-warning': keyCopyState === 'manual' }" role="status" aria-live="polite">{{ keyCopyMessage }}</p>
            <small>请复制上方以 trai_ 开头的完整 {{ generated.apiKey.length }} 位 Key；下方列表中的管理标识不是 API Key。</small>
        <p>保存到项目后端的 TERMRELAY_API_KEY，不要放在前端、URL 或提交到 Git。替换 Key 时先更新项目配置，再撤销旧 Key。</p>
        <label class="settings-check"><input v-model="saved" type="checkbox">我已保存 Key</label>
        <button :disabled="!saved" @click="generated = undefined; message = ''">关闭显示</button>
      </div>
      <small class="key-list-note">下方仅显示管理标识；完整 Key 只在生成时显示一次。</small>
      <p v-if="loading && !keys.length" class="settings-empty" role="status">正在读取 Key…</p>
      <p v-else-if="!visibleKeys.length && !error" class="settings-empty">暂无有效 Key。生成后复制到调用方的后端配置。</p>
      <article v-for="key in visibleKeys" :key="key.id" class="settings-key">
        <div><strong>Key {{ key.id.slice(0,8) }}</strong><small v-if="key.legacy" class="settings-warning">旧版受限 Key，仅可查询原有资源；请生成替换 Key。</small></div>
        <div class="settings-actions"><button :disabled="loading || busy || !!generated" @click="generate(key)">替换</button><button class="danger" :disabled="loading || busy || !!generated" @click="revoke(key)">撤销</button></div>
      </article>
    </section>
    <section class="settings-card settings-access">
      <div class="settings-heading"><div><h2>Mac 授权 <span class="settings-count">{{ visibleCredentials.length }}</span></h2><p>管理允许公网连接的 Mac。</p></div><button :disabled="credentialsLoading || !!revokingCredentialId" @click="refreshCredentials">{{ credentialsLoading ? '读取中…' : '刷新' }}</button></div>
      <p v-if="credentialsError" class="settings-error" role="alert">{{ credentialsError }}</p>
      <p v-else-if="credentialsLoading && !credentials.length" class="settings-empty" role="status">正在读取授权…</p>
      <p v-else-if="!visibleCredentials.length" class="settings-empty">暂无有效公网授权。局域网直连不需要配对。</p>
      <article v-for="credential in visibleCredentials" :key="credential.id" class="settings-key">
        <div><strong>{{ targets.find(target => target.deviceId === credential.deviceId)?.name || credential.deviceId }}</strong><small>{{ credential.approvedBy }} · 最近连接：{{ displayDate(credential.lastUsedAt) }}</small><small v-if="credential.expiresAt">到期：{{ displayDate(credential.expiresAt) }}</small><details><summary>设备 ID</summary><code>{{ credential.deviceId }}</code></details></div>
        <button class="danger" :disabled="credentialsLoading || !!revokingCredentialId" @click="revokeCredential(credential)">{{ revokingCredentialId === credential.id ? '撤销中…' : '撤销' }}</button>
      </article>
    </section>
    <section class="settings-card settings-notifications">
      <div class="settings-heading"><div><h2>审批通知</h2><p>需要人工审批时推送到手机。</p></div><button :disabled="notificationsLoading || notificationBusy" @click="refreshNotifications">{{ notificationsLoading ? '读取中…' : '刷新' }}</button></div>
      <p v-if="notificationsError" class="settings-error" role="alert">{{ notificationsError }}</p>
      <p v-if="notificationsLoading && !notifications" class="settings-empty" role="status">正在读取通知配置…</p>
      <div v-if="notifications" class="notification-setting"><div><strong>{{ !notifications.configured ? '服务未配置' : notifications.enabled ? '已开启' : '已关闭' }}</strong><small v-if="!notifications.configured">请在 Server 环境中配置 Bark 服务。</small></div><button role="switch" :aria-checked="notifications.enabled" aria-label="审批通知" :disabled="notificationsLoading || notificationBusy || (!notifications.configured && !notifications.enabled)" @click="toggleNotifications">{{ notificationBusy ? '保存中…' : notifications.enabled ? '关闭通知' : '开启通知' }}</button></div>
    </section>
    </div>
  </main>
</template>

<style scoped>
.settings-page { width: 100%; max-width: 1160px; margin: 0 auto; padding: 32px clamp(16px, 3vw, 36px); overflow: auto; flex: 1; min-height: 0; }
.settings-page-heading { margin-bottom: 24px; }
.settings-page-heading h1 { font-size: 24px; letter-spacing: -.03em; }
.settings-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.settings-keys { grid-column: 1; grid-row: 1 / 3; }
.settings-ai { grid-column: 2; grid-row: 1; }
.settings-notifications { grid-column: 2; grid-row: 2; }
.settings-access { grid-column: 1 / -1; }
.settings-heading, .settings-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.settings-heading { margin-bottom: 18px; }
.settings-heading > div:first-child { min-width: 0; flex: 1; }
h1, h2 { margin: 0 0 8px; }
h2 { font-size: 15px; }
p { line-height: 1.6; color: #91a0ae; font-size: 13px; }
.settings-card { min-width: 0; border: 1px solid #27313d; border-radius: 14px; padding: 22px; background: #10161d; }
.settings-count { margin-left: 5px; padding: 2px 7px; border-radius: 5px; color: #8493a3; background: #1c2630; font-size: 11px; font-weight: 500; }
.settings-empty { padding: 16px 0; }
.settings-notice { margin-top: 12px; color: #8ed9b9; }
textarea { width: 100%; box-sizing: border-box; padding: 10px; color: inherit; background: #172337; border: 1px solid #475569; border-radius: 6px; }
.settings-check { display: flex; align-items: center; gap: 8px; padding: 6px 0; overflow-wrap: anywhere; }
.settings-secret { background: #182d36; border: 1px solid #4b9e86; padding: 16px; border-radius: 8px; margin-top: 20px; }
.key-copy-result { color: #8ed9b9; }
.key-copy-result.copy-warning { color: #ffd18a; }
textarea { margin: 12px 0; font-family: monospace; resize: vertical; }
.key-list-note { margin: 18px 0 12px; }
.settings-key { border-top: 1px solid #27313d; padding: 16px 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; overflow-wrap: anywhere; font-size: 13px; }
.settings-key:last-child { padding-bottom: 0; }
.settings-key > div:first-child { min-width: 0; flex: 1; }
small { display: block; margin-top: 6px; color: #8493a3; font-size: 12px; line-height: 1.6; }
.settings-error { color: #ffb4b4; margin-bottom: 12px; }
.settings-warning { color: #ffd18a; }
.settings-device { padding: 16px 0; border-top: 1px solid #27313d; }
.settings-device .settings-heading { margin-bottom: 0; }
.device-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.device-state { font-size: 12px; padding: 4px 8px; border-radius: 6px; background: #253247; color: #a9b4c4; }
.device-state.available { background: #183a32; color: #8ed9b9; }
.device-id { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
.device-id code { min-width: 0; max-width: 100%; overflow-wrap: anywhere; font-size: 12px; }
.device-provider { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 10px 12px; margin-top: 8px; background: #17212b; border-radius: 8px; font-size: 13px; }
.device-provider small { margin: 0; }
.device-copy { display: block; margin: 12px 0; color: #a9b4c4; }
.device-copy input { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px; color: inherit; background: #172337; border: 1px solid #475569; border-radius: 6px; font-family: monospace; }
details { margin-top: 8px; color: #8493a3; font-size: 12px; }
summary { cursor: pointer; }
details code { display: block; padding-top: 6px; overflow-wrap: anywhere; }
.notification-setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
button { padding: 8px 12px; border: 1px solid #344251; border-radius: 7px; background: #19222c; color: #b9c5d0; cursor: pointer; font-size: 12px; }
button:hover:not(:disabled) { border-color: #72e0a5; color: #72e0a5; }
button.primary { background: #72e0a5; border-color: #72e0a5; color: #0b2015; font-weight: 600; }
button.primary:hover:not(:disabled) { background: #91edba; color: #0b2015; }
button.danger { border-color: #63383c; color: #f2a1a8; background: #21171a; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #72e0a5; outline-offset: 3px; }
@media (max-width: 760px) {
  .settings-page { padding: 20px 14px max(20px, env(safe-area-inset-bottom)); }
  .settings-page-heading { margin-bottom: 20px; }
  .settings-grid { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .settings-card { grid-column: auto; grid-row: auto; padding: 16px; }
  .settings-keys { order: -1; }
  .settings-notifications { order: 1; }
  button { min-height: 40px; }
}
</style>
