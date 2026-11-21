/* eslint-disable @typescript-eslint/no-explicit-any */

// video.style.filter 只允许这一个模块写入：亮度手势和画质增强各自赋值会互相覆盖。
// 画质增强有两条路径：
// - gpu：WebGL 片元着色器做 unsharp mask，GPU 承担主要计算；
// - css：SVG feConvolveMatrix，兼容没有 WebGL 的老设备，但更吃性能。

import {
  effectiveTier,
  getDeviceProfile,
  readPerformanceMode,
} from './deviceProfile';
import { canUseGpuEnhance, GpuVideoEnhancer } from './gpuEnhance';

export const ENHANCE_KEY = 'player_video_enhance';
export const SHARPEN_FILTER_ID = 'moontv-sharpen';

export type EnhanceMode = 'off' | 'auto' | 'gpu' | 'css';

// 3x3 轻度锐化卷积核，系数和为 1，所以不会整体提亮或压暗
const SHARPEN_KERNEL = '0 -0.2 0 -0.2 1.8 -0.2 0 -0.2 0';
const SHARPEN_SVG_STYLE = 'position:absolute;width:0;height:0;overflow:hidden';

export interface FilterPrefs {
  brightness: number;
  enhance: boolean;
  /** 未指定时按兼容模式（CSS）处理，兼容旧调用方 */
  mode?: EnhanceMode;
}

const prefsByVideo = new WeakMap<HTMLVideoElement, FilterPrefs>();
const enhancersByVideo = new WeakMap<HTMLVideoElement, GpuVideoEnhancer>();

function prefsFor(video: HTMLVideoElement): FilterPrefs {
  let prefs = prefsByVideo.get(video);
  if (!prefs) {
    prefs = { brightness: 1, enhance: false, mode: 'off' };
    prefsByVideo.set(video, prefs);
  }
  return prefs;
}

/**
 * 把锐化卷积核作为文档级单例注入，播放器重建也不用重新注入。
 */
export function ensureSharpenFilter(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.getElementById(SHARPEN_FILTER_ID)) return true;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('style', SHARPEN_SVG_STYLE);
  svg.setAttribute('aria-hidden', 'true');

  const filter = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'filter'
  );
  filter.setAttribute('id', SHARPEN_FILTER_ID);
  // 默认滤镜区比元素大一圈，改成紧贴画面边界
  filter.setAttribute('x', '0%');
  filter.setAttribute('y', '0%');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  filter.setAttribute('filterUnits', 'objectBoundingBox');
  // 不写 sRGB 的话 Chromium 会先转线性空间，颜色会偏
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const convolve = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'feConvolveMatrix'
  );
  convolve.setAttribute('order', '3');
  convolve.setAttribute('kernelMatrix', SHARPEN_KERNEL);
  convolve.setAttribute('divisor', '1');
  convolve.setAttribute('bias', '0');
  convolve.setAttribute('edgeMode', 'duplicate');

  filter.appendChild(convolve);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return true;
}

export function buildFilterCss(prefs: FilterPrefs): string {
  const parts: string[] = [];
  if (Math.abs(prefs.brightness - 1) > 0.001) {
    parts.push(`brightness(${prefs.brightness.toFixed(2)})`);
  }

  const mode = prefs.mode ?? 'css';
  if (prefs.enhance && mode === 'css' && ensureSharpenFilter()) {
    parts.push(`url(#${SHARPEN_FILTER_ID})`);
  }
  return parts.join(' ');
}

function gpuParams() {
  const tier = effectiveTier(readPerformanceMode(), getDeviceProfile());
  if (tier === 'high') {
    return { sharpen: 0.7, contrast: 1.05, saturation: 1.06 };
  }
  return { sharpen: 0.45, contrast: 1.03, saturation: 1.04 };
}

function writeFilter(video: HTMLVideoElement, prefs: FilterPrefs): void {
  const enhancer = enhancersByVideo.get(video);
  if (enhancer) {
    // GPU 增强激活时 video 会被隐藏，亮度等参数必须在着色器里生效
    video.style.filter = '';
    enhancer.update({
      brightness: prefs.brightness,
      ...gpuParams(),
    });
    return;
  }

  video.style.filter = buildFilterCss(prefs);
}

export function normalizeEnhanceMode(value: unknown): EnhanceMode {
  if (value === true || value === 'true') return 'auto';
  if (value === false || value === 'false' || value == null) return 'off';
  if (
    value === 'auto' ||
    value === 'gpu' ||
    value === 'css' ||
    value === 'off'
  ) {
    return value;
  }
  return 'off';
}

