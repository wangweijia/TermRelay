<script setup lang="ts">
import type { NotificationSettings, PendingApprovalRecord } from '../types';

type Decision = 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel';
defineProps<{ approvals: PendingApprovalRecord[]; settings: NotificationSettings; isInteractive: (sessionId: string) => boolean }>();
const emit = defineEmits<{
  resolve: [sessionId: string, approvalId: string, turnId: string, decision: Decision];
  toggleNotifications: [enabled: boolean];
}>();
function text(item: PendingApprovalRecord, key: string): string { return typeof item.request[key] === 'string' ? String(item.request[key]) : ''; }
function decisions(item: PendingApprovalRecord): Decision[] {
  return Array.isArray(item.request.availableDecisions) ? item.request.availableDecisions as Decision[] : ['allowOnce', 'deny'];
}
function label(value: Decision): string { return ({ allowOnce: '允许一次', allowSession: '本会话允许', allowPolicy: '允许并应用规则', deny: '拒绝', cancel: '取消' })[value]; }
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
    <div class="approval-inbox-list">
      <article v-for="item in approvals" :key="`${item.sessionId}:${item.approvalId}`" class="inbox-approval" :data-risk="item.risk">
        <div class="inbox-session"><strong>{{ item.sessionName }}</strong><small>{{ item.risk }}</small></div>
        <h3>{{ text(item, 'title') || text(item, 'kind') || '操作审批' }}</h3>
        <pre v-if="text(item, 'detail')">{{ text(item, 'detail') }}</pre>
        <div class="inbox-actions">
          <button v-for="decision in decisions(item)" :key="decision" type="button" :class="{ approve: decision === 'allowOnce' }" :disabled="!isInteractive(item.sessionId)" @click="emit('resolve', item.sessionId, item.approvalId, item.turnId, decision)">{{ label(decision) }}</button>
        </div>
      </article>
      <div v-if="!approvals.length" class="inbox-empty">当前没有待审批任务</div>
    </div>
  </aside>
</template>
