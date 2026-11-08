/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 复制文本到剪贴板。
 *
 * navigator.clipboard 要 Chrome 66+ / Safari 13.1+，而且要求安全上下文（https/localhost）。
 * 老浏览器与 http 页面一律走 textarea + execCommand('copy') 兜底。
 */

/** 老浏览器兜底方案：造一个隐藏 textarea 选中后 execCommand */
export function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const doc: any = document;
  if (typeof doc.execCommand !== 'function') return false;

  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';

  const host = doc.body || doc.documentElement;
  if (!host) return false;
  host.appendChild(textarea);

  const selection = doc.getSelection ? doc.getSelection() : null;
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let ok = false;
  try {
    textarea.focus();
    textarea.select();
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, text.length);
    }
    ok = doc.execCommand('copy') === true;
  } catch (err) {
    console.warn('[legacy] execCommand 复制失败', err);
    ok = false;
  } finally {
    if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    if (selection) {
      selection.removeAllRanges();
      if (previousRange) selection.addRange(previousRange);
    }
  }

  return ok;
}

/**
 * 优先用异步剪贴板 API，不可用/被拒绝时退回 execCommand。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text);

  if (
    typeof navigator !== 'undefined' &&
    (navigator as any).clipboard?.writeText
  ) {
    try {
      await (navigator as any).clipboard.writeText(value);
      return true;
    } catch (err) {
      // 非安全上下文或用户拒绝授权，继续走兜底
      console.warn('[legacy] clipboard API 不可用，改用 execCommand', err);
    }
  }

  return legacyCopy(value);
}
