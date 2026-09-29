<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { inputAcknowledged, inputDeliveryUncertain, parsePendingShortcutInput } from '../shortcut-input';
import type { PendingShortcutInput, ShortcutAnswer } from '../shortcut-input';

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
const pendingInputKey = 'termrelay.shortcut.pending-input.v1';
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
const loading = ref(false);
const busy = ref(false);
const error = ref<string>();
const refreshError = ref<string>();
const run = ref<ShortcutRun>();
const outputElement = ref<HTMLElement>();
const runName = ref<string>();
const pending = ref<PendingSubmission | undefined>(readPending());
let inputStorageAvailable = true;
function readPendingInput(): PendingShortcutInput | undefined {
  try {
    return parsePendingShortcutInput(window.localStorage.getItem(pendingInputKey));
  } catch {
    inputStorageAvailable = false;
    return undefined;
  }
}
const pendingInput = ref<PendingShortcutInput | undefined>(readPendingInput());
const inputBusy = ref(false);
const inputError = ref<string>();
const inputNotice = ref<string>();
const blockedInputCommandId = ref<string>();
const running = computed(() => run.value?.status === 'queued' || run.value?.status === 'running');
const activeRuns = computed(() => recentRuns.value.filter((item) => item.status === 'queued' || item.status === 'running'));
const availableShortcuts = computed(() => shortcuts.value.filter((item) => item.online));
const unavailableShortcuts = computed(() => shortcuts.value.filter((item) => !item.online));
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
    request<ShortcutRun[]>('/api/shortcuts/runs?limit=100'),
  ]);
  if (current !== generation || version !== refreshVersion) return;
  const failures: string[] = [];
  if (catalog.status === 'fulfilled') {
    shortcuts.value = catalog.value;
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
    recentRuns.value = history.value;
    const currentRun = run.value;
    const fresher = currentRun && history.value.find((item) => item.id === currentRun.id);
    const newestActive = history.value.find((item) => item.status === 'queued' || item.status === 'running');
    if (newestActive && (!currentRun || !running.value)) {
      selectRun(newestActive);
    } else if (history.value[0] && (!currentRun ||
      (!running.value && history.value[0].createdAt > currentRun.createdAt))) {
      selectRun(history.value[0]);
    } else if (fresher) {
      selectRun(fresher);
    }
  } else {
    failures.push(`读取运行状态失败：${message(history.reason)}`);
  }
  refreshError.value = failures.join('；') || undefined;
  loading.value = false;
  schedulePoll();
}

