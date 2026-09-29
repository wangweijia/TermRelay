export function createUuid(): string {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  if (typeof window.crypto?.getRandomValues !== 'function') {
    throw new Error('浏览器不支持安全随机数，无法生成任务 ID。');
  }

  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
