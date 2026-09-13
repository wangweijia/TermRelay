<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { SessionEventRecord, ToolEventPayload } from '../types';

type Decision = 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel';
type TimelineItem = { id: string; kind: string; data: Record<string, unknown>; text?: string; resolved?: boolean };
type SendShortcut = 'commandEnter' | 'controlEnter' | 'optionEnter' | 'shiftEnter';

const sendShortcutStorageKey = 'termrelay.acpSendShortcut';
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
}>(), { shortcutEnabled: true });
const emit = defineEmits<{
  startTurn: [text: string]; interrupt: [];
  resolveApproval: [approvalId: string, turnId: string, decision: Decision];
  resolveUserInput: [requestId: string, turnId: string, answers: Record<string, string[]>];
}>();
const prompt = ref('');
const sendShortcut = ref<SendShortcut>(loadSendShortcut());
const answers = reactive<Record<string, string>>({});
const customAnswers = reactive<Record<string, string>>({});
const toolEvents = computed(() => props.events.flatMap((event) => event.type === 'tool.event'
  ? [{ ...event, payload: event.payload as unknown as ToolEventPayload }] : []));
const timeline = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = [];
  const byId = new Map<string, TimelineItem>();
  for (const event of toolEvents.value) {
    const { kind, data, correlation } = event.payload;
    if (kind === 'approval.resolved' || kind === 'user-input.resolved') {
      const prefix = kind === 'approval.resolved' ? 'approval' : 'input';
      const key = kind === 'approval.resolved' ? 'approvalId' : 'requestId';
      const prior = byId.get(`${prefix}:${text(data, key)}`);
      if (prior) prior.resolved = true;
      continue;
    }
    const identity = correlation.itemId || correlation.turnId || String(event.seq);
    if (['command.started', 'command.output', 'command.completed'].includes(kind)) {
      const id = `command:${text(data, 'commandId') || identity}`;
      const prior = byId.get(id);
      if (prior) {
        prior.data = { ...prior.data, ...data };
        if (kind === 'command.output') prior.text += text(data, 'text');
      } else {
        const item = { id, kind: 'command', data, text: kind === 'command.output' ? text(data, 'text') : '', resolved: kind === 'command.completed' };
        items.push(item); byId.set(id, item);
      }
      continue;
    }
    if (kind === 'assistant.delta' || kind === 'assistant.completed') {
      const id = `assistant:${identity}`;
      const prior = byId.get(id);
      if (prior) prior.text = kind === 'assistant.completed' ? text(data, 'text') : prior.text + text(data, 'text');
      else { const item = { id, kind: 'assistant', data, text: text(data, 'text') }; items.push(item); byId.set(id, item); }
      continue;
    }
    if (kind === 'file.changed') {
      const id = `file:${identity}`;
      const prior = byId.get(id);
      if (prior) prior.text += text(data, 'summary');
      else { const item = { id, kind, data, text: text(data, 'summary') }; items.push(item); byId.set(id, item); }
      continue;
    }
    const mergeKind = ['reasoning.delta', 'plan.updated'].includes(kind);
    const id = kind === 'approval.requested' ? `approval:${text(data, 'approvalId')}`
      : kind === 'user-input.requested' ? `input:${text(data, 'requestId')}` : `${kind}:${identity}`;
    if (mergeKind && byId.has(id)) { byId.get(id)!.text += text(data, 'text'); continue; }
    const item = { id, kind, data, text: text(data, 'text'), resolved: false };
    items.push(item); byId.set(id, item);
  }
  return items;
});
function text(data: Record<string, unknown>, field: string): string { return typeof data[field] === 'string' ? data[field] : ''; }
function strings(data: Record<string, unknown>, field: string): string[] { return Array.isArray(data[field]) ? (data[field] as unknown[]).filter((value): value is string => typeof value === 'string') : []; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []; }
function answerKey(requestId: string, questionId: string): string { return `${requestId}:${questionId}`; }
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
watch(sendShortcut, (value) => window.localStorage.setItem(sendShortcutStorageKey, value));
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
    <div class="agent-timeline">
      <article v-for="item in timeline" :key="item.id" class="agent-event" :data-kind="item.kind">
        <small>{{ item.kind }}</small>
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
          <strong>Codex 需要你的回答</strong>
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
      </article>
      <div v-if="!timeline.length" class="terminal-placeholder">还没有 ACP 消息</div>
    </div>
    <form class="agent-composer" @submit.prevent="submitTurn">
      <textarea v-model="prompt" rows="3" placeholder="发送消息给 Codex…" :disabled="!interactive" @keydown="handlePromptKeydown" />
      <div class="composer-actions">
        <label v-if="shortcutEnabled" class="shortcut-picker">
          <span>发送快捷键</span>
          <select v-model="sendShortcut">
            <option v-for="option in shortcutOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <div>
          <button type="button" :disabled="!interactive" @click="emit('interrupt')">中断</button>
          <button type="submit" class="approve" :disabled="!interactive || !prompt.trim()">发送</button>
        </div>
      </div>
    </form>
  </section>
</template>
