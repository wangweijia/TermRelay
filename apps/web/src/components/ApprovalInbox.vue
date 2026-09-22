<script setup lang="ts">
import type { NotificationSettings, PendingApprovalRecord } from '../types';

type Decision = 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel';
const props = defineProps<{
  approvals: PendingApprovalRecord[];
  settings: NotificationSettings;
  isInteractive: (sessionId: string) => boolean;
  resolving: Record<string, boolean>;
}>();
const emit = defineEmits<{
  resolve: [sessionId: string, approvalId: string, turnId: string, decision: Decision];
  toggleNotifications: [enabled: boolean];
}>();
function text(item: PendingApprovalRecord, key: string): string { return typeof item.request[key] === 'string' ? String(item.request[key]) : ''; }
function decisions(item: PendingApprovalRecord): Decision[] {
  return Array.isArray(item.request.availableDecisions) ? item.request.availableDecisions as Decision[] : ['allowOnce', 'deny'];
}
function label(value: Decision): string { return ({ allowOnce: '允许一次', allowSession: '本会话允许', allowPolicy: '允许并应用规则', deny: '拒绝', cancel: '取消' })[value]; }
function isResolving(item: PendingApprovalRecord): boolean { return !!props.resolving[item.approvalId]; }
function handleResolve(item: PendingApprovalRecord, decision: Decision): void {
  if (isResolving(item)) return;
  emit('resolve', item.sessionId, item.approvalId, item.turnId, decision);
}
</script>

<template>
  <aside class="approval-inbox">
    <div class="approval-inbox-heading">
      <div><small>APPROVALS</small><strong>待审批 {{ approvals.length }}</strong></div>
      <label class="notification-toggle" :title="settings.configured ? '审批到达时推送到手机' : 'Server 未配置 Bark 地址'">
        <input type="checkbox" :checked="settings.enabled" :disabled="!settings.configured" @change="emit('toggleNotifications', ($event.target as HTMLInputElement).checked)">
        <span>手机通知</span>
      </label>
    </div>
    <TransitionGroup tag="div" name="inbox-approval" class="approval-inbox-list">
      <article v-for="item in approvals" :key="`${item.sessionId}:${item.approvalId}`" class="inbox-approval" :class="{ 'is-resolving': isResolving(item) }" :data-risk="item.risk">
        <div class="inbox-session"><strong>{{ item.sessionName }}</strong><small>{{ item.risk }}</small></div>
        <h3>{{ text(item, 'title') || text(item, 'kind') || '操作审批' }}</h3>
        <pre v-if="text(item, 'detail')">{{ text(item, 'detail') }}</pre>
        <div v-if="isResolving(item)" class="inbox-resolving">
          <span class="inbox-spinner" /> 正在处理…
        </div>
        <div v-else class="inbox-actions">
          <button v-for="decision in decisions(item)" :key="decision" type="button" :class="{ approve: decision === 'allowOnce' }" :disabled="!isInteractive(item.sessionId)" @click="handleResolve(item, decision)">{{ label(decision) }}</button>
        </div>
      </article>
      <div v-if="!approvals.length" key="empty" class="inbox-empty">当前没有待审批任务</div>
    </TransitionGroup>
  </aside>
</template>
