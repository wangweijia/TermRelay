<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import type { SessionEventRecord, ToolEventPayload } from '../types';

type Decision = 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel';
type TimelineItem = { id: string; kind: string; data: Record<string, unknown>; text?: string; resolved?: boolean };
type SendShortcut = 'commandEnter' | 'controlEnter' | 'optionEnter' | 'shiftEnter';

const sendShortcutStorageKey = 'termrelay.acpSendShortcut';
const MAX_COMMAND_TEXT = 200_000;
const MAX_STREAMING_TEXT = 1_000_000;
const shortcutOptions: { value: SendShortcut; label: string }[] = [
  { value: 'commandEnter', label: '⌘ + 回车' },
  { value: 'controlEnter', label: '⌃ + 回车' },
  { value: 'optionEnter', label: '⌥ + 回车' },
  { value: 'shiftEnter', label: '⇧ + 回车' },
];

const props = withDefaults(defineProps<{
  events: SessionEventRecord[];
  interactive: boolean;
  shortcutEnabled?: boolean;
  scrollRevision?: number;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  autoApproveEnabled?: boolean;
  autoApproveUpdating?: boolean;
}>(), {
  shortcutEnabled: true,
  scrollRevision: 0,
  hasOlder: false,
  loadingOlder: false,
  autoApproveEnabled: false,
  autoApproveUpdating: false,
});
const emit = defineEmits<{
  startTurn: [text: string]; interrupt: [];
  loadOlder: [];
  resolveApproval: [approvalId: string, turnId: string, decision: Decision];
  resolveUserInput: [requestId: string, turnId: string, answers: Record<string, string[]>];
  setAutoApprove: [enabled: boolean];
}>();
const prompt = ref('');
const timelineElement = ref<HTMLElement>();
const sendShortcut = ref<SendShortcut>(loadSendShortcut());
const answers = reactive<Record<string, string>>({});
const customAnswers = reactive<Record<string, string>>({});
const timeline = shallowRef<TimelineItem[]>([]);
const timelineById = new Map<string, TimelineItem>();
const turnActive = ref(false);
const awaitingHuman = ref(false);
const showTurnLoading = computed(() => turnActive.value && !awaitingHuman.value);
let processedEventCount = 0;
let processedLastSeq: number | undefined;
let loadingOlderRequested = false;
let previousVirtualSize = 0;

const virtualizer = useVirtualizer(computed(() => ({
  count: timeline.value.length,
  getScrollElement: () => timelineElement.value ?? null,
  estimateSize: () => 108,
  overscan: 8,
  gap: 12,
})));

function measureVirtualElement(value: unknown): void {
  if (value instanceof Element) virtualizer.value.measureElement(value);
}

function syncTimeline(): void {
  const prefixChanged = processedEventCount > props.events.length || (
    processedEventCount > 0 && props.events[processedEventCount - 1]?.seq !== processedLastSeq
  );
  if (prefixChanged) {
    timeline.value = [];
    timelineById.clear();
    processedEventCount = 0;
    processedLastSeq = undefined;
    turnActive.value = false;
    awaitingHuman.value = false;
  }
  let changed = false;
  for (let index = processedEventCount; index < props.events.length; index += 1) {
    const event = props.events[index]!;
    if (event.type !== 'tool.event') continue;
    applyToolEvent({ ...event, payload: event.payload as unknown as ToolEventPayload });
    changed = true;
  }
  processedEventCount = props.events.length;
  processedLastSeq = props.events.at(-1)?.seq;
  if (changed) timeline.value = [...timeline.value];
}

