export function validateRegion(rect, viewport) {
  if (!rect || !viewport || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    || !['width', 'height'].every(key => Number.isFinite(viewport[key]) && viewport[key] > 0 && viewport[key] <= 20_000)
    || rect.x < 0 || rect.y < 0 || rect.width < 8 || rect.height < 8
    || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) {
    throw new Error('截图区域无效，请在当前可见页面内重新框选。');
  }
  return { rect, viewport };
}

export async function captureRegion(tab, rect, viewport) {
  validateRegion(rect, viewport);
  const active = async () => {
    const [current] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (current?.id !== tab.id || current.url !== tab.url) throw new Error('页面或标签页已变化，请重新截图。');
  };
  await active();
  let captured;
  try { captured = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
  catch { throw new Error('截图未获授权。请先点击工具栏“点点改”图标，再选择“截图提建议”。'); }
  await active();
  const bitmap = await createImageBitmap(await (await fetch(captured)).blob());
  try {
    const scaleX = bitmap.width / viewport.width, scaleY = bitmap.height / viewport.height;
    if (Math.abs(scaleX / scaleY - 1) > 0.03) throw new Error('窗口尺寸已变化，请重新截图。');
    let scale = Math.min(1, 1600 / Math.max(rect.width * scaleX, rect.height * scaleY));
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.round(rect.width * scaleX * scale));
      const height = Math.max(1, Math.round(rect.height * scaleY * scale));
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size <= 1_048_576) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { dataURL: `data:image/png;base64,${btoa(binary)}`, width, height };
      }
      scale *= 0.75;
    }
    throw new Error('截图超过 1 MB，请缩小框选区域后重试。');
  } finally { bitmap.close(); }
}