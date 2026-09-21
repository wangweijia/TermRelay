<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

interface PairingSummary {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  createdAt: string;
  expiresAt: string;
}

const code = ref(new URLSearchParams(window.location.search).get('code') ?? '');
const pairing = ref<PairingSummary>();
const loading = ref(false);
const deciding = ref(false);
const error = ref<string>();
const normalizedCode = computed(() => code.value.trim().toUpperCase());
const canDecide = computed(() => pairing.value?.status === 'pending' && !deciding.value);

async function loadPairing(): Promise<void> {
  if (!normalizedCode.value) return;
  loading.value = true;
  error.value = undefined;
  pairing.value = undefined;
  try {
    const response = await fetch(`/api/client-approvals?code=${encodeURIComponent(normalizedCode.value)}`);
    if (!response.ok) throw new Error(response.status === 404 ? '找不到此授权请求' : '无法读取授权请求');
    pairing.value = await response.json() as PairingSummary;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法读取授权请求';
  } finally {
    loading.value = false;
  }
}

async function decide(decision: 'approve' | 'deny'): Promise<void> {
  if (!canDecide.value) return;
  deciding.value = true;
  error.value = undefined;
  try {
    const response = await fetch('/api/client-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalizedCode.value, decision }),
    });
    if (!response.ok) throw new Error('授权请求已失效或无法更新');
    pairing.value = await response.json() as PairingSummary;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法更新授权请求';
  } finally {
    deciding.value = false;
  }
}

onMounted(() => {
  if (normalizedCode.value) void loadPairing();
});
</script>

<template>
  <main class="authorize-page">
    <section class="authorize-panel" aria-labelledby="authorize-title">
      <div class="authorize-heading">
        <small>MAC CLIENT</small>
        <h1 id="authorize-title">授权这台 Mac</h1>
        <p>确认设备信息与 TermRelay App 中显示的请求一致。</p>
      </div>

      <form v-if="!pairing" class="code-form" @submit.prevent="loadPairing">
        <label for="pairing-code">配对码</label>
        <div>
          <input
            id="pairing-code"
            v-model="code"
            autocomplete="one-time-code"
            maxlength="9"
            placeholder="ABCD-EFGH"
          >
          <button type="submit" :disabled="loading || !normalizedCode">{{ loading ? '查询中' : '查询' }}</button>
        </div>
      </form>

      <div v-else class="device-summary">
        <div class="device-mark" aria-hidden="true">M</div>
        <div>
          <small>设备名称</small>
          <strong>{{ pairing.deviceName }}</strong>
        </div>
        <dl>
          <div><dt>设备 ID</dt><dd>{{ pairing.deviceId }}</dd></div>
          <div><dt>App 版本</dt><dd>{{ pairing.appVersion }}</dd></div>
          <div><dt>配对码</dt><dd>{{ normalizedCode }}</dd></div>
        </dl>
      </div>

      <p v-if="error" class="authorize-error" role="alert">{{ error }}</p>

      <div v-if="pairing?.status === 'pending'" class="authorize-actions">
        <button type="button" :disabled="!canDecide" @click="decide('deny')">拒绝</button>
        <button type="button" class="approve" :disabled="!canDecide" @click="decide('approve')">授权设备</button>
      </div>
      <div v-else-if="pairing" class="decision-state" :data-status="pairing.status">
        {{ pairing.status === 'approved' ? '已授权，可以返回 TermRelay App。' :
          pairing.status === 'denied' ? '已拒绝此设备。' :
            pairing.status === 'consumed' ? '此授权已由 App 使用。' : '此授权请求已过期。' }}
      </div>
    </section>
  </main>
</template>

<style scoped>
.authorize-page {
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  place-items: center;
  padding: 24px;
  overflow: auto;
  background:
    linear-gradient(90deg, rgb(114 224 165 / 5%) 1px, transparent 1px),
    linear-gradient(rgb(114 224 165 / 5%) 1px, transparent 1px),
    #0b0f14;
  background-size: 32px 32px;
}
.authorize-panel { width: min(520px, 100%); border-top: 3px solid #72e0a5; padding: 30px; background: #121920; box-shadow: 0 30px 90px rgb(0 0 0 / 45%); }
.authorize-heading small { color: #72e0a5; font: 700 11px/1 ui-monospace, monospace; letter-spacing: .12em; }
.authorize-heading h1 { margin: 9px 0 7px; color: #edf4f8; font-size: 28px; letter-spacing: 0; }
.authorize-heading p { font-size: 13px; }
.code-form { display: grid; gap: 8px; margin-top: 28px; }
.code-form label { color: #aab7c3; font-size: 12px; }
.code-form > div { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.code-form input { min-width: 0; padding: 12px; border: 1px solid #354352; border-radius: 6px; color: #edf4f8; background: #0b1117; font: 17px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.code-form button, .authorize-actions button { padding: 10px 16px; border: 1px solid #3c4b59; border-radius: 6px; color: #c9d4de; background: #19232d; cursor: pointer; }
.device-summary { display: grid; grid-template-columns: 52px 1fr; gap: 12px 14px; margin-top: 28px; padding: 18px; border: 1px solid #2c3945; background: #0d1319; }
.device-mark { display: grid; width: 52px; height: 52px; place-items: center; border: 1px solid #367458; border-radius: 8px; color: #72e0a5; background: #13271e; font: 700 22px/1 ui-monospace, monospace; }
.device-summary > div:nth-child(2) { display: grid; align-content: center; gap: 5px; min-width: 0; }
.device-summary small, dt { color: #748393; font-size: 11px; }
.device-summary strong { overflow-wrap: anywhere; font-size: 18px; }
.device-summary dl { grid-column: 1 / -1; display: grid; gap: 9px; margin: 8px 0 0; }
.device-summary dl div { display: grid; grid-template-columns: 80px 1fr; gap: 10px; }
.device-summary dd { margin: 0; color: #c6d0da; font: 12px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
.authorize-error { margin-top: 16px; color: #ff9ca3; font-size: 13px; }
.authorize-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 24px; }
.authorize-actions button.approve { border-color: #3d9369; color: #092015; background: #72e0a5; font-weight: 700; }
.authorize-actions button:disabled, .code-form button:disabled { opacity: .5; cursor: wait; }
.decision-state { margin-top: 22px; padding: 13px; border-left: 3px solid #6f7e8d; color: #b8c4cf; background: #0d1319; }
.decision-state[data-status="approved"] { border-color: #72e0a5; color: #b9f3d3; }
.decision-state[data-status="denied"] { border-color: #ef737d; color: #f6b2b7; }
@media (max-width: 560px) {
  .authorize-page { place-items: start center; padding: 16px; }
  .authorize-panel { padding: 23px 18px; }
  .code-form > div { grid-template-columns: 1fr; }
  .code-form button { width: 100%; }
}
</style>