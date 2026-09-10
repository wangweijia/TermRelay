<script setup lang="ts">
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionEventRecord } from '../types';

const props = defineProps<{ events: SessionEventRecord[] }>();
const container = ref<HTMLElement>();
const rendered = new Set<number>();
let terminal: Terminal | undefined;
let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  terminal = new Terminal({
    allowTransparency: false,
    convertEol: false,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 10_000,
    theme: {
      background: '#090d12',
      foreground: '#d9e2ec',
      cursor: '#72e0a5',
      selectionBackground: '#28483a',
    },
  });
  terminal.open(container.value!);
  renderEvents(props.events);
  resizeObserver = new ResizeObserver(resizeTerminal);
  resizeObserver.observe(container.value!);
  resizeTerminal();
});

watch(
  () => props.events,
  (events) => renderEvents(events),
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminal?.dispose();
});

function renderEvents(events: SessionEventRecord[]): void {
  if (!terminal) return;
  for (const event of events) {
    if (event.type !== 'terminal.output' || rendered.has(event.seq)) continue;
    const data = event.payload.data;
    if (typeof data !== 'string') continue;
    terminal.write(decodeBase64(data));
    rendered.add(event.seq);
  }
}

function resizeTerminal(): void {
  if (!terminal || !container.value) return;
  const columns = Math.max(20, Math.floor(container.value.clientWidth / 8));
  const rows = Math.max(8, Math.floor(container.value.clientHeight / 18));
  terminal.resize(columns, rows);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
</script>

<template>
  <div ref="container" class="terminal-view" aria-label="只读终端输出" />
</template>