/**
 * auto 的策略：低端设备优先保证不卡（关闭），
 * 其余设备有 WebGL 就走 GPU，没有 WebGL 再退回 CSS 卷积。
 */
export function resolveEnhanceMode(mode: EnhanceMode): EnhanceMode {
  if (mode !== 'auto') return mode;
  const profile = getDeviceProfile();
  if (profile.tier === 'low') return 'off';
  return canUseGpuEnhance() ? 'gpu' : 'css';
}

function destroyEnhancer(video: HTMLVideoElement): void {
  const enhancer = enhancersByVideo.get(video);
  if (!enhancer) return;
  enhancersByVideo.delete(video);
  enhancer.destroy();
}

function enableGpuEnhance(video: HTMLVideoElement): boolean {
  let degradedDuringCreate = false;
  let created = false;

  const enhancer = GpuVideoEnhancer.create(video, {
    onDegrade: () => {
      // 创建阶段同步失败时只打标记，由外层回退到 CSS
      if (!created) {
        degradedDuringCreate = true;
        return;
      }
      // 运行中帧率过低/上下文丢失：热切到 CSS，避免继续拖慢播放
      enhancersByVideo.delete(video);
      const prefs = prefsFor(video);
      prefs.mode = 'css';
      prefs.enhance = true;
      writeFilter(video, prefs);
    },
  });

  created = true;

  if (!enhancer || degradedDuringCreate) {
    enhancer?.destroy();
    return false;
  }

  enhancersByVideo.set(video, enhancer);
  return true;
}

export function getBrightness(video: HTMLVideoElement | undefined): number {
  if (!video) return 1;
  return prefsFor(video).brightness;
}

export function setBrightness(
  video: HTMLVideoElement | undefined,
  value: number
): number {
  if (!video) return value;
  const prefs = prefsFor(video);
  prefs.brightness = value;
  writeFilter(video, prefs);
  return value;
}

export function isEnhanceEnabled(video: HTMLVideoElement | undefined): boolean {
  return video ? prefsFor(video).enhance : false;
}

export function getEnhanceMode(
  video: HTMLVideoElement | undefined
): EnhanceMode {
  return video ? prefsFor(video).mode ?? 'off' : 'off';
}

/** 应用增强模式，返回实际生效的模式（auto 会被解析） */
export function setEnhanceMode(
  video: HTMLVideoElement | undefined,
  mode: EnhanceMode
): EnhanceMode {
  const resolved = resolveEnhanceMode(mode);
  if (!video) return resolved;

  const prefs = prefsFor(video);
  destroyEnhancer(video);

  let applied = resolved;
  if (resolved === 'gpu' && !enableGpuEnhance(video)) {
    applied = 'css';
  }

  prefs.mode = applied;
  prefs.enhance = applied !== 'off';
  writeFilter(video, prefs);
  return applied;
}

/** 兼容旧调用：true 等价于兼容锐化，false 关闭 */
export function setEnhance(
  video: HTMLVideoElement | undefined,
  enabled: boolean
): boolean {
  const applied = setEnhanceMode(video, enabled ? 'css' : 'off');
  return applied !== 'off';
}

/** 播放器销毁时释放 WebGL 资源 */
export function destroyEnhance(video: HTMLVideoElement | undefined): void {
  if (!video) return;
  destroyEnhancer(video);
  prefsByVideo.delete(video);
}

export function readEnhanceMode(): EnhanceMode {
  if (typeof window === 'undefined') return 'auto';
  const raw = localStorage.getItem(ENHANCE_KEY);
  // 首次使用默认自动：高性能设备直接启用 GPU，低端设备自动关闭
  if (raw === null) return 'auto';
  return normalizeEnhanceMode(raw);
}

export function readEnhancePreference(): boolean {
  return readEnhanceMode() !== 'off';
}

export function saveEnhanceMode(mode: EnhanceMode): EnhanceMode {
  const normalized = normalizeEnhanceMode(mode);
  try {
    localStorage.setItem(ENHANCE_KEY, normalized);
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  return normalized;
}

export function saveEnhancePreference(enabled: boolean): void {
  try {
    localStorage.setItem(ENHANCE_KEY, String(enabled));
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
}

export function enhanceModeLabel(mode: EnhanceMode): string {
  if (mode === 'gpu') return 'GPU 锐化';
  if (mode === 'css') return '兼容锐化';
  if (mode === 'auto') return '自动';
  return '关闭';
}