function applyToolEvent(event: { seq: number; payload: ToolEventPayload }): void {
    const { kind, data, correlation } = event.payload;
    if (kind === 'turn.started') { turnActive.value = true; awaitingHuman.value = false; return; }
    if (kind === 'turn.completed') { turnActive.value = false; awaitingHuman.value = false; return; }
    if (kind === 'approval.requested' || kind === 'user-input.requested') awaitingHuman.value = true;
    if (kind === 'approval.resolved' || kind === 'user-input.resolved') {
      const prefix = kind === 'approval.resolved' ? 'approval' : 'input';
      const key = kind === 'approval.resolved' ? 'approvalId' : 'requestId';
      const prior = timelineById.get(`${prefix}:${text(data, key)}`);
      if (prior) prior.resolved = true;
      awaitingHuman.value = false;
      return;
    }
    const identity = correlation.itemId || correlation.turnId || String(event.seq);
    if (['command.started', 'command.output', 'command.completed'].includes(kind)) {
      const id = `command:${text(data, 'commandId') || identity}`;
      const prior = timelineById.get(id);
      if (prior) {
        prior.data = { ...prior.data, ...data };
        if (kind === 'command.output') {
          prior.text = appendBounded(prior.text ?? '', text(data, 'text'), MAX_COMMAND_TEXT);
        }
      } else {
        const item = { id, kind: 'command', data, text: kind === 'command.output' ? text(data, 'text') : '', resolved: kind === 'command.completed' };
        timeline.value.push(item); timelineById.set(id, item);
      }
      return;
    }
    if (kind === 'assistant.delta' || kind === 'assistant.completed') {
      const id = `assistant:${identity}`;
      const prior = timelineById.get(id);
      if (prior) prior.text = kind === 'assistant.completed'
        ? text(data, 'text').slice(-MAX_STREAMING_TEXT)
        : appendBounded(prior.text ?? '', text(data, 'text'), MAX_STREAMING_TEXT);
      else { const item = { id, kind: 'assistant', data, text: text(data, 'text') }; timeline.value.push(item); timelineById.set(id, item); }
      return;
    }
    if (kind === 'file.changed') {
      const id = `file:${identity}`;
      const prior = timelineById.get(id);
      if (prior) prior.text = (prior.text ?? '') + text(data, 'summary');
      else { const item = { id, kind, data, text: text(data, 'summary') }; timeline.value.push(item); timelineById.set(id, item); }
      return;
    }
    const mergeKind = ['reasoning.delta', 'plan.updated'].includes(kind);
    const id = kind === 'approval.requested' ? `approval:${text(data, 'approvalId')}`
      : kind === 'user-input.requested' ? `input:${text(data, 'requestId')}` : `${kind}:${identity}`;
    if (mergeKind && timelineById.has(id)) {
      const prior = timelineById.get(id)!;
      prior.text = appendBounded(prior.text ?? '', text(data, 'text'), MAX_COMMAND_TEXT);
      return;
    }
    const item = { id, kind, data, text: text(data, 'text'), resolved: false };
    timeline.value.push(item); timelineById.set(id, item);
}
function text(data: Record<string, unknown>, field: string): string { return typeof data[field] === 'string' ? data[field] : ''; }
function appendBounded(current: string, addition: string, maximum: number): string {
  const combined = current + addition;
  if (combined.length <= maximum) return combined;
  return `[更早内容已省略]\n${combined.slice(-maximum)}`;
}
function strings(data: Record<string, unknown>, field: string): string[] { return Array.isArray(data[field]) ? (data[field] as unknown[]).filter((value): value is string => typeof value === 'string') : []; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []; }
function answerKey(requestId: string, questionId: string): string { return `${requestId}:${questionId}`; }
function itemLabel(kind: string): string {
  if (kind === 'user.message') return '你';
  if (kind === 'assistant') return 'Agent';
  if (kind === 'reasoning.delta') return '思考过程';
  if (kind === 'plan.updated') return '执行计划';
  return kind;
}
function decisionLabel(value: Decision): string { return ({ allowOnce: '允许一次', allowSession: '本会话允许', allowPolicy: '允许并应用规则', deny: '拒绝', cancel: '取消' })[value]; }
function submitTurn(): void { const value = prompt.value.trim(); if (value) { emit('startTurn', value); prompt.value = ''; } }
function loadSendShortcut(): SendShortcut {
  const stored = window.localStorage.getItem(sendShortcutStorageKey);
  return shortcutOptions.some((option) => option.value === stored)
    ? stored as SendShortcut
    : 'commandEnter';
}
function matchesSendShortcut(event: KeyboardEvent): boolean {
  switch (sendShortcut.value) {
    case 'commandEnter': return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    case 'controlEnter': return !event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey;
    case 'optionEnter': return !event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey;
    case 'shiftEnter': return !event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey;
  }
}
function handlePromptKeydown(event: KeyboardEvent): void {
  if (!props.shortcutEnabled || event.key !== 'Enter' || event.isComposing || !matchesSendShortcut(event)) return;
  event.preventDefault();
  if (props.interactive && prompt.value.trim()) submitTurn();
}
let timelinePinnedToBottom = true;
function handleTimelineScroll(): void {
  const element = timelineElement.value;
  if (!element) return;
  timelinePinnedToBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
  if (element.scrollTop <= 120 && props.hasOlder && !props.loadingOlder && !loadingOlderRequested) {
    loadingOlderRequested = true;
    previousVirtualSize = virtualizer.value.getTotalSize();
    emit('loadOlder');
  }
}
async function scrollToLatest(force: boolean): Promise<void> {
  if (!force && !timelinePinnedToBottom) return;
  await nextTick();
  const element = timelineElement.value;
  if (!element) return;
  element.scrollTop = element.scrollHeight;
  timelinePinnedToBottom = true;
}
onMounted(() => void scrollToLatest(true));
watch([() => props.events.length, () => props.events.at(-1)?.seq], syncTimeline, { immediate: true });
watch(() => props.scrollRevision, () => void scrollToLatest(true));
watch(() => props.events.at(-1)?.seq, () => void scrollToLatest(false));
watch(showTurnLoading, () => void scrollToLatest(false));
watch(() => props.loadingOlder, async (loading, wasLoading) => {
  if (loading || !wasLoading || !loadingOlderRequested) return;
  await nextTick();
  const sizeDelta = virtualizer.value.getTotalSize() - previousVirtualSize;
  const element = timelineElement.value;
  if (element && sizeDelta > 0) element.scrollTop += sizeDelta;
  loadingOlderRequested = false;
});
watch(sendShortcut, (value) => window.localStorage.setItem(sendShortcutStorageKey, value));
function updateAutoApprove(event: Event): void {
  emit('setAutoApprove', (event.target as HTMLInputElement).checked);
}
function submitAnswers(item: TimelineItem): void {
  const requestId = text(item.data, 'requestId');
  const values = Object.fromEntries(records(item.data.questions).map((question) => {
    const id = text(question, 'id');
    const key = answerKey(requestId, id);
    return [id, [customAnswers[key]?.trim() || answers[key]?.trim() || '']];
  }));
  if (!Object.values(values).some((value) => !value[0])) emit('resolveUserInput', requestId, text(item.data, 'turnId'), values);
}
</script>

