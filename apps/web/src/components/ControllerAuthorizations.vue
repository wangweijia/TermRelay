<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

interface Pairing { id: string; installationId: string; deviceName: string; appVersion: string; createdAt: string }
interface Credential { id: string; installationId: string; deviceName: string; deviceIds: string[]; approvedBy: string; lastUsedAt: string | null; revokedAt: string | null; expiresAt: null }
interface Device { id: string; name: string; status: string }
const pending = ref<Pairing[]>([]);
const credentials = ref<Credential[]>([]);
const devices = ref<Device[]>([]);
const selected = ref<Record<string, string[]>>({});
const busy = ref(false);
const error = ref('');
const loading = ref(false);
const active = computed(() => credentials.value.filter(item => !item.revokedAt));
let timer: number | undefined;
let disposed = false;

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TermRelay-Settings': '1' }, body: JSON.stringify(body),
  }) });
  if (!response.ok) throw new Error(response.status === 404 ? '请求已失效，请刷新。' : `掌机授权操作失败（${response.status}）`);
  return response.json() as Promise<T>;
}
async function refresh() {
  if (loading.value || busy.value || disposed) return;
  loading.value = true;
  try {
    const [nextPending, nextCredentials, nextDevices] = await Promise.all([
      request<Pairing[]>('/api/controller-approvals'), request<Credential[]>('/api/controller-credentials'), request<Device[]>('/api/devices'),
    ]);
    if (disposed) return;
    pending.value = nextPending; credentials.value = nextCredentials; devices.value = nextDevices;
    const nextSelected: Record<string, string[]> = {};
    for (const item of nextPending) nextSelected[item.id] = (selected.value[item.id] ?? []).filter(id => nextDevices.some(device => device.id === id));
    selected.value = nextSelected;
    error.value = '';
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '读取掌机授权失败'; }
  finally { loading.value = false; }
}
async function decide(item: Pairing, decision: 'approve' | 'deny') {
  if (busy.value || loading.value || (decision === 'approve' && !selected.value[item.id]?.length)) return;
  if (decision === 'approve' && !window.confirm(`授权“${item.deviceName}”访问选中的 ${selected.value[item.id]?.length} 台设备？请确认这是你刚发起的请求。`)) return;
  busy.value = true; error.value = '';
  try {
    await request('/api/controller-approvals', { pairingId: item.id, decision, deviceIds: decision === 'approve' ? selected.value[item.id] : [] });
    pending.value = pending.value.filter(pairing => pairing.id !== item.id);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '更新授权失败'; }
  finally { busy.value = false; }
  if (!error.value) await refresh();
}
async function revoke(item: Credential) {
  if (busy.value || loading.value || !window.confirm(`删除“${item.deviceName}”的授权？在线掌机将断开，需要重新授权。`)) return;
  busy.value = true; error.value = '';
  try {
    await request(`/api/controller-credentials/${encodeURIComponent(item.id)}/revoke`, {});
    credentials.value = credentials.value.filter(credential => credential.id !== item.id);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '删除授权失败'; }
  finally { busy.value = false; }
}
onMounted(() => { void refresh(); timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000); });
onBeforeUnmount(() => { disposed = true; if (timer !== undefined) window.clearInterval(timer); });
</script>

<template>
  <section class="controller-access" aria-labelledby="controller-title">
    <header><h2 id="controller-title">掌机授权 <small>{{ active.length }}</small></h2><button type="button" title="刷新掌机授权" aria-label="刷新掌机授权" :disabled="loading || busy" @click="refresh">↻</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="loading && !pending.length && !active.length" role="status">读取中…</p>
    <h3>待授权 <small>{{ pending.length }}</small></h3>
    <p v-if="!pending.length">暂无待授权掌机</p>
    <article v-for="item in pending" :key="item.id">
      <div class="identity"><strong>{{ item.deviceName }}</strong><small>版本 {{ item.appVersion }} · {{ new Date(item.createdAt).toLocaleString() }}</small><code>{{ item.installationId }}</code></div>
      <fieldset :disabled="busy || loading"><legend>允许访问的设备</legend><p v-if="!devices.length">暂无设备</p><label v-for="device in devices" :key="device.id"><input v-model="selected[item.id]" type="checkbox" :value="device.id"><span>{{ device.name }} <small>{{ device.status }}</small><code>{{ device.id }}</code></span></label></fieldset>
      <footer><button type="button" :disabled="busy || loading" @click="decide(item, 'deny')">拒绝</button><button type="button" class="approve" :disabled="busy || loading || !selected[item.id]?.length" @click="decide(item, 'approve')">授权</button></footer>
    </article>
    <h3>已授权掌机 <small>{{ active.length }}</small></h3>
    <p v-if="!active.length">暂无已授权掌机</p>
    <article v-for="item in active" :key="item.id">
      <div class="identity"><strong>{{ item.deviceName }}</strong><small>永久有效 · {{ item.approvedBy }}</small><small>最近连接：{{ item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : '尚未连接' }}</small><code>{{ item.installationId }}</code></div>
      <ul><li v-for="id in item.deviceIds" :key="id">{{ devices.find(device => device.id === id)?.name ?? id }}</li></ul>
      <footer><button type="button" class="danger" :disabled="busy || loading" @click="revoke(item)">删除授权</button></footer>
    </article>
  </section>
</template>

<style scoped>
.controller-access { grid-column: 1 / -1; min-width: 0; border-top: 1px solid #344251; padding: 22px 0; color: #c4cfda; }
header, footer { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
h2 { font-size: 15px; margin: 0; } h3 { font-size: 13px; margin: 22px 0 12px; }
small, p { color: #91a0ae; font-size: 12px; } small { font-weight: normal; }
article { border-top: 1px solid #27313d; padding: 16px 0; overflow-wrap: anywhere; }
.identity { display: grid; gap: 5px; font-size: 13px; } code { display: block; color: #91a0ae; font-size: 11px; overflow-wrap: anywhere; }
fieldset { margin: 14px 0; padding: 10px 0; border: 0; font-size: 12px; }
label { display: flex; gap: 8px; align-items: start; padding: 6px 0; } label input { margin-top: 3px; }
ul { padding-left: 18px; font-size: 12px; } footer { justify-content: end; }
button { padding: 8px 12px; border: 1px solid #344251; border-radius: 6px; background: #19222c; color: #b9c5d0; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; } button:focus-visible { outline: 2px solid #72e0a5; }
.approve { background: #72e0a5; color: #0b2015; border-color: #72e0a5; } .danger, .error { color: #f2a1a8; }
</style>