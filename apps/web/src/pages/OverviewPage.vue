<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TerminalView from '../components/TerminalView.vue';
import { useRelayStore } from '../stores/relay';
import type { SessionRecord } from '../types';

const relay = useRelayStore();
const toastMessage = ref<string>();
const sessionPendingDelete = ref<SessionRecord>();
const purgeAssociatedData = ref(false);
const deletingSession = ref(false);
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
    <section class="page-heading">
      <div>
        <p class="eyebrow">S5 · INTERACTIVE RELAY</p>
        <h1>终端中继控制台</h1>
        <p>查看历史输出，并通过 WebSocket 实时操作 Mac 上的终端会话。</p>
      </div>
      <div class="connection-pill" :data-state="relay.connectionState">
        <span />{{ connectionLabel }}
      </div>
    </section>

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
            <strong>{{ relay.sessions.length }} 个会话</strong>
          </div>
          <button type="button" :disabled="relay.loadingSessions" @click="relay.refreshSessions">
            {{ relay.loadingSessions ? '刷新中' : '刷新' }}
          </button>
        </div>

        <div v-if="relay.sessions.length" class="session-list">
          <div
            v-for="session in relay.sessions"
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
                <strong>{{ session.toolKey }}</strong>
                <small :data-status="relay.sessionDisplayStatus(session)">
                  {{ relay.sessionDisplayStatus(session) }}
                </small>
              </span>
              <span>{{ session.workspaceId }}</span>
              <code>{{ session.id }}</code>
            </button>
            <button
              v-if="session.status === 'finished'"
              type="button"
              class="session-delete"
              :aria-label="`删除会话 ${session.id}`"
              title="删除此会话"
              @click="requestDelete(session)"
            >删除</button>
          </div>
        </div>
        <div v-else class="empty-state">
          <strong>还没有会话</strong>
          <span>Mac 注册并上传会话后会显示在这里。</span>
        </div>
      </aside>

      <section class="terminal-panel">
        <div v-if="relay.selectedSession" class="terminal-heading">
          <div>
            <small>{{ relay.selectedSession.deviceId }}</small>
            <strong>{{ relay.selectedSession.workspaceId }} / {{ relay.selectedSession.toolKey }}</strong>
          </div>
          <div class="terminal-meta">
            <span>{{ relay.selectedSession.runtimeMode }}</span>
            <span>seq {{ relay.selectedSession.stateVersion }}</span>
            <span>{{ relay.selectedSessionInteractive ? '可交互' : '不可操作' }}</span>
          </div>
          <div class="terminal-actions">
            <button
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

        <div v-if="relay.loadingHistory" class="terminal-placeholder">正在加载终端历史…</div>
        <TerminalView
          v-else-if="relay.selectedSession"
          :key="relay.selectedSession.id"
          :events="relay.selectedEvents"
          :interactive="relay.selectedSessionInteractive"
          @input="relay.sendTerminalInput"
          @resize="relay.resizeTerminal"
        />
        <div v-else class="terminal-placeholder">选择一个会话查看终端输出</div>
        <small v-if="relay.commandStatus" class="command-status">{{ relay.commandStatus }}</small>
      </section>
    </section>

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
          {{ sessionPendingDelete.toolKey }} · {{ sessionPendingDelete.workspaceId }}
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
