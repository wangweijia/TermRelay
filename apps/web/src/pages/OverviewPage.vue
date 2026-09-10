<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import TerminalView from '../components/TerminalView.vue';
import { useRelayStore } from '../stores/relay';

const relay = useRelayStore();
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

onMounted(() => void relay.initialize());
onBeforeUnmount(() => relay.stop());
</script>

<template>
  <main class="console-page">
    <section class="page-heading">
      <div>
        <p class="eyebrow">SERVER S4 · READ-ONLY RELAY</p>
        <h1>终端中继控制台</h1>
        <p>查看已注册会话的历史输出，并通过 WebSocket 接续实时事件。</p>
      </div>
      <div class="connection-pill" :data-state="relay.connectionState">
        <span />{{ connectionLabel }}
      </div>
    </section>

    <p v-if="relay.error" class="error-banner">{{ relay.error }}</p>

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
          <button
            v-for="session in relay.sessions"
            :key="session.id"
            type="button"
            class="session-item"
            :class="{ active: session.id === relay.selectedSessionId }"
            @click="relay.selectSession(session.id)"
          >
            <span class="session-title">
              <strong>{{ session.toolKey }}</strong>
              <small :data-status="session.status">{{ session.status }}</small>
            </span>
            <span>{{ session.workspaceId }}</span>
            <code>{{ session.id }}</code>
          </button>
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
            <span>只读</span>
          </div>
        </div>

        <div v-if="relay.loadingHistory" class="terminal-placeholder">正在加载终端历史…</div>
        <TerminalView
          v-else-if="relay.selectedSession"
          :key="relay.selectedSession.id"
          :events="relay.selectedEvents"
        />
        <div v-else class="terminal-placeholder">选择一个会话查看终端输出</div>
      </section>
    </section>
  </main>
</template>
