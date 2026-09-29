<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { renderAgentMarkdown } from '../agent-markdown';

const props = defineProps<{ sessionId: string; path: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement>();
const name = ref('');
const content = ref('');
const error = ref('');
const loading = ref(false);
const raw = ref(false);
const rendered = computed(() => renderAgentMarkdown(content.value));

watch(() => [props.sessionId, props.path], async (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  name.value = props.path.split('/').at(-1) ?? '文件';
  content.value = '';
  error.value = '';
  raw.value = false;
  loading.value = true;
  await nextTick();
  dialog.value?.focus();
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(props.sessionId)}/file-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: props.path }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json() as { message?: string };
      throw new Error(body.message ?? `文件读取失败 (${response.status})`);
    }
    const result = await response.json() as { name: string; content: string };
    if (!controller.signal.aborted) {
      name.value = result.name;
      content.value = result.content;
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '文件读取失败';
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}, { immediate: true });
</script>

<template>
  <Teleport to="body">
    <div class="file-preview-backdrop" @click.self="emit('close')">
      <section ref="dialog" class="file-preview-dialog" role="dialog" aria-modal="true" :aria-label="`文件预览：${name}`" tabindex="-1" @keydown.esc="emit('close')">
        <header>
          <strong>{{ name }}</strong>
          <button v-if="!loading && !error" type="button" @click="raw = !raw">{{ raw ? '预览' : '原文' }}</button>
          <button type="button" aria-label="关闭文件预览" @click="emit('close')">关闭</button>
        </header>
        <p v-if="loading">正在从 Mac 读取文件…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <pre v-else-if="raw">{{ content }}</pre>
        <div v-else class="agent-markdown" v-html="rendered" />
      </section>
    </div>
  </Teleport>
</template>

<style>
.file-preview-backdrop { position: fixed; inset: 0; z-index: 2000; background: rgb(0 0 0 / 65%); display: grid; place-items: center; padding: 16px; }
.file-preview-dialog { box-sizing: border-box; width: min(900px, 100%); max-height: 90dvh; overflow: auto; padding: 20px; border-radius: 12px; background: #1e2430; color: #eef1f5; }
.file-preview-dialog header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.file-preview-dialog header strong { flex: 1; overflow-wrap: anywhere; }
.file-preview-dialog button { cursor: pointer; }
.file-preview-dialog pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
