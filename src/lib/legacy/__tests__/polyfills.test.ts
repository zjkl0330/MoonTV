/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  installAbortController,
  installArrayPolyfills,
  installObjectPolyfills,
  installPromisePolyfills,
  installStringPolyfills,
} from '../polyfills';

/** 临时删掉某个原生方法，模拟老浏览器，测完必须还原 */
function withoutNative<T>(holder: any, key: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  delete holder[key];
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(holder, key, descriptor);
    else delete holder[key];
  }
}

/** 异步版本：等 await 走完再还原原生实现 */
async function withoutNativeAsync<T>(
  holder: any,
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  delete holder[key];
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(holder, key, descriptor);
    else delete holder[key];
  }
}

describe('installStringPolyfills', () => {
  it('replaceAll 字符串与全局正则语义正确', () => {
    withoutNative(String.prototype, 'replaceAll', () => {
      const installed = installStringPolyfills(globalThis);
      expect(installed).toContain('String.prototype.replaceAll');

      expect('a b c'.replaceAll(' ', '')).toBe('abc');
      expect('a1b1c'.replaceAll(/1/g, '-')).toBe('a-b-c');
      // $& 语义要与原生一致
      expect('abc'.replaceAll('b', '[$&]')).toBe('a[b]c');
      // 非全局正则必须抛错
      expect(() => 'abc'.replaceAll(/b/, '-')).toThrow(TypeError);
      // 特殊字符按字面量处理
      expect('a.b.c'.replaceAll('.', '/')).toBe('a/b/c');
    });
  });

  it('padStart / padEnd / at / trimStart', () => {
    withoutNative(String.prototype, 'padStart', () => {
      withoutNative(String.prototype, 'padEnd', () => {
        withoutNative(String.prototype, 'at', () => {
          const installed = installStringPolyfills(globalThis);
          expect(installed).toEqual(
            expect.arrayContaining([
              'String.prototype.padStart',
              'String.prototype.padEnd',
              'String.prototype.at',
            ])
          );
          expect('5'.padStart(3, '0')).toBe('005');
          expect('5'.padEnd(3, '0')).toBe('500');
          expect('abc'.padStart(2, '0')).toBe('abc');
          expect('abc'.at(-1)).toBe('c');
          expect('abc'.at(5)).toBeUndefined();
        });
      });
    });
  });
});

describe('installArrayPolyfills', () => {
  it('at / flat / flatMap / includes', () => {
    withoutNative(Array.prototype, 'at', () => {
      withoutNative(Array.prototype, 'flat', () => {
        withoutNative(Array.prototype, 'flatMap', () => {
          const installed = installArrayPolyfills(globalThis);
          expect(installed).toEqual(
            expect.arrayContaining([
              'Array.prototype.at',
              'Array.prototype.flat',
              'Array.prototype.flatMap',
            ])
          );
          expect([1, 2, 3].at(-1)).toBe(3);
          expect([1, [2, [3]]].flat()).toEqual([1, 2, [3]]);
          expect([1, [2, [3]]].flat(2)).toEqual([1, 2, 3]);
          expect([1, 2].flatMap((n) => [n, n])).toEqual([1, 1, 2, 2]);
          expect([NaN].includes(NaN)).toBe(true);
        });
      });
    });
  });
});

describe('installObjectPolyfills', () => {
  it('fromEntries / entries / values', () => {
    withoutNative(Object, 'fromEntries', () => {
      const installed = installObjectPolyfills(globalThis);
      expect(installed).toContain('Object.fromEntries');
      expect(Object.fromEntries([['a', 1]])).toEqual({ a: 1 });
      expect(Object.fromEntries(new Map([['b', 2]]))).toEqual({ b: 2 });
    });
  });
});

describe('installPromisePolyfills', () => {
  it('allSettled 汇总两种状态且顺序不变', async () => {
    await withoutNativeAsync(Promise, 'allSettled', async () => {
      const installed = installPromisePolyfills(globalThis);
      expect(installed).toContain('Promise.allSettled');

      const result = await (Promise as any).allSettled([
        Promise.resolve(1),
        Promise.reject(new Error('boom')),
      ]);
      expect(result[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(result[1].status).toBe('rejected');
      expect(result[1].reason.message).toBe('boom');
    });
  });

  it('finally 不改变结果值', async () => {
    await withoutNativeAsync(Promise.prototype, 'finally', async () => {
      const installed = installPromisePolyfills(globalThis);
      expect(installed).toContain('Promise.prototype.finally');
      const onFinally = jest.fn();
      await expect(Promise.resolve('ok').finally(onFinally)).resolves.toBe(
        'ok'
      );
      expect(onFinally).toHaveBeenCalledTimes(1);
    });
  });

  it('空数组直接 resolve 空结果', async () => {
    await withoutNativeAsync(Promise, 'allSettled', async () => {
      installPromisePolyfills(globalThis);
      await expect((Promise as any).allSettled([])).resolves.toEqual([]);
    });
  });
});

describe('installAbortController', () => {
  it('伪造的 signal 能通知监听器并带上 AbortError', () => {
    const sandbox: any = { DOMException: (globalThis as any).DOMException };

    const installed = installAbortController(sandbox);
    expect(installed).toEqual(
      expect.arrayContaining(['AbortController', 'AbortSignal'])
    );

    const controller = new sandbox.AbortController();
    const listener = jest.fn();
    controller.signal.addEventListener('abort', listener);
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.signal.reason.name).toBe('AbortError');
  });

  it('包一层 fetch，让超时能真正 reject', async () => {
    const fakeFetch = jest.fn(() => new Promise(() => undefined));
    const scope: any = {
      fetch: fakeFetch,
      DOMException: (globalThis as any).DOMException,
    };

    const installed = installAbortController(scope);
    expect(installed).toContain('AbortController');

    const controller = new scope.AbortController();
    const promise = scope.fetch('/api', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
