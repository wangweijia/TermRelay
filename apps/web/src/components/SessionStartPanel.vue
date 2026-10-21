<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionStartPayload } from '@termrelay/contracts';
import { createUuid } from '../uuid';
import { useRelayStore } from '../stores/relay';

interface Target {
  deviceId: string;
  workspaceId: string;
  displayName: string;
  launchOptions: { toolKey: string; runtimeMode: 'pty' | 'acp' }[];
}
interface Submission extends SessionStartPayload { requestId: string; deviceId: string }
interface Result {
  id: string;
  status: 'pending' | 'accepted' | 'completed' | 'failed' | 'unknown';
  message: string | null;
}

const emit = defineEmits<{ created: [sessionId: string] }>();
const relay = useRelayStore();
const targets = ref<Target[]>([]);
const targetId = ref('');
const optionKey = ref('');
const name = ref('');
const busy = ref(false);
const error = ref<string>();
const result = ref<Result>();
const pending = ref<Submission>();
const storageKey = 'termrelay.session-start.pending.v1';
const target = computed(() => targets.value.find(t => `${t.deviceId}/${t.workspaceId}` === targetId.value));
const selectedOption = computed(() => target.value?.launchOptions.find(o => `${o.toolKey}/${o.runtimeMode}` === optionKey.value));
const labels: Record<Result['status'], string> = {
  pending: '等待设备创建', accepted: '设备正在启动', completed: '会话已创建', failed: '创建失败', unknown: '创建结果未知',
};
let timer: number | undefined;
let disposed = false;

watch(target, value => { optionKey.value = value?.launchOptions[0] ? `${value.launchOptions[0].toolKey}/${value.launchOptions[0].runtimeMode}` : ''; });

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body: unknown = await response.json();
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function refreshTargets(): Promise<void> {
  try {
    targets.value = await request<Target[]>('/api/session-starts/targets');
    if (!targets.value.some(t => `${t.deviceId}/${t.workspaceId}` === targetId.value)) {
      const first = targets.value[0];
      targetId.value = first ? `${first.deviceId}/${first.workspaceId}` : '';
    }
  } catch (failure) { error.value = String(failure); }
}

async function applyResult(value: Result): Promise<void> {
  result.value = value;
  if (value.status === 'completed') {
    await relay.refreshSessions();
    await relay.selectSession(value.id);
    window.localStorage.removeItem(storageKey);
    pending.value = undefined;
    emit('created', value.id);
  } else if (value.status === 'failed') {
    error.value = `创建失败：${value.message ?? '设备未能启动会话，请检查本机配置和日志'}`;
    window.localStorage.removeItem(storageKey);
    pending.value = undefined;
  } else if (!disposed && value.status !== 'unknown') {
    timer = window.setTimeout(() => void query(), 1000);
  }
}

async function query(): Promise<void> {
  if (!pending.value || busy.value || disposed) return;
  if (timer !== undefined) window.clearTimeout(timer);
  busy.value = true;
  error.value = undefined;
  try {
    await applyResult(await request<Result>(`/api/session-starts/${pending.value.requestId}`));
  } catch (failure) {
    error.value = `无法确认创建结果：${String(failure)}。保留原请求 ID，请查询或重新提交同一请求，不要重复新建。`;
  } finally { busy.value = false; }
}

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    if (!pending.value) {
      const selected = selectedOption.value;
      if (!target.value || !selected) throw new Error('请选择已授权的在线设备、工作区和工具');
      const submission: Submission = {
        requestId: createUuid(), deviceId: target.value.deviceId, workspaceId: target.value.workspaceId,
        ...selected, ...(selected.runtimeMode === 'pty' ? { rows: 24, columns: 80 } : {}),
        ...(name.value.trim() ? { displayName: name.value.trim() } : {}),
      };
      window.localStorage.setItem(storageKey, JSON.stringify(submission));
      pending.value = submission;
    }
    await applyResult(await request<Result>('/api/session-starts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.value),
    }));
  } catch (failure) {
    error.value = String(failure);
  } finally { busy.value = false; }
}

