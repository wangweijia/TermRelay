<script setup lang="ts">
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SessionEventRecord } from '../types';

const props = withDefaults(defineProps<{
  events: SessionEventRecord[];
  interactive: boolean;
  mobileComposer?: boolean;
  scrollRevision?: number;
}>(), { mobileComposer: false, scrollRevision: 0 });
const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [columns: number, rows: number];
}>();
const container = ref<HTMLElement>();
const mobileInput = ref('');
let highestRenderedSeq = -1;
let terminal: Terminal | undefined;
let resizeObserver: ResizeObserver | undefined;
let lastSize: { columns: number; rows: number } | undefined;
let resizeFrame: number | undefined;
let terminalPinnedToBottom = true;
let processedEventCount = 0;
let processedLastSeq: number | undefined;
const pendingWrites: Array<{ data: Uint8Array; scroll: boolean }> = [];
let drainingWrites = false;
let disposed = false;
const MAX_WRITE_CHUNK_BYTES = 256 * 1_024;

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
  terminal.onScroll(() => {
    if (!terminal) return;
    terminalPinnedToBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  });
  renderEvents(props.events, true);
  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(container.value!);
  scheduleResize();
});

watch(
  () => props.events,
  (events) => renderEvents(events),
);

watch(
  () => props.scrollRevision,
  () => scrollToLatest(),
);

watch(
  () => props.interactive,
  (interactive) => {
    if (terminal) terminal.options.disableStdin = !interactive || props.mobileComposer;
  },
);

onBeforeUnmount(() => {
  disposed = true;
  pendingWrites.length = 0;
  resizeObserver?.disconnect();
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
  terminal?.dispose();
});

function renderEvents(events: SessionEventRecord[], forceScroll = false): void {
  if (!terminal) return;
  const shouldScroll = forceScroll || terminalPinnedToBottom;
  const output: Uint8Array[] = [];
  const prefixChanged = processedEventCount > events.length || (
    processedEventCount > 0 && events[processedEventCount - 1]?.seq !== processedLastSeq
  );
  const startIndex = prefixChanged ? 0 : processedEventCount;
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type !== 'terminal.output' || event.seq <= highestRenderedSeq) continue;
    const data = event.payload.data;
    if (typeof data !== 'string') continue;
    output.push(decodeBase64(data));
    highestRenderedSeq = event.seq;
  }
  processedEventCount = events.length;
  processedLastSeq = events.at(-1)?.seq;
  const chunks = combineChunks(output, MAX_WRITE_CHUNK_BYTES);
  chunks.forEach((data, index) => {
    pendingWrites.push({ data, scroll: index === chunks.length - 1 && shouldScroll });
  });
  drainWrites();
  if (forceScroll && !output.length) scrollToLatest();
}

function drainWrites(): void {
  if (drainingWrites || disposed || !terminal) return;
  const next = pendingWrites.shift();
  if (!next) return;
  drainingWrites = true;
  terminal.write(next.data, () => {
    if (next.scroll) scrollToLatest();
    drainingWrites = false;
    if (pendingWrites.length) requestAnimationFrame(drainWrites);
  });
}

function combineChunks(values: Uint8Array[], maximumBytes: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  let size = 0;
  const flush = () => {
    if (!size) return;
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    result.push(combined);
    parts = [];
    size = 0;
  };
  for (const value of values) {
    if (size > 0 && size + value.byteLength > maximumBytes) flush();
    if (value.byteLength <= maximumBytes) {
      parts.push(value);
      size += value.byteLength;
      continue;
    }
    flush();
    for (let offset = 0; offset < value.byteLength; offset += maximumBytes) {
      result.push(value.slice(offset, offset + maximumBytes));
    }
  }
  flush();
  return result;
}

function scrollToLatest(): void {
  requestAnimationFrame(() => {
    terminal?.scrollToBottom();
    terminalPinnedToBottom = true;
  });
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
