<script setup lang="ts">
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionEventRecord } from '../types';

const props = withDefaults(defineProps<{
  events: SessionEventRecord[];
  interactive: boolean;
  mobileComposer?: boolean;
}>(), { mobileComposer: false });
const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [columns: number, rows: number];
}>();
const container = ref<HTMLElement>();
const mobileInput = ref('');
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
    disableStdin: !props.interactive || props.mobileComposer,
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
  terminal.onData((value) => {
    if (props.interactive && !props.mobileComposer) emit('input', new TextEncoder().encode(value));
  });
  renderEvents(props.events);
  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(container.value!);
  scheduleResize();
});

watch(
  () => props.events,
  (events) => renderEvents(events),
);

watch(
  () => props.interactive,
  (interactive) => {
    if (terminal) terminal.options.disableStdin = !interactive || props.mobileComposer;
  },
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
  if (props.interactive) emit('resize', columns, rows);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sendMobileInput(): void {
  if (!props.interactive || !mobileInput.value) return;
  emit('input', new TextEncoder().encode(`${mobileInput.value}\r`));
  mobileInput.value = '';
}
</script>

<template>
  <section class="terminal-view" :class="{ 'mobile-terminal-composer': mobileComposer }" aria-label="远程交互终端">
    <div ref="container" class="terminal-canvas" />
    <form v-if="mobileComposer" class="terminal-composer" @submit.prevent="sendMobileInput">
      <input v-model="mobileInput" type="text" enterkeyhint="send" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入 Shell 命令" :disabled="!interactive">
      <button type="submit" :disabled="!interactive || !mobileInput">发送</button>
    </form>
  </section>
</template>
