<script setup lang="ts">
import { computed } from 'vue';
import TerminalView from './TerminalView.vue';
import type { SessionEventRecord, ToolEventPayload } from '../types';

const props = defineProps<{
  events: SessionEventRecord[];
  interactive: boolean;
  displayMode: 'approval' | 'full';
}>();
const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [columns: number, rows: number];
  resolveApproval: [approvalId: string, turnId: string, decision: 'allowOnce' | 'deny'];
}>();

const toolEvents = computed(() => props.events.flatMap((event) => {
  if (event.type !== 'tool.event') return [];
  const normalized = { ...event, payload: event.payload as unknown as ToolEventPayload };
  if (![
    'approval.requested', 'approval.resolved', 'warning', 'error',
  ].includes(normalized.payload.kind)) return [];
  return [normalized];
}));
const resolvedApprovals = computed(() => new Set(toolEvents.value.flatMap(({ payload }) =>
  payload.kind === 'approval.resolved' && typeof payload.data.approvalId === 'string'
    ? [payload.data.approvalId]
    : [],
)));

function text(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === 'string' ? data[field] : '';
}
</script>

<template>
  <section class="agent-view" :class="`agent-view-${displayMode}`">
    <TerminalView
      v-if="displayMode === 'full'"
      :events="events"
      :interactive="interactive"
      @input="emit('input', $event)"
      @resize="(columns, rows) => emit('resize', columns, rows)"
    />
    <div v-if="displayMode === 'approval' || toolEvents.length" class="agent-timeline">
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
      <div v-if="!toolEvents.length && displayMode === 'approval'" class="terminal-placeholder">
        当前没有待处理的审批
      </div>
    </div>
  </section>
</template>
