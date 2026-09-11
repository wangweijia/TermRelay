<script setup lang="ts">
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionEventRecord } from '../types';

const props = defineProps<{ events: SessionEventRecord[] }>();
const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [columns: number, rows: number];
}>();
const container = ref<HTMLElement>();
const rendered = new Set<number>();
let terminal: Terminal | undefined;
let resizeObserver: ResizeObserver | undefined;
let lastSize: { columns: number; rows: number } | undefined;
let resizeFrame: number | undefined;

onMounted(() => {
  terminal = new Terminal({
    allowTransparency: false,
    convertEol: false,
    cursorBlink: false,
    disableStdin: false,
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
  terminal.onData((value) => emit('input', new TextEncoder().encode(value)));
  renderEvents(props.events);
  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(container.value!);
  scheduleResize();
});

watch(
  () => props.events,
  (events) => renderEvents(events),
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
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

function scheduleResize(): void {
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = undefined;
    resizeTerminal();
  });
}

function resizeTerminal(): void {
  if (!terminal || !container.value) return;
  const style = window.getComputedStyle(container.value);
  const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const contentWidth = Math.max(0, container.value.clientWidth - horizontalPadding);
  const contentHeight = Math.max(0, container.value.clientHeight - verticalPadding);
  const columns = Math.max(20, Math.floor(contentWidth / 8));
  const rows = Math.max(8, Math.floor(contentHeight / 18));
  if (lastSize?.columns === columns && lastSize.rows === rows) return;
  lastSize = { columns, rows };
  terminal.resize(columns, rows);
  emit('resize', columns, rows);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
</script>

<template>
  <div ref="container" class="terminal-view" aria-label="远程交互终端" />
</template>