function acknowledgeUnknown(): void {
  if (!window.confirm('请先核实会话列表。放下此请求不会取消设备上的启动或进程，继续新建可能产生另一个会话。')) return;
  try {
    window.localStorage.removeItem(storageKey);
    pending.value = undefined;
    result.value = undefined;
    error.value = undefined;
  } catch (failure) { error.value = String(failure); }
}

onMounted(async () => {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      const value: unknown = JSON.parse(saved);
      if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string'
        || !/^[0-9a-f-]{36}$/iu.test(value.requestId) || !('deviceId' in value) || typeof value.deviceId !== 'string'
        || !('workspaceId' in value) || typeof value.workspaceId !== 'string'
        || !('toolKey' in value) || typeof value.toolKey !== 'string'
        || !('runtimeMode' in value) || !['pty', 'acp'].includes(String(value.runtimeMode))
        || (value.runtimeMode === 'pty' && (!('rows' in value) || typeof value.rows !== 'number'
          || !('columns' in value) || typeof value.columns !== 'number'))) throw new Error('本地创建请求无法读取；请先核实会话列表并清理浏览器中的待处理请求');
      pending.value = value as Submission;
      await query();
    }
  } catch (failure) { error.value = String(failure); busy.value = true; }
  await refreshTargets();
});
onBeforeUnmount(() => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); });
</script>

<template>
  <section class="session-start-panel">
    <h2>远程创建会话</h2>
    <p>执行机器主动连接 Server，仅能选择本机明确授权的目录；默认手动审批，不自动发送提示词。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="!pending">
      <label>设备 / 工作区
        <select v-model="targetId" :disabled="busy">
          <option v-for="item in targets" :key="`${item.deviceId}/${item.workspaceId}`" :value="`${item.deviceId}/${item.workspaceId}`">
            {{ relay.devices.find(d => d.id === item.deviceId)?.name ?? item.deviceId }} · {{ item.displayName }}
          </option>
        </select>
      </label>
      <label>工具 / 模式
        <select v-model="optionKey" :disabled="busy">
          <option v-for="option in target?.launchOptions ?? []" :key="`${option.toolKey}/${option.runtimeMode}`" :value="`${option.toolKey}/${option.runtimeMode}`">
            {{ option.toolKey }} · {{ option.runtimeMode.toUpperCase() }}
          </option>
        </select>
      </label>
      <label>会话名称（可选）<input v-model="name" maxlength="128" :disabled="busy"></label>
      <p v-if="!targets.length">没有已授权的在线工作区。Mac 请在“新建会话”勾选目录授权；Linux 使用 workspace remote-start 授权并重启 Agent。</p>
      <button type="button" :disabled="busy || !selectedOption" @click="submit">{{ busy ? '提交中…' : '创建会话' }}</button>
      <button type="button" :disabled="busy" @click="refreshTargets">刷新可用工作区</button>
    </template>
    <template v-else>
      <strong>{{ result ? labels[result.status] : '请求已保存，等待确认' }}</strong>
      <p>{{ result?.message }}</p>
      <code>{{ pending.requestId }}</code>
      <p>相同请求只创建一次。超时、断线不代表进程停止，也不会自动重新执行。</p>
      <button type="button" :disabled="busy" @click="query">查询原请求</button>
      <button type="button" :disabled="busy" @click="submit">重新提交同一请求</button>
      <button type="button" :disabled="busy" @click="acknowledgeUnknown">已核实，放下此请求</button>
    </template>
  </section>
</template>

<style scoped>
.session-start-panel { display: grid; gap: 14px; padding: 18px; overflow-wrap: anywhere; }
.session-start-panel h2, .session-start-panel p { margin: 0; }
.session-start-panel label { display: grid; gap: 6px; }
.session-start-panel select, .session-start-panel input { width: 100%; min-width: 0; padding: 10px; color: inherit; background: var(--panel-bg, #171b24); border: 1px solid #495162; border-radius: 6px; }
.session-start-panel [role="alert"] { color: #f59e9e; }
</style>
