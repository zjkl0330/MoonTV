/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * ResizeObserver / IntersectionObserver 的老浏览器兜底实现。
 *
 * 原生实现不可用时的降级替代：
 * - 用 rAF/定时器 + getBoundingClientRect 轮询，精度换兼容；
 * - 只实现项目实际用到的部分（observe/unobserve/disconnect/takeRecords），
 *   刻意不做的：rootMargin 的像素级精细语义、多 root 的复杂裁剪。
 *
 * 依赖注入 win（而不是直接摸 window），方便在 jsdom 里单测。
 */

export interface RectLike {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface IntersectionResult {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: RectLike;
}

const EMPTY_RECT: RectLike = {
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
};

/** 把 getBoundingClientRect 的返回值裁剪成纯数据，避免持有活的 DOMRect */
export function toRect(raw: any): RectLike {
  if (!raw) return { ...EMPTY_RECT };
  const top = Number(raw.top) || 0;
  const left = Number(raw.left) || 0;
  const right =
    typeof raw.right === 'number' ? raw.right : left + (Number(raw.width) || 0);
  const bottom =
    typeof raw.bottom === 'number'
      ? raw.bottom
      : top + (Number(raw.height) || 0);
  return {
    top,
    left,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * 计算目标元素与 root 的相交情况（纯函数，方便单测）。
 */
export function computeIntersection(
  target: RectLike,
  root: RectLike
): IntersectionResult {
  const top = Math.max(target.top, root.top);
  const left = Math.max(target.left, root.left);
  const bottom = Math.min(target.bottom, root.bottom);
  const right = Math.min(target.right, root.right);

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const intersectionRect: RectLike = {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };

  const targetArea = target.width * target.height;
  const isIntersecting = width > 0 && height > 0;
  const intersectionRatio =
    targetArea > 0
      ? Math.min(1, (width * height) / targetArea)
      : isIntersecting
      ? 1
      : 0;

  return { isIntersecting, intersectionRatio, intersectionRect };
}

/** 解析 rootMargin，只支持单值或四值（单位 px/%），解析不了就返回 0 */
export function parseRootMargin(margin?: string): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!margin) return zero;
  const parts = String(margin).trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return zero;

  const nums = parts.map((part) => {
    const matched = /^(-?[\d.]+)(px|%)?$/.exec(part);
    // 百分比要按 root 尺寸算，这里不知道尺寸，直接当 0 处理，宁可少一点判定
    if (!matched || matched[2] === '%') return 0;
    return Number(matched[1]) || 0;
  });

  const [a, b = a, c = a, d = b] = nums;
  return { top: a, right: b, bottom: c, left: d };
}

function now(): number {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * ResizeObserver 兜底：轮询尺寸变化。
 */
export function createResizeObserverClass(win: any) {
  return class ResizeObserverPolyfill {
    private _cb: (entries: any[], observer: any) => void;

    private _targets: Array<{ target: any; width: number; height: number }> =
      [];

    private _timer: any = null;

    private _onWindowResize = () => this._check();

    constructor(callback: (entries: any[], observer: any) => void) {
      this._cb = callback;
      if (win && win.addEventListener) {
        win.addEventListener('resize', this._onWindowResize);
        win.addEventListener('orientationchange', this._onWindowResize);
      }
      this._timer =
        win && win.setInterval
          ? win.setInterval(() => this._check(), 250)
          : null;
    }

    observe(target: any): void {
      if (!target || this._targets.some((item) => item.target === target))
        return;
      this._targets.push({ target, width: -1, height: -1 });
      this._check();
    }

    unobserve(target: any): void {
      this._targets = this._targets.filter((item) => item.target !== target);
    }

    disconnect(): void {
      this._targets = [];
      if (this._timer !== null && win && win.clearInterval) {
        win.clearInterval(this._timer);
      }
      this._timer = null;
      if (win && win.removeEventListener) {
        win.removeEventListener('resize', this._onWindowResize);
        win.removeEventListener('orientationchange', this._onWindowResize);
      }
    }

    private _check(): void {
      if (!this._targets.length) return;

      const entries: any[] = [];
      this._targets = this._targets.filter((item) => {
        let rect: RectLike;
        try {
          rect = toRect(item.target.getBoundingClientRect?.());
        } catch {
          return false;
        }
        if (rect.width === item.width && rect.height === item.height)
          return true;

        item.width = rect.width;
        item.height = rect.height;
        entries.push({
          target: item.target,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        });
        return true;
      });

      if (!entries.length) return;
      try {
        this._cb(entries, this);
      } catch (err) {
        console.error('[legacy] ResizeObserver 回调异常', err);
      }
    }
  };
}

/**
 * IntersectionObserver 兜底：监听滚动/窗口变化，按 isIntersecting 翻转触发回调。
 */
export function createIntersectionObserverClass(win: any) {
  return class IntersectionObserverPolyfill {
    readonly root: any;

    readonly rootMargin: string;

    readonly thresholds: number[];

    private _cb: (entries: any[], observer: any) => void;

    private _targets: Array<{ target: any; isIntersecting: boolean | null }> =
      [];

    private _checkQueued = false;

    private _onScroll = () => this._schedule();

    constructor(
      callback: (entries: any[], observer: any) => void,
      options?: {
        root?: any;
        rootMargin?: string;
        threshold?: number | number[];
      }
    ) {
      this._cb = callback;
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? '0px';
      const threshold = options?.threshold ?? 0;
      this.thresholds = Array.isArray(threshold) ? threshold : [threshold];

      if (win && win.addEventListener) {
        // capture 才能收到容器内部的 scroll 事件（scroll 不冒泡）
        win.addEventListener('scroll', this._onScroll, true);
        win.addEventListener('resize', this._onScroll);
        win.addEventListener('orientationchange', this._onScroll);
      }
    }

    observe(target: any): void {
      if (!target || this._targets.some((item) => item.target === target))
        return;
      this._targets.push({ target, isIntersecting: null });
      this._schedule();
    }

    unobserve(target: any): void {
      this._targets = this._targets.filter((item) => item.target !== target);
    }

    disconnect(): void {
      this._targets = [];
      if (win && win.removeEventListener) {
        win.removeEventListener('scroll', this._onScroll, true);
        win.removeEventListener('resize', this._onScroll);
        win.removeEventListener('orientationchange', this._onScroll);
      }
    }

    takeRecords(): any[] {
      return [];
    }

    private _schedule(): void {
      if (this._checkQueued) return;
      this._checkQueued = true;
      const run = () => {
        this._checkQueued = false;
        this._check();
      };
      if (win && win.requestAnimationFrame) {
        win.requestAnimationFrame(run);
      } else if (win && win.setTimeout) {
        win.setTimeout(run, 16);
      } else {
        run();
      }
    }

    private _rootRect(): RectLike {
      if (this.root && typeof this.root.getBoundingClientRect === 'function') {
        return toRect(this.root.getBoundingClientRect());
      }
      const width = Number(win?.innerWidth) || 0;
      const height = Number(win?.innerHeight) || 0;
      return { top: 0, left: 0, right: width, bottom: height, width, height };
    }

    private _check(): void {
      if (!this._targets.length) return;

      const margin = parseRootMargin(this.rootMargin);
      const rootRect = this._rootRect();
      const paddedRoot: RectLike = {
        top: rootRect.top - margin.top,
        left: rootRect.left - margin.left,
        right: rootRect.right + margin.right,
        bottom: rootRect.bottom + margin.bottom,
        width: rootRect.width + margin.left + margin.right,
        height: rootRect.height + margin.top + margin.bottom,
      };

      const entries: any[] = [];
      this._targets = this._targets.filter((item) => {
        let targetRect: RectLike;
        try {
          targetRect = toRect(item.target.getBoundingClientRect?.());
        } catch {
          return false;
        }

        const result = computeIntersection(targetRect, paddedRoot);
        if (item.isIntersecting === result.isIntersecting) return true;

        item.isIntersecting = result.isIntersecting;
        entries.push({
          target: item.target,
          isIntersecting: result.isIntersecting,
          intersectionRatio: result.intersectionRatio,
          boundingClientRect: targetRect,
          intersectionRect: result.intersectionRect,
          rootBounds: paddedRoot,
          time: now(),
        });
        return true;
      });

      if (!entries.length) return;
      try {
        this._cb(entries, this);
      } catch (err) {
        console.error('[legacy] IntersectionObserver 回调异常', err);
      }
    }
  };
}
