/* eslint-disable @typescript-eslint/no-explicit-any */

import { copyText, legacyCopy } from '../clipboard';

describe('clipboard 兜底', () => {
  const originalClipboard = (navigator as any).clipboard;
  const originalExecCommand = (document as any).execCommand;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    (document as any).execCommand = originalExecCommand;
    document.body.innerHTML = '';
  });

  it('现代浏览器走 navigator.clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await expect(copyText('https://example.com/a.m3u8')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://example.com/a.m3u8');
  });

  it('clipboard 被拒绝时退回 execCommand', async () => {
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    (document as any).execCommand = jest.fn().mockReturnValue(true);

    await expect(copyText('abc')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect((document as any).execCommand).toHaveBeenCalledWith('copy');
  });

  it('没有 clipboard 且没有 execCommand 时返回 false', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    (document as any).execCommand = undefined;

    await expect(copyText('abc')).resolves.toBe(false);
  });

  it('execCommand 兜底用完会清理临时 textarea', () => {
    (document as any).execCommand = jest.fn().mockReturnValue(true);
    expect(legacyCopy('hello')).toBe(true);
    expect(document.body.querySelector('textarea')).toBeNull();
  });
});
