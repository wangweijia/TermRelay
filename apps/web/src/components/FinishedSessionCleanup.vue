<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRelayStore } from '../stores/relay';
import type { SessionRecord } from '../types';

const props = defineProps<{ sessions: SessionRecord[]; scope: string }>();
const relay = useRelayStore();
const finished = computed(() => props.sessions.filter((session) => session.status === 'finished'));
const targets = ref<string[]>([]);
const targetScope = ref('');
const open = ref(false);
const purge = ref(false);
const busy = ref(false);
const result = ref('');

function requestCleanup(): void {
  targets.value = finished.value.map((session) => session.id);
  targetScope.value = props.scope;
  purge.value = false;
  result.value = '';
  open.value = true;
}

function close(): void {
  if (!busy.value) open.value = false;
}

async function cleanup(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (const id of targets.value) {
      // Recheck the snapshot so a refreshed or changed session is never cleared accidentally.
      if (relay.sessions.find((session) => session.id === id)?.status !== 'finished') {
        skipped += 1;
        continue;
      }
      if (await relay.deleteSession(id, purge.value, false)) deleted += 1;
      else failed += 1;
    }
    result.value = `已${purge.value ? '永久删除' : '软删除'} ${deleted} 个会话。`
      + (skipped ? `已跳过 ${skipped} 个状态变化或已移除的会话。` : '')
      + (failed ? `${failed} 个删除失败，可重新清理。` : '');
    if (!relay.selectedSessionId && relay.sessions[0]) {
      await relay.selectSession(relay.sessions[0].id);
    }
  } finally {
    busy.value = false;
    open.value = false;
  }
}
</script>

<template>
  <div class="finished-cleanup">
    <button type="button" :disabled="!finished.length || busy || relay.loadingSessions" @click="requestCleanup">
      {{ busy ? '清理中…' : `一键清理 finished（${finished.length}）` }}
    </button>
    <small v-if="result" role="status">{{ result }}</small>
  </div>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" role="presentation" @click.self="close" @keydown.esc="close">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title" :aria-busy="busy">
        <small>CLEAR FINISHED SESSIONS</small>
        <h2 id="cleanup-title">清理 {{ targets.length }} 个 finished 会话？</h2>
        <p>范围：{{ targetScope }}。仅清理打开此窗口时已 finished 的会话。</p>
        <label class="purge-option">
          <input v-model="purge" type="checkbox" :disabled="busy">
          <span>
            <strong>永久删除</strong>
            <small>会话及数据库关联的事件、命令和审批记录将无法恢复。</small>
          </span>
        </label>
        <p v-if="!purge" class="soft-delete-note">当前为软删除：仅从 Web 列表隐藏，数据库历史数据仍然保留。</p>
        <p v-if="result" role="status">{{ result }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="close">取消</button>
          <button type="button" class="danger" :disabled="busy" @click="cleanup">
            {{ busy ? '清理中…' : purge ? '永久删除全部' : '软删除全部' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.finished-cleanup { display: grid; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #202a34; }
.finished-cleanup button { padding: 7px 10px; border: 1px solid #344251; border-radius: 7px; color: #c5d0da; background: #18212b; cursor: pointer; }
.finished-cleanup button:disabled { opacity: .5; cursor: default; }
.finished-cleanup small { color: #96a6b6; line-height: 1.5; }
</style>