function rememberRun(updated: ShortcutRun): void {
  recentRuns.value = [updated, ...recentRuns.value.filter((item) => item.id !== updated.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

function selectRun(selectedRun: ShortcutRun): void {
  run.value = selectedRun;
  runName.value = shortcuts.value.find((item) => item.id === selectedRun.shortcutId)?.name
    ?? (pending.value?.shortcutId === selectedRun.shortcutId ? pending.value.name : selectedRun.shortcutId);
}

function schedulePoll(): void {
  stopPolling();
  if (props.active) {
    pollTimer = window.setTimeout(() => void refresh(), activeRuns.value.length ? 2000 : 8000);
  }
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
  if (!run.value || !running.value || busy.value || inputBusy.value) return;
  const id = run.value.id;
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

function clearPendingInput(submission: PendingShortcutInput): boolean {
  try {
    const saved = readPendingInput();
    if (!inputStorageAvailable || saved?.commandId !== submission.commandId ||
      saved.runId !== submission.runId || saved.answer !== submission.answer) return false;
    window.localStorage.removeItem(pendingInputKey);
    pendingInput.value = undefined;
    return true;
  } catch {
    return false;
  }
}

async function submitInput(): Promise<void> {
  const submission = pendingInput.value;
  if (!submission || inputBusy.value || busy.value || run.value?.id !== submission.runId ||
    run.value.status !== 'running' || blockedInputCommandId.value === submission.commandId) return;
  inputBusy.value = true;
  inputError.value = undefined;
  inputNotice.value = undefined;
  try {
    const response = await fetch(`/api/shortcuts/runs/${encodeURIComponent(submission.runId)}/input`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: submission.commandId, answer: submission.answer }),
      signal: AbortSignal.timeout(20000),
    });
    if (disposed) return;
    const body: unknown = await response.json().catch(() => undefined);
    if (disposed) return;
    const detail = typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined;
    const reason = typeof detail === 'string' ? detail : `请求被拒绝 (${response.status})`;
    if (response.ok && inputAcknowledged(body)) {
      if (clearPendingInput(submission)) inputNotice.value = 'Mac 已确认接收输入；这不代表 CLI 已批准或任务已完成。';
      else {
        blockedInputCommandId.value = submission.commandId;
        inputError.value = 'Mac 已确认接收，但无法清除待确认输入；请勿重试。请恢复浏览器存储后刷新。';
      }
    } else if (!response.ok && !inputDeliveryUncertain(response.status, reason)) {
      inputError.value = `输入被拒绝：${reason}。Mac 未确认接收。`;
      if (!clearPendingInput(submission)) {
        blockedInputCommandId.value = submission.commandId;
        inputError.value += ' 无法清除待确认输入，请勿重试。';
      }
    } else {
      inputError.value = `输入结果未知${response.status === 503 ? '（目标可能离线）' : ''}：${response.ok ? '未收到 Mac 确认' : reason}。请用相同命令 ID 重试，勿发送新输入。`;
    }
  } catch {
    if (!disposed) inputError.value = navigator.onLine
      ? '输入结果未知（请求超时或连接中断）。请用相同命令 ID 重试，勿发送新输入。'
      : '浏览器离线，输入结果未知。联网后请用相同命令 ID 重试，勿发送新输入。';
  } finally {
    if (!disposed) inputBusy.value = false;
  }
}

function sendInput(answer: ShortcutAnswer): void {
  if (inputBusy.value || busy.value || !run.value || run.value.status !== 'running' ||
    pendingInput.value || !inputStorageAvailable) return;
  const existing = readPendingInput();
  if (existing || !inputStorageAvailable) {
    pendingInput.value = existing;
    inputError.value = '已有待确认输入，不能生成新命令；请使用原命令 ID 重试。';
    return;
  }
  const submission = { runId: run.value.id, commandId: window.crypto.randomUUID(), answer };
  try {
    window.localStorage.setItem(pendingInputKey, JSON.stringify(submission));
  } catch {
    inputStorageAvailable = false;
    inputError.value = '无法保存命令 ID，输入未发送。请恢复浏览器存储后重试。';
    return;
  }
  pendingInput.value = submission;
  void submitInput();
}

function abandonInput(): void {
  const submission = pendingInput.value;
  if (!submission || inputBusy.value || !window.confirm('输入可能已经到达 CLI。放弃追踪后不可安全重试此命令，继续吗？')) return;
  if (clearPendingInput(submission)) {
    inputError.value = undefined;
    inputNotice.value = '已放弃追踪输入；它可能已到达 CLI，请检查输出再决定是否发送新输入。';
  } else {
    inputError.value = '无法清除待确认输入，请勿发送新输入。';
  }
}

watch(() => [run.value?.id, run.value?.output], async ([id], previous) => {
  const output = outputElement.value;
  const followOutput = id !== previous?.[0] || !output ||
    output.scrollHeight - output.scrollTop - output.clientHeight < 48;
  if (!followOutput) return;
  await nextTick();
  if (outputElement.value) outputElement.value.scrollTop = outputElement.value.scrollHeight;
});

watch(() => props.active, (active) => {
  generation++;
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
      <p v-if="inputError" class="shortcut-error" role="alert">{{ inputError }}</p>
      <p v-if="inputNotice" class="shortcut-input-notice" role="status">{{ inputNotice }}</p>
      <p v-if="refreshError" class="shortcut-error" role="alert">{{ refreshError }}</p>
      <p v-if="!storageAvailable" class="shortcut-error" role="alert">无法读取待确认的运行 ID；为避免重复执行，已禁用新任务。请恢复浏览器本地存储。</p>
      <p v-if="!inputStorageAvailable" class="shortcut-error" role="alert">无法读取待确认的输入命令；为避免重复输入，已禁用 CLI 输入。请恢复浏览器本地存储。</p>
      <div v-if="pendingInput" class="shortcut-pending" role="status">
        <strong>待确认 CLI 输入 · 运行 ID：{{ pendingInput.runId }}</strong>
        <span>命令 ID：{{ pendingInput.commandId }}。结果未知时仅可用此 ID 重试；输入可能已经送达。</span>
        <div>
          <button type="button" :disabled="inputBusy || busy || blockedInputCommandId === pendingInput.commandId || run?.id !== pendingInput.runId || run?.status !== 'running'" @click="submitInput">{{ inputBusy ? '发送中…' : '用相同命令 ID 重试' }}</button>
          <button type="button" :disabled="inputBusy" @click="abandonInput">放弃追踪输入</button>
        </div>
        <span v-if="run?.id !== pendingInput.runId || run?.status !== 'running'">请选择对应的运行中记录再重试；运行已结束时不可继续发送。</span>
      </div>
      <div v-if="pending" class="shortcut-pending" role="status">
        <strong>待确认提交：{{ pending.name }}</strong>
        <span>运行 ID：{{ pending.runId }}。请求可能已执行，重试将使用同一 ID。</span>
        <div>
          <button type="button" :disabled="busy" @click="submitPending">{{ busy ? '确认中…' : '用相同 ID 重试' }}</button>
          <button type="button" :disabled="busy" @click="abandonPending">放弃追踪</button>
        </div>
      </div>
      <section v-if="activeRuns.length" class="shortcut-active" aria-label="当前运行的任务">
        <h3>当前运行</h3>
        <div class="shortcut-list">
          <button v-for="item in activeRuns" :key="item.id" type="button" class="shortcut-item"
            :class="{ selected: item.id === run?.id }" :aria-pressed="item.id === run?.id" @click="selectRun(item)">
            <strong>{{ shortcuts.find((shortcut) => shortcut.id === item.shortcutId)?.name ?? item.shortcutId }}</strong>
            <span>{{ statusLabels[item.status] }} · 查看输出</span>
          </button>
        </div>
      </section>
      <article v-if="run" class="shortcut-result">
        <div class="shortcut-result-heading">
          <strong>{{ running ? '当前运行' : '运行结果' }} · {{ runName }}</strong>
          <div>
            <button v-if="running" type="button" :disabled="busy || inputBusy" @click="cancel">取消运行</button>
          </div>
        </div>
        <p class="shortcut-run-status" :data-status="run.status" role="status">{{ statusLabels[run.status] }}{{ run.exitCode !== null ? ` · 退出码 ${run.exitCode}` : '' }}</p>
        <pre ref="outputElement" class="shortcut-output" aria-label="任务输出" aria-live="polite">{{ run.output || (running ? '等待 Mac 输出…' : '任务没有输出') }}</pre>
        <div v-if="run.status === 'running'" class="shortcut-input">
          <strong>命令正在等待确认？</strong>
          <p>查看上方输出后，向 CLI 发送一次回答。此处只能发送 y / n / yes / no。</p>
          <p v-if="!shortcuts.find((item) => item.id === run?.shortcutId)?.online" class="shortcut-offline">目标 Mac 离线，暂不可发送输入。</p>
          <div class="shortcut-answer-actions">
            <button v-for="answer in (['y', 'n', 'yes', 'no'] as const)" :key="answer" type="button"
              :disabled="busy || inputBusy || !!pendingInput || !inputStorageAvailable || !shortcuts.find((item) => item.id === run?.shortcutId)?.online"
              @click="sendInput(answer)">{{ answer === 'y' ? '确认 (y)' : answer === 'n' ? '拒绝 (n)' : `发送 ${answer}` }}</button>
          </div>
        </div>
      </article>
      <section class="shortcut-available" aria-label="可用快捷任务">
        <h3>可用任务</h3>
        <p v-if="loading && !shortcuts.length" class="shortcut-empty">正在读取快捷任务…</p>
        <p v-else-if="!shortcuts.length" class="shortcut-empty">暂无快捷任务。可在 Mac 上配置任务。</p>
        <p v-else-if="!availableShortcuts.length" class="shortcut-empty">Mac 当前离线，暂无可运行任务。</p>
        <div v-else class="shortcut-list">
          <article v-for="shortcut in availableShortcuts" :key="shortcut.id" class="shortcut-task">
            <div><strong>{{ shortcut.name }}</strong><p v-if="shortcut.description">{{ shortcut.description }}</p></div>
            <button type="button" :disabled="!storageAvailable || busy || activeFor(shortcut.id) || !!pending"
              @click="start(shortcut)">{{ busy && pending?.shortcutId === shortcut.id ? '提交中…' : activeFor(shortcut.id) ? '运行中' : '运行' }}</button>
          </article>
        </div>
        <p v-if="unavailableShortcuts.length" class="shortcut-unavailable">{{ unavailableShortcuts.length }} 个任务所在的 Mac 已离线</p>
      </section>
    </div>
  </section>
</template>
