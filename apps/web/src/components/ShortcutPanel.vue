<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

interface Shortcut {
  id: string;
  deviceId: string;
  revision: number;
  name: string;
  description: string;
  workspaceId: string;
  proxyMode: 'inherit' | 'disabled' | 'custom';
  requiresConfirmation: boolean;
  online: boolean;
}

interface ShortcutRun {
  id: string;
  shortcutId: string;
  deviceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  output: string;
  createdAt: string;
  updatedAt: string;
}

interface PendingSubmission {
  runId: string;
  shortcutId: string;
  name: string;
}

const pendingKey = 'termrelay.shortcut.pending-run.v1';
let storageAvailable = true;
function readPending(): PendingSubmission | undefined {
  try {
    const saved = window.localStorage.getItem(pendingKey);
    if (!saved) return undefined;
    const value: unknown = JSON.parse(saved);
    if (typeof value === 'object' && value !== null &&
      'runId' in value && typeof value.runId === 'string' &&
      'shortcutId' in value && typeof value.shortcutId === 'string' &&
      'name' in value && typeof value.name === 'string') return value as PendingSubmission;
  } catch {
    // An unreadable pending ID must not be replaced with a fresh one.
  }
  storageAvailable = false;
  return undefined;
}

const props = defineProps<{ active: boolean }>();
const shortcuts = ref<Shortcut[]>([]);
const recentRuns = ref<ShortcutRun[]>([]);
const selectedId = ref<string>();
const loading = ref(false);
const busy = ref(false);
const error = ref<string>();
const refreshError = ref<string>();
const run = ref<ShortcutRun>();
const runName = ref<string>();
const pending = ref<PendingSubmission | undefined>(readPending());
const selected = computed(() => shortcuts.value.find((item) => item.id === selectedId.value));
const running = computed(() => run.value?.status === 'queued' || run.value?.status === 'running');
function activeFor(shortcutId: string): boolean {
  return recentRuns.value.some((item) =>
    item.shortcutId === shortcutId && (item.status === 'queued' || item.status === 'running'));
}
const proxyLabels: Record<Shortcut['proxyMode'], string> = {
  inherit: '继承 Mac 设置',
  disabled: '不使用代理',
  custom: 'Mac 自定义代理',
};
const statusLabels: Record<ShortcutRun['status'], string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
let pollTimer: number | undefined;
let generation = 0;
let pollVersion = 0;
let disposed = false;
let refreshVersion = 0;

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const detail = typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined;
    const text = typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.filter((item): item is string => typeof item === 'string').join('；') : '';
    throw new Error(text ? `${text} (${response.status})` : `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : '请求失败，请稍后重试';
}

async function refresh(): Promise<void> {
  const current = generation;
  const version = ++refreshVersion;
  loading.value = true;
  refreshError.value = undefined;
  const [catalog, history] = await Promise.allSettled([
    request<Shortcut[]>('/api/shortcuts'),
    request<ShortcutRun[]>('/api/shortcuts/runs?limit=20'),
  ]);
  if (current !== generation || version !== refreshVersion) return;
  const failures: string[] = [];
  if (catalog.status === 'fulfilled') {
    shortcuts.value = catalog.value;
    if (!catalog.value.some((item) => item.id === selectedId.value)) selectedId.value = catalog.value[0]?.id;
  } else {
    failures.push(`读取快捷任务失败：${message(catalog.reason)}`);
  }
  if (history.status === 'fulfilled') {
    const confirmed = pending.value && history.value.find((item) =>
      item.id === pending.value?.runId && item.shortcutId === pending.value.shortcutId);
    if (confirmed && !busy.value) {
      const submission = pending.value!;
      try {
        if (readPending()?.runId === submission.runId) {
          window.localStorage.removeItem(pendingKey);
          pending.value = undefined;
          error.value = undefined;
          selectRun(confirmed);
          runName.value = submission.name;
        }
      } catch {
        error.value = '运行记录已找到，但无法清除待确认记录；请勿启动新任务。';
      }
    }
    const currentRun = run.value;
    const fresher = currentRun && history.value.find((item) =>
      item.id === currentRun.id && item.updatedAt > currentRun.updatedAt);
    if (fresher) selectRun(fresher);
    const selectedRun = run.value;
    recentRuns.value = (selectedRun && !history.value.some((item) => item.id === selectedRun.id)
      ? [selectedRun, ...history.value] : history.value.map((item) =>
        item.id === selectedRun?.id ? selectedRun : item)).slice(0, 20);
    if (!selectedRun && recentRuns.value.length) selectRun(recentRuns.value[0]!);
  } else {
    failures.push(`读取最近运行失败：${message(history.reason)}`);
  }
  refreshError.value = failures.join('；') || undefined;
  loading.value = false;
}

function rememberRun(updated: ShortcutRun): void {
  recentRuns.value = [updated, ...recentRuns.value.filter((item) => item.id !== updated.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
}

function selectRun(selectedRun: ShortcutRun): void {
  pollVersion++;
  stopPolling();
  run.value = selectedRun;
  runName.value = shortcuts.value.find((item) => item.id === selectedRun.shortcutId)?.name
    ?? (pending.value?.shortcutId === selectedRun.shortcutId ? pending.value.name : selectedRun.shortcutId);
  schedulePoll();
}

function schedulePoll(): void {
  stopPolling();
  if (props.active && running.value) {
    pollTimer = window.setTimeout(() => void poll(), 2000);
  }
}

async function poll(): Promise<void> {
  const current = generation;
  const version = pollVersion;
  const id = run.value?.id;
  if (!props.active || !id || !running.value || busy.value) return;
  try {
    const updated = await request<ShortcutRun>(`/api/shortcuts/runs/${encodeURIComponent(id)}`);
    if (current !== generation || version !== pollVersion || run.value?.id !== id) return;
    run.value = updated;
    rememberRun(updated);
    error.value = undefined;
  } catch (reason) {
    if (current === generation && version === pollVersion) error.value = `更新运行状态失败：${message(reason)}`;
  }
  if (current === generation && version === pollVersion) schedulePoll();
}

async function start(shortcut: Shortcut): Promise<void> {
  if (busy.value || activeFor(shortcut.id) || pending.value || !shortcut.online) return;
  const warning = `确认在 Mac「${shortcut.deviceId}」的工作区「${shortcut.workspaceId}」运行“${shortcut.name}”？\n代理：${proxyLabels[shortcut.proxyMode]}。${shortcut.requiresConfirmation ? '\n此任务要求每次运行前确认。' : ''}`;
  if (!window.confirm(warning)) return;
  const existing = readPending();
  if (existing) {
    pending.value = existing;
    error.value = '已有待确认的提交，请先用原运行 ID 重试或明确放弃。';
    return;
  }
  if (!storageAvailable) {
    error.value = '无法安全保存运行 ID，请启用浏览器本地存储后重试。';
    return;
  }
  const submission = { runId: window.crypto.randomUUID(), shortcutId: shortcut.id, name: shortcut.name };
  try {
    window.localStorage.setItem(pendingKey, JSON.stringify(submission));
  } catch {
    error.value = '无法安全保存运行 ID，任务未提交。';
    return;
  }
  pending.value = submission;
  await submitPending();
}

async function submitPending(): Promise<void> {
  const submission = pending.value;
  if (!submission || busy.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    const created = await request<ShortcutRun>(`/api/shortcuts/${encodeURIComponent(submission.shortcutId)}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: submission.runId }),
    });
    if (disposed) return;
    runName.value = submission.name;
    run.value = created;
    rememberRun(created);
    schedulePoll();
    try {
      if (readPending()?.runId === submission.runId) window.localStorage.removeItem(pendingKey);
      pending.value = undefined;
    } catch {
      error.value = '运行已返回，但无法清除待确认记录；请勿启动新任务。';
    }
  } catch (reason) {
    if (!disposed) error.value = `提交结果不确定：${message(reason)}。请使用同一运行 ID 重试，或明确放弃。`;
  } finally {
    if (!disposed) busy.value = false;
  }
}

