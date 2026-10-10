/* eslint-disable @typescript-eslint/no-explicit-any */

// video.style.filter 只允许这一个模块写入：亮度手势和画质增强各自赋值会互相覆盖。

export const ENHANCE_KEY = 'player_video_enhance';
export const SHARPEN_FILTER_ID = 'moontv-sharpen';

// 3x3 轻度锐化卷积核，系数和为 1，所以不会整体提亮或压暗
const SHARPEN_KERNEL = '0 -0.2 0 -0.2 1.8 -0.2 0 -0.2 0';
const SHARPEN_SVG_STYLE = 'position:absolute;width:0;height:0;overflow:hidden';

export interface FilterPrefs {
  brightness: number;
  enhance: boolean;
}

const prefsByVideo = new WeakMap<HTMLVideoElement, FilterPrefs>();

function prefsFor(video: HTMLVideoElement): FilterPrefs {
  let prefs = prefsByVideo.get(video);
  if (!prefs) {
    prefs = { brightness: 1, enhance: false };
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
  if (prefs.enhance && ensureSharpenFilter()) {
    parts.push(`url(#${SHARPEN_FILTER_ID})`);
  }
  return parts.join(' ');
}

function writeFilter(video: HTMLVideoElement, prefs: FilterPrefs): void {
  video.style.filter = buildFilterCss(prefs);
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

export function setEnhance(
  video: HTMLVideoElement | undefined,
  enabled: boolean
): boolean {
  if (!video) return enabled;
  const prefs = prefsFor(video);
  prefs.enhance = enabled;
  writeFilter(video, prefs);
  return enabled;
}

export function readEnhancePreference(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(ENHANCE_KEY) === 'true';
}

export function saveEnhancePreference(enabled: boolean): void {
  try {
    localStorage.setItem(ENHANCE_KEY, String(enabled));
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
}
