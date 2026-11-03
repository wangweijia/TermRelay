<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { AttachmentMetadata } from '@termrelay/contracts';
import { downloadAttachment } from '../attachments';
defineEmits<{ resize: [] }>();
const props = defineProps<{ sessionId: string; attachment: AttachmentMetadata }>();
const preview = ref('');
const error = ref('');
const busy = ref(false);
const controller = new AbortController();
onBeforeUnmount(() => { controller.abort(); if (preview.value) URL.revokeObjectURL(preview.value); });
async function open(): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const blob = await downloadAttachment(props.sessionId, props.attachment, controller.signal);
    if (props.attachment.mimeType.startsWith('image/')) {
      if (preview.value) URL.revokeObjectURL(preview.value);
      preview.value = URL.createObjectURL(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = props.attachment.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '附件不可用'; }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="chat-attachment">
    <button type="button" :disabled="busy" @click="open">{{ busy ? '正在读取…' : attachment.name }} · {{ Math.ceil(attachment.size / 1024) }} KiB {{ attachment.mimeType.startsWith('image/') ? '查看图片' : '下载' }}</button>
    <img v-if="preview" :src="preview" :alt="attachment.name" @load="$emit('resize')">
    <p v-if="error" role="status">{{ error }}</p>
  </div>
</template>
<style scoped>
.chat-attachment { margin-top: 8px; overflow-wrap: anywhere; }
.chat-attachment img { display: block; max-width: 100%; max-height: 360px; margin-top: 8px; object-fit: contain; }
.chat-attachment p { color: #ffb4ab; }
</style>
