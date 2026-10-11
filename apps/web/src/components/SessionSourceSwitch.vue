<script setup lang="ts">
const source = defineModel<'local' | 'external'>({ required: true });
defineProps<{ manualCount: number; projectCount: number }>();
</script>

<template>
  <div class="session-source-switch" role="group" aria-label="会话来源">
    <button type="button" :class="{ selected: source === 'local' }" :aria-pressed="source === 'local'" @click="source = 'local'">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 4.5 3 3-3 3M8.5 11.5h4" /></svg>
      <span>手动会话</span><small>{{ manualCount }}</small>
    </button>
    <button type="button" :class="{ selected: source === 'external' }" :aria-pressed="source === 'external'" @click="source = 'external'">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2 5.5 3L8 8 2.5 5 8 2Zm-5.5 6L8 11l5.5-3M2.5 11 8 14l5.5-3" /></svg>
      <span>项目调用</span><small>{{ projectCount }}</small>
    </button>
  </div>
</template>

<style scoped>
.session-source-switch { display: flex; flex: 0 0 auto; gap: 4px; margin: 10px 12px; padding: 4px; border: 1px solid #25303b; border-radius: 8px; background: #0b1118; container-type: inline-size; }
button { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 8px; border: 1px solid transparent; border-radius: 5px; color: #8493a3; background: transparent; font-size: 11px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color .15s, background .15s, border-color .15s; }
button:hover { color: #dce6ee; background: #151d26; }
button.selected { color: #72e0a5; border-color: #2d5040; background: #14251d; }
button:focus-visible { outline: 2px solid #72e0a5; outline-offset: 2px; }
svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
small { min-width: 18px; padding: 1px 4px; border-radius: 4px; color: #8493a3; background: #1d2732; font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.4; }
.selected small { color: #92d9b3; background: #213d2c; }
@container (max-width: 210px) { svg { display: none; } button { gap: 4px; padding-inline: 4px; } small { min-width: 16px; padding-inline: 3px; } }
@media (max-width: 640px) { button { min-height: 40px; font-size: 12px; } }
</style>
