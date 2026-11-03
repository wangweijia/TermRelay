import { createUuid } from './uuid';
import type { AttachmentMetadata, AttachmentResultPayload } from '@termrelay/contracts';

export const attachmentAccept = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.markdown';
const chunkSize = 192 * 1024;
const maximumFileSize = 20 * 1024 * 1024;
const mimeTypes: Record<string, AttachmentMetadata['mimeType']> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
};

export function attachmentMetadata(file: File): AttachmentMetadata {
  const mimeType = mimeTypes[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!mimeType || !file.size || file.size > maximumFileSize) throw new Error('支持 PNG、JPEG、WebP、PDF、TXT、Markdown，单文件最多 20 MiB');
  return { id: createUuid(), name: file.name, mimeType, size: file.size };
}

export async function transferAttachment(sessionId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<AttachmentResultPayload> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const result = await response.json() as AttachmentResultPayload & { message?: string };
  if (!response.ok || result.status !== 'ok') throw new Error(result.message ?? `附件传输失败 (${response.status})`);
  return result;
}

function encode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function uploadAttachment(sessionId: string, file: File, attachment: AttachmentMetadata, progress: (value: number) => void, signal: AbortSignal): Promise<void> {
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const data = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await transferAttachment(sessionId, {
          operation: 'upload', attachmentId: attachment.id, attachment, offset,
          data: encode(data), final: offset + data.length === file.size,
        }, signal);
        failure = undefined; break;
      } catch (error) { failure = error; if (signal.aborted) throw error; }
    }
    if (failure) throw failure;
    progress(Math.round(Math.min(offset + data.length, file.size) / file.size * 100));
  }
}

export async function downloadAttachment(sessionId: string, attachment: AttachmentMetadata, signal: AbortSignal): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < attachment.size) {
    const result = await transferAttachment(sessionId, { operation: 'read', attachmentId: attachment.id, offset }, signal);
    if (!result.data || result.attachment?.id !== attachment.id || result.attachment.size !== attachment.size) throw new Error('附件内容不完整或已清理');
    const data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
    if (!data.length || offset + data.length > attachment.size) throw new Error('附件大小不一致');
    chunks.push(data); offset += data.length;
  }
  return new Blob(chunks, { type: attachment.mimeType });
}
