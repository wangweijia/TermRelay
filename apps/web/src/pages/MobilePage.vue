<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ApprovalInbox from '../components/ApprovalInbox.vue';
import StructuredAgentView from '../components/StructuredAgentView.vue';
import TerminalView from '../components/TerminalView.vue';
import { useRelayStore } from '../stores/relay';
import type { SessionRecord } from '../types';

type MobileTab = 'sessions' | 'workspace' | 'approvals';
const relay = useRelayStore();
const activeTab = ref<MobileTab>('sessions');
const toast = ref<string>();
let toastTimer: number | undefined;
const connectionText = computed(() => relay.connectionState === 'connected' ? '在线' : relay.connectionState === 'connecting' ? '连接中' : '离线');

onMounted(() => void relay.initialize());
onBeforeUnmount(() => { if (toastTimer) window.clearTimeout(toastTimer); relay.stop(); });
watch(() => relay.error, (value) => {
  if (!value) return;
  toast.value = value;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = undefined; }, 4_000);
});

async function openSession(session: SessionRecord): Promise<void> {
  await relay.selectSession(session.id);
  activeTab.value = 'workspace';
}
function interactive(sessionId: string): boolean {
  const session = relay.sessions.find((item) => item.id === sessionId);
  return session ? relay.isSessionInteractive(session) : false;
}
async function removeSession(session: SessionRecord, purge: boolean): Promise<void> {
  const action = purge ? '永久删除' : '从列表隐藏';
  if (window.confirm(`确定${action}“${relay.sessionDisplayName(session)}”？`)) await relay.deleteSession(session.id, purge);
}
</script>

<template>
  <main class="mobile-shell">
    <header class="mobile-topbar">
      <div><strong>TermRelay</strong><small>{{ activeTab === 'sessions' ? '会话' : activeTab === 'workspace' ? '工作区' : '审批中心' }}</small></div>
      <span class="mobile-connection" :data-state="relay.connectionState">{{ connectionText }}</span>
    </header>

    <Transition name="toast"><div v-if="toast" class="mobile-toast">{{ toast }}</div></Transition>

    <section v-show="activeTab === 'sessions'" class="mobile-screen mobile-sessions">
      <div class="mobile-section-heading"><strong>{{ relay.sessions.length }} 个会话</strong><button :disabled="relay.loadingSessions" @click="relay.refreshSessions">刷新</button></div>
      <div class="mobile-session-list">
        <article v-for="session in relay.sessions" :key="session.id" class="mobile-session-card" :class="{ selected: session.id === relay.selectedSessionId }">
          <button class="mobile-session-main" @click="openSession(session)">
            <span><strong>{{ relay.sessionDisplayName(session) }}</strong><small :data-status="relay.sessionDisplayStatus(session)">{{ relay.sessionDisplayStatus(session) }}</small></span>
            <span>{{ session.runtimeMode.toUpperCase() }} · {{ session.workspaceId }}</span>
          </button>
          <div v-if="session.status === 'finished'" class="mobile-session-actions"><button @click="removeSession(session, false)">隐藏</button><button class="danger" @click="removeSession(session, true)">永久删除</button></div>
        </article>
        <div v-if="!relay.sessions.length" class="mobile-empty">暂无会话</div>
      </div>
    </section>

    <section v-show="activeTab === 'workspace'" class="mobile-screen mobile-workspace">
      <template v-if="relay.selectedSession">
        <div class="mobile-workspace-bar">
          <div><strong>{{ relay.sessionDisplayName(relay.selectedSession) }}</strong><small>{{ relay.selectedSession.runtimeMode.toUpperCase() }} · {{ relay.selectedSessionInteractive ? '可交互' : '不可操作' }}</small></div>
          <div><button v-if="relay.selectedSession.runtimeMode === 'pty'" :disabled="!relay.selectedSessionInteractive" @click="relay.interruptSession">Ctrl-C</button><button class="danger" :disabled="!relay.selectedSessionInteractive" @click="relay.stopSession">停止</button></div>
        </div>
        <div v-if="relay.loadingHistory" class="mobile-empty">加载历史中…</div>
        <TerminalView v-else-if="relay.selectedSession.runtimeMode === 'pty'" :key="relay.selectedSession.id" :events="relay.selectedEvents" :interactive="relay.selectedSessionInteractive" @input="relay.sendTerminalInput" @resize="relay.resizeTerminal" />
        <StructuredAgentView v-else :key="relay.selectedSession.id" :events="relay.selectedEvents" :interactive="relay.selectedSessionInteractive" @start-turn="relay.startToolTurn" @interrupt="relay.interruptToolTurn" @resolve-approval="relay.resolveApproval" @resolve-user-input="relay.resolveUserInput" />
      </template>
      <div v-else class="mobile-empty"><button @click="activeTab = 'sessions'">选择会话</button></div>
    </section>

    <section v-show="activeTab === 'approvals'" class="mobile-screen mobile-approvals">
      <ApprovalInbox :approvals="relay.pendingApprovals" :settings="relay.notificationSettings" :is-interactive="interactive" @resolve="relay.resolveApprovalFromInbox" @toggle-notifications="relay.setApprovalNotifications" />
    </section>

    <nav class="mobile-tabs" aria-label="主要功能">
      <button :class="{ active: activeTab === 'sessions' }" @click="activeTab = 'sessions'"><span>▤</span>会话</button>
      <button :class="{ active: activeTab === 'workspace' }" @click="activeTab = 'workspace'"><span>⌘</span>工作区</button>
      <button :class="{ active: activeTab === 'approvals' }" @click="activeTab = 'approvals'"><span>✓</span>审批<i v-if="relay.pendingApprovals.length">{{ relay.pendingApprovals.length }}</i></button>
    </nav>
  </main>
</template>
