type CopyField = Pick<HTMLInputElement, 'value' | 'focus' | 'select' | 'setSelectionRange'>;
interface ClipboardEnvironment {
  clipboard?: Pick<Clipboard, 'writeText'>;
  copySelection: () => boolean;
}

export function selectCopyText(text: string, field: CopyField): void {
  field.value = text;
  field.focus();
  field.select();
  field.setSelectionRange(0, text.length);
}

// Keep the visible field selected if both browser copy mechanisms are denied.
// execCommand is a compatibility fallback for LAN HTTP pages without Clipboard API.
export async function copyText(
  text: string,
  field: CopyField | undefined,
  environment: ClipboardEnvironment = {
    clipboard: navigator.clipboard,
    copySelection: () => document.execCommand('copy'),
  },
): Promise<boolean> {
  if (environment.clipboard) {
    try { await environment.clipboard.writeText(text); return true; }
    catch { /* Try selection-based copying instead. */ }
  }
  if (!field) return false;
  selectCopyText(text, field);
  try { return environment.copySelection(); }
  catch { return false; }
}
