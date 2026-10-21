<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TerminalView from '../components/TerminalView.vue';
import StructuredAgentView from '../components/StructuredAgentView.vue';
import ApprovalInbox from '../components/ApprovalInbox.vue';
import ShortcutPanel from '../components/ShortcutPanel.vue';
import SessionSourceSwitch from '../components/SessionSourceSwitch.vue';
import SessionStartPanel from '../components/SessionStartPanel.vue';
import { useRelayStore } from '../stores/relay';
import type { SessionRecord } from '../types';

const relay = useRelayStore();
const originFilter = ref<'local' | 'external'>('local');
const listedSessions = computed(() => relay.sessions.filter(s => (s.origin ?? 'local') === originFilter.value));
const toastMessage = ref<string>();
const sessionPendingDelete = ref<SessionRecord>();
const purgeAssociatedData = ref(false);
const deletingSession = ref(false);
const shortcutsOpen = ref(false);
const sessionStartOpen = ref(false);
let toastTimer: number | undefined;

const connectionLabel = computed(() => {
  switch (relay.connectionState) {
    case 'connected':
      return '实时连接正常';
    case 'connecting':
      return '正在连接';
    case 'disconnected':
      return '连接已断开';
  }
});

function requestDelete(session: SessionRecord): void {
  sessionPendingDelete.value = session;
  purgeAssociatedData.value = false;
}

function cancelDelete(): void {
  if (deletingSession.value) return;
  sessionPendingDelete.value = undefined;
  purgeAssociatedData.value = false;
}
function isSessionInteractive(sessionId: string): boolean {
  const session = relay.sessions.find((item) => item.id === sessionId);
  return session ? relay.isSessionInteractive(session) : false;
}

async function confirmDelete(): Promise<void> {
  const session = sessionPendingDelete.value;
  if (!session || deletingSession.value) return;
  deletingSession.value = true;
  const deleted = await relay.deleteSession(
    session.id,
    purgeAssociatedData.value,
  );
  deletingSession.value = false;
  if (deleted) cancelDelete();
}

watch(
  () => relay.error,
  (error) => {
    if (!error) return;
    toastMessage.value = error;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastMessage.value = undefined;
      toastTimer = undefined;
    }, 5_000);
  },
);

onMounted(() => void relay.initialize());
onBeforeUnmount(() => {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  relay.stop();
});
</script>

