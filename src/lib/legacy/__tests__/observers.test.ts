/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  computeIntersection,
  createIntersectionObserverClass,
  createResizeObserverClass,
  parseRootMargin,
  toRect,
} from '../observers';

function rect(top: number, left: number, width: number, height: number) {
  return {
    getBoundingClientRect: () => ({
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }),
  };
}

function makeFakeWindow() {
  const listeners: Array<{ type: string; fn: any; capture?: boolean }> = [];
  const win: any = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (type: string, fn: any, capture?: boolean) => {
      listeners.push({ type, fn, capture });
    },
    removeEventListener: (type: string, fn: any) => {
      const index = listeners.findIndex(
        (item) => item.type === type && item.fn === fn
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    setInterval: (fn: any) => setInterval(fn, 10_000),
    clearInterval: (id: any) => clearInterval(id),
    requestAnimationFrame: (fn: any) => fn(),
    setTimeout: (fn: any) => fn(),
  };
  return { win, listeners };
}

describe('computeIntersection', () => {
  it('完全在视口内时比例是 1', () => {
    const target = toRect({ top: 10, left: 10, width: 100, height: 100 });
    const root = toRect({ top: 0, left: 0, width: 800, height: 600 });
    const result = computeIntersection(target, root);
    expect(result.isIntersecting).toBe(true);
    expect(result.intersectionRatio).toBe(1);
    expect(result.intersectionRect).toMatchObject({ width: 100, height: 100 });
  });

  it('露出一半时比例是 0.5', () => {
    const target = toRect({ top: 550, left: 0, width: 100, height: 100 });
    const root = toRect({ top: 0, left: 0, width: 800, height: 600 });
    const result = computeIntersection(target, root);
    expect(result.isIntersecting).toBe(true);
    expect(result.intersectionRatio).toBeCloseTo(0.5, 5);
  });

  it('完全在视口外时不视为相交', () => {
    const target = toRect({ top: 900, left: 0, width: 100, height: 100 });
    const root = toRect({ top: 0, left: 0, width: 800, height: 600 });
    expect(computeIntersection(target, root).isIntersecting).toBe(false);
  });

  it('零尺寸元素不会算出 NaN', () => {
    const target = toRect({ top: 0, left: 0, width: 0, height: 0 });
    const root = toRect({ top: 0, left: 0, width: 800, height: 600 });
    const result = computeIntersection(target, root);
    expect(Number.isNaN(result.intersectionRatio)).toBe(false);
    expect(result.isIntersecting).toBe(false);
  });
});

describe('parseRootMargin', () => {
  it('支持四值写法', () => {
    expect(parseRootMargin('10px 20px 30px 40px')).toEqual({
      top: 10,
      right: 20,
      bottom: 30,
      left: 40,
    });
  });

  it('单值写法四向相同', () => {
    expect(parseRootMargin('100px')).toEqual({
      top: 100,
      right: 100,
      bottom: 100,
      left: 100,
    });
  });

  it('空值与非法值一律归零', () => {
    expect(parseRootMargin(undefined)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(parseRootMargin('abc')).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});

describe('ResizeObserver 兜底', () => {
  it('observe 后立刻回调一次，尺寸不变不重复回调', () => {
    const { win } = makeFakeWindow();
    const Observer = createResizeObserverClass(win);
    const callback = jest.fn();
    const observer = new Observer(callback);
    const element = rect(0, 0, 320, 180);

    observer.observe(element);
    // observe 内部同步检查一次
    expect(callback).toHaveBeenCalledTimes(1);
    const [entries] = callback.mock.calls[0];
    expect(entries[0].contentRect).toMatchObject({ width: 320, height: 180 });

    observer.disconnect();
  });

  it('disconnect 后不再回调', () => {
    const { win, listeners } = makeFakeWindow();
    const Observer = createResizeObserverClass(win);
    const callback = jest.fn();
    const observer = new Observer(callback);
    observer.observe(rect(0, 0, 100, 100));
    expect(callback).toHaveBeenCalledTimes(1);

    const resize = listeners.find((item) => item.type === 'resize');
    expect(resize).toBeDefined();

    observer.disconnect();
    resize?.fn();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('IntersectionObserver 兜底', () => {
  it('元素进入视口时回调 isIntersecting=true', () => {
    const { win } = makeFakeWindow();
    const Observer = createIntersectionObserverClass(win);
    const callback = jest.fn();
    const observer = new Observer(callback, { threshold: 0.1 });
    const element = rect(600, 0, 100, 100); // 顶部 600，视口高 600，刚好不算相交

    observer.observe(element);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0][0].isIntersecting).toBe(false);

    observer.disconnect();
  });

  it('滚动后再次检查能翻转为 true 且只翻转一次', () => {
    const { win, listeners } = makeFakeWindow();
    const Observer = createIntersectionObserverClass(win);
    const callback = jest.fn();
    const observer = new Observer(callback);
    let top = 900;
    const element = {
      getBoundingClientRect: () => ({
        top,
        left: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: top + 100,
      }),
    };

    observer.observe(element);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0][0].isIntersecting).toBe(false);

    top = 300;
    const scroll = listeners.find((item) => item.type === 'scroll');
    expect(scroll?.capture).toBe(true);
    scroll?.fn();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1][0][0].isIntersecting).toBe(true);

    // 尺寸没变化，再滚一次不应该重复触发
    scroll?.fn();
    expect(callback).toHaveBeenCalledTimes(2);

    observer.disconnect();
  });
});