function abandonPending(): void {
  if (!pending.value || busy.value || !window.confirm('请求可能已经在 Mac 上执行。确定放弃追踪此次提交？放弃后再运行会创建新的任务。')) return;
  try {
    const current = readPending();
    if (current && current.runId !== pending.value.runId) {
      pending.value = current;
      error.value = '另一页面有新的待确认提交，请先处理该运行 ID。';
      return;
    }
    window.localStorage.removeItem(pendingKey);
    pending.value = undefined;
    error.value = undefined;
  } catch {
    error.value = '无法清除待确认记录，请勿启动新任务。';
  }
}

async function cancel(): Promise<void> {
  if (!run.value || !running.value || busy.value) return;
  const id = run.value.id;
  pollVersion++;
  stopPolling();
  busy.value = true;
  error.value = undefined;
  try {
    const updated = await request<ShortcutRun>(`/api/shortcuts/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    if (disposed || run.value?.id !== id) return;
    run.value = updated;
    rememberRun(updated);
    schedulePoll();
  } catch (reason) {
    if (!disposed) error.value = `取消运行失败：${message(reason)}`;
  } finally {
    if (!disposed) {
      busy.value = false;
      schedulePoll();
    }
  }
}

watch(() => props.active, (active) => {
  generation++;
  pollVersion++;
  stopPolling();
  loading.value = false;
  if (active) {
    void refresh();
    schedulePoll();
  }
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  stopPolling();
});
</script>

<template>
  <section class="shortcut-panel" aria-label="快捷任务">
    <div class="shortcut-heading">
      <div><small>SHORTCUTS</small><strong>快捷任务</strong></div>
      <button type="button" :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>
    <div class="shortcut-scroll">
      <p v-if="error" class="shortcut-error" role="alert">{{ error }}</p>
      <p v-if="refreshError" class="shortcut-error" role="alert">{{ refreshError }}</p>
      <p v-if="!storageAvailable" class="shortcut-error" role="alert">无法读取待确认的运行 ID；为避免重复执行，已禁用新任务。请恢复浏览器本地存储。</p>
      <div v-if="pending" class="shortcut-pending" role="status">
        <strong>待确认提交：{{ pending.name }}</strong>
        <span>运行 ID：{{ pending.runId }}。请求可能已执行，重试将使用同一 ID。</span>
        <div>
          <button type="button" :disabled="busy" @click="submitPending">{{ busy ? '确认中…' : '用相同 ID 重试' }}</button>
          <button type="button" :disabled="busy" @click="abandonPending">放弃追踪</button>
        </div>
      </div>
      <p v-if="loading && !shortcuts.length" class="shortcut-empty">正在读取快捷任务…</p>
      <p v-else-if="!shortcuts.length" class="shortcut-empty">暂无快捷任务。可在 Mac 上配置任务。</p>
      <div v-else class="shortcut-list">
        <button
          v-for="shortcut in shortcuts"
          :key="shortcut.id"
          type="button"
          class="shortcut-item"
          :class="{ selected: shortcut.id === selectedId }"
          :aria-pressed="shortcut.id === selectedId"
          @click="selectedId = shortcut.id"
        >
          <strong>{{ shortcut.name }}</strong><span :class="{ offline: !shortcut.online }">{{ shortcut.online ? '在线' : '离线' }}</span>
        </button>
      </div>
      <article v-if="selected" class="shortcut-detail">
        <h3>{{ selected.name }}</h3>
        <p>{{ selected.description || '无描述' }}</p>
        <dl>
          <dt>工作区</dt><dd>{{ selected.workspaceId }}</dd>
          <dt>目标 Mac</dt><dd>{{ selected.deviceId }}</dd>
          <dt>代理模式</dt><dd>{{ proxyLabels[selected.proxyMode] }}</dd>
          <dt>运行确认</dt><dd>{{ selected.requiresConfirmation ? '每次运行前必须确认' : '运行前确认' }}</dd>
        </dl>
        <p v-if="!selected.online" class="shortcut-offline">目标 Mac 离线，暂不可运行。</p>
        <button type="button" :disabled="!storageAvailable || !selected.online || busy || activeFor(selected.id) || !!pending" @click="start(selected)">
          {{ busy && !run ? '提交中…' : '运行任务' }}
        </button>
      </article>
      <section class="shortcut-history" aria-label="最近运行">
        <h3>最近运行</h3>
        <p v-if="loading && !recentRuns.length">正在读取运行记录…</p>
        <p v-else-if="!recentRuns.length">暂无运行记录。</p>
        <div v-else class="shortcut-list">
          <button
            v-for="item in recentRuns"
            :key="item.id"
            type="button"
            class="shortcut-item"
            :class="{ selected: item.id === run?.id }"
            :aria-pressed="item.id === run?.id"
            @click="selectRun(item)"
          >
            <span class="shortcut-history-info">
              <strong>{{ shortcuts.find((shortcut) => shortcut.id === item.shortcutId)?.name ?? (pending?.shortcutId === item.shortcutId ? pending.name : item.shortcutId) }}</strong>
              <small>{{ new Date(item.createdAt).toLocaleString() }} · {{ item.deviceId }}</small>
            </span>
            <span :data-status="item.status">{{ statusLabels[item.status] }}</span>
          </button>
        </div>
      </section>
      <article v-if="run" class="shortcut-result">
        <div class="shortcut-result-heading">
          <strong>{{ runName }} · {{ statusLabels[run.status] }}</strong>
          <div>
            <button v-if="running" type="button" :disabled="busy" @click="cancel">取消运行</button>
            <button v-else-if="selected?.id === run.shortcutId" type="button" :disabled="!storageAvailable || !selected.online || busy || !!pending" @click="start(selected)">再次运行</button>
          </div>
        </div>
        <small>Mac：{{ run.deviceId }} · 退出码：{{ run.exitCode ?? '—' }}</small>
        <pre>{{ run.output || '暂无输出' }}</pre>
      </article>
    </div>
  </section>
</template>