<template>
  <main class="console-page">
    <Teleport to="#app-header-actions" defer>
      <button type="button" @click="sessionStartOpen = true">新建会话</button>
      <button type="button" @click="shortcutsOpen = true">快捷任务</button>
      <div class="connection-pill" :data-state="relay.connectionState" role="status">
        <span />{{ connectionLabel }}
      </div>
    </Teleport>

    <Transition name="toast">
      <div v-if="toastMessage" class="error-toast" role="alert">
        <span>{{ toastMessage }}</span>
        <button type="button" aria-label="关闭提示" @click="toastMessage = undefined">×</button>
      </div>
    </Transition>

    <section class="relay-layout">
      <aside class="session-panel">
        <div class="panel-heading">
          <div>
            <small>SESSIONS</small>
            <strong>{{ listedSessions.length }} 个会话</strong>
          </div>
          <button type="button" :disabled="relay.loadingSessions" @click="relay.refreshSessions">
            {{ relay.loadingSessions ? '刷新中' : '刷新' }}
          </button>
        </div>

        <SessionSourceSwitch v-model="originFilter" :manual-count="relay.sessions.filter(s => s.origin !== 'external').length" :project-count="relay.sessions.filter(s => s.origin === 'external').length" />
        <div v-if="listedSessions.length" class="session-list">
          <div
            v-for="session in listedSessions"
            :key="session.id"
            class="session-row"
          >
            <button
              type="button"
              class="session-item"
              :class="{ active: session.id === relay.selectedSessionId }"
              @click="relay.selectSession(session.id)"
            >
              <span class="session-title">
                <strong>{{ relay.sessionDisplayName(session) }}</strong>
                <small :data-status="relay.sessionDisplayStatus(session)">
                  {{ relay.sessionDisplayStatus(session) }}
                </small>
              </span>
              <span v-if="session.origin === 'external'" class="session-project-meta"><span class="session-project-tag">{{ session.projectId }}</span><span>API 对话</span></span>
              <span>{{ session.workspaceId }}</span>
              <code>{{ session.id }}</code>
            </button>
            <button
              v-if="session.status === 'finished' || session.status === 'failed'"
              type="button"
              class="session-delete"
              :aria-label="`删除会话 ${session.id}`"
              title="删除此会话"
              @click="requestDelete(session)"
            >删除</button>
          </div>
        </div>
        <div v-else class="empty-state">
          <strong>{{ originFilter === 'external' ? '暂无项目调用' : '暂无手动会话' }}</strong>
          <span>{{ originFilter === 'external' ? '项目通过 AI API 创建的会话会显示在这里。' : '点击“新建会话”选择已授权的在线 Mac / Linux 工作区。' }}</span>
        </div>
      </aside>

      <section class="terminal-panel">
        <div v-if="relay.selectedSession" class="terminal-heading">
          <div>
            <small>{{ relay.selectedSession.deviceId }}</small>
            <strong>
              {{ relay.sessionDisplayName(relay.selectedSession) }}
              <small>· {{ relay.selectedSession.workspaceId }}</small>
            </strong>
          </div>
          <div class="terminal-meta">
            <span>{{ relay.selectedSession.runtimeMode }}</span>
            <span>seq {{ relay.selectedSession.stateVersion }}</span>
            <span>{{ relay.selectedSessionInteractive ? '可交互' : '不可操作' }}</span>
          </div>
          <div class="terminal-actions">
            <button
              v-if="relay.selectedSession.runtimeMode === 'pty'"
              type="button"
              :disabled="!relay.selectedSessionInteractive"
              title="向当前 Shell 的前台程序发送 Ctrl-C，不关闭 Shell"
              @click="relay.interruptSession"
            >Ctrl-C</button>
            <button
              type="button"
              class="danger"
              :disabled="!relay.selectedSessionInteractive"
              title="终止整个 Shell 会话及其 PTY"
              @click="relay.stopSession"
            >停止</button>
          </div>
        </div>

        <div v-if="relay.loadingHistory" class="terminal-placeholder">正在加载会话历史…</div>
        <TerminalView
          v-if="!relay.loadingHistory && relay.selectedSession?.runtimeMode === 'pty'"
          :key="relay.selectedSession.id"
          :events="relay.selectedEvents"
          :interactive="relay.selectedSessionInteractive"
          :scroll-revision="relay.scrollToLatestRevision"
          @input="relay.sendTerminalInput"
          @resize="relay.resizeTerminal"
        />
        <KeepAlive :max="12">
          <StructuredAgentView
            v-if="!relay.loadingHistory && relay.selectedSession?.runtimeMode === 'acp'"
            :key="relay.selectedSession.id"
            :session-id="relay.selectedSession.id"
            :events="relay.selectedEvents"
            :interactive="relay.selectedSessionInteractive"
            :external="relay.selectedSession.origin === 'external'"
            :scroll-revision="relay.scrollToLatestRevision"
            :has-older="relay.hasOlderBySession[relay.selectedSession.id] ?? false"
            :loading-older="relay.loadingOlderHistory"
            :auto-approve-enabled="relay.selectedSession.autoApproveEnabled"
            :auto-approve-updating="relay.updatingAutoApprove[relay.selectedSession.id] ?? false"
            @start-turn="relay.startToolTurn"
            @set-configuration="relay.setToolConfiguration"
            @interrupt="relay.interruptToolTurn"
            @load-older="relay.loadOlderHistory"
            @resolve-approval="relay.resolveApproval"
            @resolve-user-input="relay.resolveUserInput"
            @set-auto-approve="(enabled) => relay.setSessionAutoApprove(relay.selectedSession!.id, enabled)"
          />
        </KeepAlive>
        <div v-if="!relay.loadingHistory && !relay.selectedSession" class="terminal-placeholder">选择一个会话查看内容</div>
        <small v-if="relay.commandStatus" class="command-status">{{ relay.commandStatus }}</small>
      </section>
      <ApprovalInbox
        :approvals="relay.visiblePendingApprovals"
        :settings="relay.notificationSettings"
        :is-interactive="isSessionInteractive"
        :resolving="relay.resolvingApprovals"
        @resolve="relay.resolveApprovalFromInbox"
        @toggle-notifications="relay.setApprovalNotifications"
      />
    </section>

    <div v-if="sessionStartOpen" class="modal-backdrop" role="presentation" @click.self="sessionStartOpen = false">
      <div class="shortcut-dialog" role="dialog" aria-modal="true" aria-label="远程创建会话">
        <button type="button" class="shortcut-close" aria-label="关闭" @click="sessionStartOpen = false">×</button>
        <SessionStartPanel @created="sessionStartOpen = false; originFilter = 'local'" />
      </div>
    </div>

    <div v-if="shortcutsOpen" class="modal-backdrop" role="presentation" @click.self="shortcutsOpen = false">
      <div class="shortcut-dialog" role="dialog" aria-modal="true" aria-label="快捷任务">
        <button type="button" class="shortcut-close" aria-label="关闭快捷任务" @click="shortcutsOpen = false">×</button>
        <ShortcutPanel :active="shortcutsOpen" />
      </div>
    </div>

    <div
      v-if="sessionPendingDelete"
      class="modal-backdrop"
      role="presentation"
      @click.self="cancelDelete"
    >
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <small>DELETE SESSION</small>
        <h2 id="delete-title">确定删除这个会话？</h2>
        <p>
          {{ relay.sessionDisplayName(sessionPendingDelete) }} · {{ sessionPendingDelete.workspaceId }}
        </p>
        <code>{{ sessionPendingDelete.id }}</code>
        <label class="purge-option">
          <input v-model="purgeAssociatedData" type="checkbox" :disabled="deletingSession">
          <span>
            <strong>同时永久删除数据库关联数据</strong>
            <small>会话、终端事件、命令和审批记录将无法恢复。</small>
          </span>
        </label>
        <p v-if="!purgeAssociatedData" class="soft-delete-note">
          不勾选时仅从 Web 列表隐藏，数据库历史数据仍然保留。
        </p>
        <div class="dialog-actions">
          <button type="button" :disabled="deletingSession" @click="cancelDelete">取消</button>
          <button
            type="button"
            class="danger"
            :disabled="deletingSession"
            @click="confirmDelete"
          >{{ deletingSession ? '删除中…' : '确认删除' }}</button>
        </div>
      </section>
    </div>
  </main>
</template>
