<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionEventRecord, ToolEventPayload } from '../types';

const props = defineProps<{ events: SessionEventRecord[]; interactive: boolean }>();
const emit = defineEmits<{
  startTurn: [text: string];
  interrupt: [];
  resolveApproval: [approvalId: string, turnId: string, decision: 'allowOnce' | 'deny'];
}>();
const prompt = ref('');

const toolEvents = computed(() => props.events.flatMap((event) => {
  if (event.type !== 'tool.event') return [];
  return [{ ...event, payload: event.payload as unknown as ToolEventPayload }];
}));
const resolvedApprovals = computed(() => new Set(toolEvents.value.flatMap(({ payload }) =>
  payload.kind === 'approval.resolved' && typeof payload.data.approvalId === 'string'
    ? [payload.data.approvalId]
    : [],
)));

function submit(): void {
  const value = prompt.value.trim();
  if (!value || !props.interactive) return;
  emit('startTurn', value);
  prompt.value = '';
}

function text(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === 'string' ? data[field] : '';
}
</script>

<template>
  <section class="agent-view">
    <div class="agent-timeline">
      <article v-for="event in toolEvents" :key="event.seq" class="agent-event" :data-kind="event.payload.kind">
        <small>{{ event.payload.kind }} · #{{ event.seq }}</small>
        <p v-if="['assistant.delta', 'reasoning.delta', 'command.output', 'plan.updated'].includes(event.payload.kind)">
          {{ text(event.payload.data, 'text') }}
        </p>
        <pre v-else-if="event.payload.kind === 'command.started'">{{ text(event.payload.data, 'command') }}</pre>
        <div v-else-if="event.payload.kind === 'approval.requested'" class="approval-card" :data-risk="text(event.payload.data, 'risk')">
          <strong>{{ text(event.payload.data, 'title') }}</strong>
          <p v-if="text(event.payload.data, 'detail')">{{ text(event.payload.data, 'detail') }}</p>
          <div class="approval-actions">
            <button
              type="button"
              :disabled="!interactive || resolvedApprovals.has(text(event.payload.data, 'approvalId'))"
              @click="emit('resolveApproval', text(event.payload.data, 'approvalId'), text(event.payload.data, 'turnId'), 'deny')"
            >拒绝</button>
            <button
              type="button"
              class="approve"
              :disabled="!interactive || resolvedApprovals.has(text(event.payload.data, 'approvalId'))"
              @click="emit('resolveApproval', text(event.payload.data, 'approvalId'), text(event.payload.data, 'turnId'), 'allowOnce')"
            >仅允许一次</button>
          </div>
        </div>
        <p v-else-if="event.payload.kind === 'file.changed'">{{ text(event.payload.data, 'summary') }}</p>
        <p v-else-if="event.payload.kind === 'warning' || event.payload.kind === 'error'">
          {{ text(event.payload.data, 'message') }}
        </p>
      </article>
      <div v-if="!toolEvents.length" class="terminal-placeholder">此结构化 Agent 会话还没有事件</div>
    </div>
    <form class="agent-composer" @submit.prevent="submit">
      <textarea v-model="prompt" :disabled="!interactive" rows="3" placeholder="向 Agent 描述要完成的任务…" />
      <div>
        <button type="button" :disabled="!interactive" @click="emit('interrupt')">中断当前 Turn</button>
        <button type="submit" class="approve" :disabled="!interactive || !prompt.trim()">发送</button>
      </div>
    </form>
  </section>
</template>