<template>
  <section class="agent-view">
    <div ref="timelineElement" class="agent-timeline" @scroll.passive="handleTimelineScroll">
      <div v-if="hasOlder || loadingOlder" class="timeline-history-status">
        <span :data-loading="loadingOlder">
          {{ loadingOlder ? '正在加载更早内容…' : '继续向上滚动以加载更早内容' }}
        </span>
      </div>
      <div
        v-if="timeline.length"
        class="agent-virtual-list"
        :style="{ height: `${virtualizer.getTotalSize()}px` }"
      >
        <article
          v-for="virtualRow in virtualizer.getVirtualItems()"
          :key="timeline[virtualRow.index]!.id"
          :ref="measureVirtualElement"
          :data-index="virtualRow.index"
          class="agent-event agent-virtual-row"
          :data-kind="timeline[virtualRow.index]!.kind"
          :style="{ transform: `translateY(${virtualRow.start}px)` }"
        >
        <template v-if="timeline[virtualRow.index]" :key="timeline[virtualRow.index]!.id">
        <template v-for="item in [timeline[virtualRow.index]!]" :key="item.id">
        <small>{{ itemLabel(item.kind) }}</small>
        <p v-if="['user.message', 'assistant', 'reasoning.delta', 'plan.updated'].includes(item.kind)">{{ item.text }}</p>
        <div v-else-if="item.kind === 'command'">
          <pre v-if="text(item.data, 'command')">{{ text(item.data, 'command') }}</pre>
          <pre v-if="item.text">{{ item.text }}</pre>
          <p v-if="item.data.exitCode !== undefined">退出码：{{ item.data.exitCode ?? '—' }}</p>
        </div>
        <div v-else-if="item.kind === 'approval.requested'" class="approval-card" :data-risk="text(item.data, 'risk')">
          <strong>{{ text(item.data, 'title') }}</strong><pre v-if="text(item.data, 'detail')">{{ text(item.data, 'detail') }}</pre>
          <p v-if="item.resolved">审批已处理</p>
          <div v-else class="approval-actions">
            <button v-for="decision in strings(item.data, 'availableDecisions') as Decision[]" :key="decision" type="button" :class="{ approve: decision === 'allowOnce' }" :disabled="!interactive" @click="emit('resolveApproval', text(item.data, 'approvalId'), text(item.data, 'turnId'), decision)">{{ decisionLabel(decision) }}</button>
          </div>
        </div>
        <div v-else-if="item.kind === 'user-input.requested'" class="approval-card user-input-card">
          <strong>Agent 需要你的回答</strong>
          <template v-for="question in records(item.data.questions)" :key="text(question, 'id')">
            <label>{{ text(question, 'header') }}<small>{{ text(question, 'question') }}</small></label>
            <select v-if="records(question.options).length" v-model="answers[answerKey(text(item.data, 'requestId'), text(question, 'id'))]" :disabled="item.resolved || !interactive">
              <option value="">请选择</option>
              <option v-for="option in records(question.options)" :key="text(option, 'label')" :value="text(option, 'label')">{{ text(option, 'label') }} — {{ text(option, 'description') }}</option>
            </select>
            <input v-if="question.allowsOther === true || !records(question.options).length" v-model="customAnswers[answerKey(text(item.data, 'requestId'), text(question, 'id'))]" :placeholder="records(question.options).length ? '其他回答' : '输入回答'" :type="question.isSecret === true ? 'password' : 'text'" :disabled="item.resolved || !interactive">
          </template>
          <button v-if="!item.resolved" type="button" class="approve" :disabled="!interactive" @click="submitAnswers(item)">提交回答</button><p v-else>回答已提交</p>
        </div>
        <p v-else-if="item.kind === 'file.changed'">{{ item.text }}</p>
        <p v-else-if="item.kind === 'warning' || item.kind === 'error'">{{ text(item.data, 'message') }}</p>
        </template>
        </template>
      </article>
      </div>
      <div v-if="!timeline.length && !showTurnLoading" class="terminal-placeholder">还没有 ACP 消息</div>
      <div v-if="showTurnLoading" class="agent-event turn-loading" data-kind="turn.loading" aria-live="polite">
        <small>agent</small>
        <p class="turn-loading-text">
          <span class="turn-loading-dots"><i /><i /><i /></span>
          正在处理…
        </p>
      </div>
    </div>
    <form class="agent-composer" @submit.prevent="submitTurn">
      <textarea v-model="prompt" rows="3" placeholder="发送消息给 Agent…" :disabled="!interactive" @keydown="handlePromptKeydown" />
      <div class="composer-actions">
        <label v-if="shortcutEnabled" class="shortcut-picker">
          <span>发送快捷键</span>
          <select v-model="sendShortcut">
            <option v-for="option in shortcutOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <div>
          <label class="auto-approve-toggle" title="开关由 Server 按会话保存，审批只在 Mac App 执行一次">
            <input :checked="autoApproveEnabled" :disabled="autoApproveUpdating" type="checkbox" @change="updateAutoApprove">
            <span>自动审批通过</span>
          </label>
          <button type="button" :disabled="!interactive" @click="emit('interrupt')">中断</button>
          <button type="submit" class="approve" :disabled="!interactive || !prompt.trim()">发送</button>
        </div>
      </div>
    </form>
  </section>
</template>
