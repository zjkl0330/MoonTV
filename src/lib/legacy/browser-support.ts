/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 老浏览器能力探测。
 *
 * 这里只做「纯判断」，不产生副作用，方便单测与降级分支复用。
 * 真正的补丁在 ./polyfills.ts，安装顺序：本文件只描述现状，
 * 补完之后再探测会得到补完后的能力（LegacySupport 就是这么用的）。
 */

/** 站点的最低可用基线：能跑 ES Module + fetch 的浏览器 */
export interface BrowserEnv {
  /** <script type="module">，低于它 React 根本不会启动 */
  modules: boolean;
  promise: boolean;
  fetch: boolean;
  /** MediaSource，hls.js 的硬前提 */
  mse: boolean;
  /** video.canPlayType('application/vnd.apple.mpegurl')，iOS/Safari 原生 HLS */
  nativeHls: boolean;
  intersectionObserver: boolean;
  resizeObserver: boolean;
  abortController: boolean;
  clipboard: boolean;
  worker: boolean;
}

export const EMPTY_ENV: BrowserEnv = {
  modules: false,
  promise: false,
  fetch: false,
  mse: false,
  nativeHls: false,
  intersectionObserver: false,
  resizeObserver: false,
  abortController: false,
  clipboard: false,
  worker: false,
};

const FEATURE_LABELS: Record<keyof BrowserEnv, string> = {
  modules: 'ES Module',
  promise: 'Promise',
  fetch: 'fetch',
  mse: 'MediaSource（HLS 播放）',
  nativeHls: '原生 HLS',
  intersectionObserver: 'IntersectionObserver',
  resizeObserver: 'ResizeObserver',
  abortController: 'AbortController',
  clipboard: '剪贴板 API',
  worker: 'Web Worker',
};

/** 缺了就真没法用（补丁也补不回来）的能力 */
const BLOCKING_FEATURES: Array<keyof BrowserEnv> = [
  'modules',
  'promise',
  'fetch',
];

/** 缺了只影响部分功能（可以用补丁或降级路径顶上）的能力 */
const DEGRADABLE_FEATURES: Array<keyof BrowserEnv> = [
  'intersectionObserver',
  'resizeObserver',
  'abortController',
  'clipboard',
  'worker',
];

function hasMse(win: any): boolean {
  const MS = win && win.MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return false;
  // 只判断「有没有」，具体编码格式交给 hls.js 自己挑
  return (
    MS.isTypeSupported('video/mp4;codecs="avc1.42E01E,mp4a.40.2"') ||
    MS.isTypeSupported('video/mp4')
  );
}

function hasNativeHls(doc: any): boolean {
  try {
    const video = doc && doc.createElement ? doc.createElement('video') : null;
    if (!video || typeof video.canPlayType !== 'function') return false;
    return Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  } catch {
    return false;
  }
}

/**
 * 读取当前运行环境的能力。服务端调用一律返回全 false。
 */
export function readBrowserEnv(): BrowserEnv {
  if (typeof window === 'undefined') return { ...EMPTY_ENV };

  const win = window as any;
  const doc = typeof document === 'undefined' ? null : (document as any);

  return {
    modules: 'noModule' in (doc ? doc.createElement('script') : {}),
    promise: typeof win.Promise === 'function',
    fetch: typeof win.fetch === 'function',
    mse: hasMse(win),
    nativeHls: hasNativeHls(doc),
    intersectionObserver: typeof win.IntersectionObserver === 'function',
    resizeObserver: typeof win.ResizeObserver === 'function',
    abortController: typeof win.AbortController === 'function',
    clipboard: Boolean(win.navigator && win.navigator.clipboard),
    worker: typeof win.Worker === 'function',
  };
}

/** 缺失但会导致整站白屏的能力 */
export function blockingMissing(env: BrowserEnv): Array<keyof BrowserEnv> {
  return BLOCKING_FEATURES.filter((key) => !env[key]);
}

/** 缺失但可以降级的能力 */
export function degradableMissing(env: BrowserEnv): Array<keyof BrowserEnv> {
  return DEGRADABLE_FEATURES.filter((key) => !env[key]);
}

/** 缺失能力的可读名称，用于提示文案 */
export function describeFeatures(keys: Array<keyof BrowserEnv>): string[] {
  return keys.map((key) => FEATURE_LABELS[key] || String(key));
}

export type HlsStrategy = 'hlsjs' | 'native' | 'unsupported';

/**
 * 决定 m3u8 怎么播：
 * - 有 MediaSource → hls.js（功能最全，能去广告、能选清晰度）
 * - 没有 MSE 但有原生 HLS → 交还给 video 元素（老 Safari/iOS）
 * - 都没有 → 明确告知不支持，而不是静默黑屏
 */
export function hlsStrategy(env: BrowserEnv): HlsStrategy {
  if (env.mse) return 'hlsjs';
  if (env.nativeHls) return 'native';
  return 'unsupported';
}

export interface OlderDeviceHint {
  /** 部分老 WebView/Android 上 blob worker 会直接崩，必须关掉 */
  worker: boolean;
  /** 粗略的内核主版本号，取不到为 null */
  chromeMajor: number | null;
  androidMajor: number | null;
}

/** 从 UA 里抠出内核版本，抠不到返回 null */
export function parseOlderDeviceHint(userAgent: string): OlderDeviceHint {
  const ua = String(userAgent || '');

  const chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(ua);
  const android = /Android\s+(\d+)/.exec(ua);

  return {
    worker: !/Android\s+(?:[0-5])\./.test(ua),
    chromeMajor: chrome ? Number(chrome[1]) : null,
    androidMajor: android ? Number(android[1]) : null,
  };
}

/**
 * 是否让 hls.js 用 Web Worker 解码。
 *
 * 老 Android WebView（4.x/5.x）与 Chrome 53 以下的 blob worker 经常直接报错，
 * 关掉 worker 走主线程虽然费点 CPU，但至少能播。
 */
export function shouldUseHlsWorker(
  env: Pick<BrowserEnv, 'worker'>,
  hint?: OlderDeviceHint
): boolean {
  if (!env.worker) return false;
  if (!hint) return true;
  if (!hint.worker) return false;
  if (hint.androidMajor !== null && hint.androidMajor <= 5) return false;
  if (hint.chromeMajor !== null && hint.chromeMajor < 53) return false;
  return true;
}
