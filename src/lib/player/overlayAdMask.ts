/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 悬浮广告智能打码。
 *
 * 采集源常在画面角标/底部叠加烧录的广告条，这类内容不在 m3u8 分片里，
 * 去广告 loader 删不掉。这里用「静态区域」启发式检测：
 * - 画面整体在动，但某些网格单元长时间几乎不变，且有明显纹理；
 * - 这些单元聚成的矩形就是可疑的角标/悬浮广告；
 * - 检测结果用 backdrop-filter 模糊 + 压暗遮住，不修改视频本身。
 *
 * 同时保留手动框选，自动检测漏掉时可以直接画框。
 */

import {
  effectiveTier,
  getDeviceProfile,
  readPerformanceMode,
} from './deviceProfile';

export type OverlayMaskMode = 'off' | 'smart' | 'manual';
export type MaskSensitivity = 'low' | 'medium' | 'high';
export type MaskSource = 'smart' | 'manual';

export interface MaskRect {
  /** 相对完整视频帧的归一化坐标，0~1 */
  x: number;
  y: number;
  w: number;
  h: number;
  source?: MaskSource;
}

export interface CellStat {
  /** 平均亮度，0~1 */
  luma: number;
  /** 空间标准差，越大说明纹理/文字越明显 */
  detail: number;
}

export interface GridFrame {
  cols: number;
  rows: number;
  cells: CellStat[];
}

export const OVERLAY_MASK_MODE_KEY = 'player_overlay_mask_mode';
export const OVERLAY_MASK_SENSITIVITY_KEY = 'player_overlay_mask_sensitivity';
export const OVERLAY_MASK_SETTING_NAME = '悬浮广告打码';
const MANUAL_MASK_PREFIX = 'player_overlay_manual_masks:';
const GRID_COLS = 16;
const GRID_ROWS = 9;
const HISTORY_SIZE = 6;
const MAX_MASK_RECTS = 6;

const MODES: OverlayMaskMode[] = ['off', 'smart', 'manual'];
const SENSITIVITIES: MaskSensitivity[] = ['low', 'medium', 'high'];

export function normalizeOverlayMaskMode(value: unknown): OverlayMaskMode {
  return MODES.includes(value as OverlayMaskMode)
    ? (value as OverlayMaskMode)
    : 'off';
}

export function normalizeMaskSensitivity(value: unknown): MaskSensitivity {
  return SENSITIVITIES.includes(value as MaskSensitivity)
    ? (value as MaskSensitivity)
    : 'medium';
}

export function overlayMaskLabel(mode: OverlayMaskMode): string {
  if (mode === 'smart') return '智能打码';
  if (mode === 'manual') return '手动打码';
  return '关闭';
}

export function maskSensitivityLabel(value: MaskSensitivity): string {
  if (value === 'low') return '低（只处理明显广告）';
  if (value === 'high') return '高（更容易误判）';
  return '中';
}

/** 设置面板 tooltip：显示当前模式与命中数量 */
export function overlayMaskTooltip(
  mode: OverlayMaskMode,
  stats?: { smart: number; manual: number }
): string {
  if (mode === 'off') return '已关闭';
  const total = (stats?.smart || 0) + (stats?.manual || 0);
  if (total > 0) {
    return `${overlayMaskLabel(mode)} · 已遮住 ${total} 处`;
  }
  return overlayMaskLabel(mode);
}

export function readOverlayMaskMode(): OverlayMaskMode {
  if (typeof window === 'undefined') return 'off';
  return normalizeOverlayMaskMode(localStorage.getItem(OVERLAY_MASK_MODE_KEY));
}

export function saveOverlayMaskMode(value: unknown): OverlayMaskMode {
  const mode = normalizeOverlayMaskMode(value);
  try {
    localStorage.setItem(OVERLAY_MASK_MODE_KEY, mode);
  } catch {
    /* 隐私模式写不进去 */
  }
  return mode;
}

export function readMaskSensitivity(): MaskSensitivity {
  if (typeof window === 'undefined') return 'medium';
  return normalizeMaskSensitivity(
    localStorage.getItem(OVERLAY_MASK_SENSITIVITY_KEY)
  );
}

export function saveMaskSensitivity(value: unknown): MaskSensitivity {
  const sensitivity = normalizeMaskSensitivity(value);
  try {
    localStorage.setItem(OVERLAY_MASK_SENSITIVITY_KEY, sensitivity);
  } catch {
    /* 隐私模式写不进去 */
  }
  return sensitivity;
}

function manualKey(storageKey: string): string {
  return `${MANUAL_MASK_PREFIX}${storageKey || 'global'}`;
}

export function readManualMasks(storageKey: string): MaskRect[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(manualKey(storageKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return sanitizeRects(parsed);
  } catch {
    return [];
  }
}

export function saveManualMasks(
  storageKey: string,
  rects: MaskRect[]
): MaskRect[] {
  const clean = sanitizeRects(rects).map((rect) => ({
    ...rect,
    source: 'manual' as const,
  }));
  try {
    localStorage.setItem(manualKey(storageKey), JSON.stringify(clean));
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  return clean;
}

function sanitizeRects(value: unknown): MaskRect[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      x: Number(item?.x),
      y: Number(item?.y),
      w: Number(item?.w),
      h: Number(item?.h),
      source:
        item?.source === 'manual' ? ('manual' as const) : ('smart' as const),
    }))
    .filter(
      (rect) =>
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.w) &&
        Number.isFinite(rect.h) &&
        rect.w > 0.005 &&
        rect.h > 0.005
    )
    .map((rect) => ({
      x: clamp01(rect.x),
      y: clamp01(rect.y),
      w: clamp01(rect.w, 0, 1 - clamp01(rect.x)),
      h: clamp01(rect.h, 0, 1 - clamp01(rect.y)),
      source: rect.source,
    }));
}

function clamp01(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function lumaAt(
  data: Uint8ClampedArray | ArrayLike<number>,
  offset: number
): number {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 把一帧降采样图切成 cols × rows，统计每格的平均亮度与空间标准差。
 */
export function analyzeFrame(
  data: Uint8ClampedArray | ArrayLike<number>,
  width: number,
  height: number,
  cols = GRID_COLS,
  rows = GRID_ROWS
): GridFrame {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const cellW = safeWidth / cols;
  const cellH = safeHeight / rows;
  const cells: CellStat[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const startX = Math.floor(col * cellW);
      const endX = Math.max(startX + 1, Math.floor((col + 1) * cellW));
      const startY = Math.floor(row * cellH);
      const endY = Math.max(startY + 1, Math.floor((row + 1) * cellH));

      let sum = 0;
      let sumSq = 0;
      let count = 0;
      // 每格最多采样约 36 个像素，够判断纹理又不拖慢主线程
      const stepX = Math.max(1, Math.floor((endX - startX) / 6));
      const stepY = Math.max(1, Math.floor((endY - startY) / 6));

      for (let y = startY; y < endY; y += stepY) {
        for (let x = startX; x < endX; x += stepX) {
          const offset = (y * safeWidth + x) * 4;
          const luma = lumaAt(data, offset);
          sum += luma;
          sumSq += luma * luma;
          count += 1;
        }
      }

      const mean = count > 0 ? sum / count : 0;
      const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
      cells.push({ luma: mean, detail: Math.sqrt(variance) });
    }
  }

  return { cols, rows, cells };
}

function temporalStats(
  history: GridFrame[],
  index: number
): {
  mean: number;
  std: number;
} {
  let sum = 0;
  for (const frame of history) sum += frame.cells[index]?.luma ?? 0;
  const mean = sum / history.length;

  let variance = 0;
  for (const frame of history) {
    const diff = (frame.cells[index]?.luma ?? 0) - mean;
    variance += diff * diff;
  }
  return { mean, std: Math.sqrt(variance / history.length) };
}

function globalMotion(a: GridFrame, b: GridFrame): number {
  const len = Math.min(a.cells.length, b.cells.length);
  if (len === 0) return 0;
  let sum = 0;
  for (let index = 0; index < len; index++) {
    sum += Math.abs(a.cells[index].luma - b.cells[index].luma);
  }
  return sum / len;
}

interface Thresholds {
  motion: number;
  temporal: number;
  detail: number;
  minArea: number;
}

function thresholdsFor(sensitivity: MaskSensitivity): Thresholds {
  if (sensitivity === 'low') {
    return { motion: 0.035, temporal: 0.012, detail: 0.06, minArea: 0.016 };
  }
  if (sensitivity === 'high') {
    return { motion: 0.015, temporal: 0.026, detail: 0.03, minArea: 0.006 };
  }
  return { motion: 0.024, temporal: 0.018, detail: 0.044, minArea: 0.01 };
}

/** 4 邻接把稳定单元聚成矩形 */
function groupCells(frame: GridFrame, stable: boolean[]): MaskRect[] {
  const { cols, rows } = frame;
  const visited = new Array(stable.length).fill(false);
  const rects: MaskRect[] = [];

  for (let index = 0; index < stable.length; index++) {
    if (!stable[index] || visited[index]) continue;

    const queue = [index];
    visited[index] = true;
    let minCol = cols;
    let maxCol = -1;
    let minRow = rows;
    let maxRow = -1;

    while (queue.length > 0) {
      const current = queue.pop() as number;
      const col = current % cols;
      const row = Math.floor(current / cols);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);

      const neighbors = [
        col > 0 ? current - 1 : -1,
        col < cols - 1 ? current + 1 : -1,
        row > 0 ? current - cols : -1,
        row < rows - 1 ? current + cols : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && stable[next] && !visited[next]) {
          visited[next] = true;
          queue.push(next);
        }
      }
    }

    const w = (maxCol - minCol + 1) / cols;
    const h = (maxRow - minRow + 1) / rows;
    // 横跨大半屏的“静止”更可能是静态背景，而不是悬浮广告
    if (w > 0.8 && h > 0.5) continue;

    rects.push({
      x: minCol / cols,
      y: minRow / rows,
      w,
      h,
      source: 'smart',
    });
  }

  return rects;
}

/**
 * 从连续多帧网格中挑出“画面在动、它却不动”的矩形。
 */
export function detectStaticOverlays(
  history: GridFrame[],
  sensitivity: MaskSensitivity = 'medium'
): MaskRect[] {
  if (history.length < 4) return [];
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  const thresholds = thresholdsFor(sensitivity);

  // 整帧几乎没变化时不做判断，避免把静态背景/黑边当成广告
  if (globalMotion(latest, previous) < thresholds.motion) return [];

  const stable: boolean[] = [];
  latest.cells.forEach((cell, index) => {
    const stats = temporalStats(history, index);
    const hasTexture = cell.detail >= thresholds.detail;
    const notBlackOrWhite = stats.mean > 0.04 && stats.mean < 0.96;
    stable[index] =
      hasTexture && notBlackOrWhite && stats.std <= thresholds.temporal;
  });

  const rects = groupCells(latest, stable).filter((rect) => {
    const area = rect.w * rect.h;
    return area >= thresholds.minArea && area <= 0.18;
  });

  return mergeRects(rects)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_MASK_RECTS);
}

function iou(a: MaskRect, b: MaskRect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

/** 相邻/重叠的框合并，避免打码区域碎成很多小块 */
export function mergeRects(rects: MaskRect[]): MaskRect[] {
  const merged: MaskRect[] = [];
  const pending = rects.map((rect) => ({ ...rect }));

  while (pending.length > 0) {
    let current = pending.shift() as MaskRect;
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < pending.length; index++) {
        if (iou(current, pending[index]) > 0.02) {
          const other = pending.splice(index, 1)[0];
          const left = Math.min(current.x, other.x);
          const top = Math.min(current.y, other.y);
          const right = Math.max(current.x + current.w, other.x + other.w);
          const bottom = Math.max(current.y + current.h, other.y + other.h);
          current = {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
            source: 'smart',
          };
          changed = true;
          break;
        }
      }
    }
    merged.push(current);
  }

  return merged;
}

/**
 * 两次检测之间做迟滞：新框连续出现才接受，旧框连续消失才移除，
 * 避免画面轻微变化时打码框闪烁。
 */
export function reconcileRects(
  current: MaskRect[],
  detected: MaskRect[]
): MaskRect[] {
  const next: MaskRect[] = [];
  const used = new Set<number>();

  current.forEach((rect) => {
    const matchIndex = detected.findIndex(
      (candidate) => iou(rect, candidate) > 0.35
    );
    if (matchIndex >= 0) {
      used.add(matchIndex);
      next.push({ ...detected[matchIndex], source: 'smart' });
    }
  });

  detected.forEach((rect, index) => {
    if (used.has(index)) return;
    const existedBefore = current.some((item) => iou(item, rect) > 0.35);
    if (!existedBefore) next.push({ ...rect, source: 'smart' });
  });

  return next.slice(0, MAX_MASK_RECTS);
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 计算视频帧在播放器盒子里的实际显示区域（object-fit）。
 * 返回相对盒子的像素坐标，用于把归一化打码框映射到屏幕。
 */
export function computeContentRect(
  box: RectLike,
  intrinsicWidth: number,
  intrinsicHeight: number,
  objectFit: string
): RectLike {
  if (
    !intrinsicWidth ||
    !intrinsicHeight ||
    box.width <= 0 ||
    box.height <= 0 ||
    objectFit === 'fill'
  ) {
    return { ...box };
  }

  const fit = objectFit === 'cover' ? 'cover' : 'contain';
  const scale =
    fit === 'cover'
      ? Math.max(box.width / intrinsicWidth, box.height / intrinsicHeight)
      : Math.min(box.width / intrinsicWidth, box.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;

  // contain 时画面比盒子小；cover 时画面溢出盒子，渲染时再按盒子裁剪
  return { left, top, width, height };
}

/**
 * 把归一化的帧坐标映射到播放器盒子坐标，并裁剪到盒子内。
 * cover 模式下超出盒子的部分直接丢弃。
 */
export function mapFrameRectToBox(
  rect: MaskRect,
  box: RectLike,
  intrinsicWidth: number,
  intrinsicHeight: number,
  objectFit: string
): MaskRect | null {
  const content = computeContentRect(
    box,
    intrinsicWidth,
    intrinsicHeight,
    objectFit
  );
  if (content.width <= 0 || content.height <= 0) return null;

  let left = content.left + rect.x * content.width;
  let top = content.top + rect.y * content.height;
  let right = left + rect.w * content.width;
  let bottom = top + rect.h * content.height;

  left = Math.max(left, box.left);
  top = Math.max(top, box.top);
  right = Math.min(right, box.left + box.width);
  bottom = Math.min(bottom, box.top + box.height);

  if (right - left < 1 || bottom - top < 1) return null;

  return {
    x: (left - box.left) / box.width,
    y: (top - box.top) / box.height,
    w: (right - left) / box.width,
    h: (bottom - top) / box.height,
    source: rect.source,
  };
}

export interface OverlayAdMaskerOptions {
  /** 手动框选按片源隔离，例如 'ffzy' */
  storageKey: string;
  getMode: () => OverlayMaskMode;
  getSensitivity: () => MaskSensitivity;
  getManualRects: () => MaskRect[];
  onRectsChange?: (
    rects: MaskRect[],
    stats: { smart: number; manual: number }
  ) => void;
  /** 手动框选完成，调用方负责持久化 */
  onManualPick?: (rect: MaskRect) => void;
  /** 显示操作提示 */
  onNotice?: (message: string) => void;
}

export class OverlayAdMasker {
  private player: any;
  private options: OverlayAdMaskerOptions;
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private layer: HTMLDivElement;
  private sampleCanvas: HTMLCanvasElement;
  private sampleCtx: CanvasRenderingContext2D | null;
  private timer: number | null = null;
  private history: GridFrame[] = [];
  private smartRects: MaskRect[] = [];
  private destroyed = false;
  private picking = false;
  private draft: HTMLDivElement | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private lastRenderAt = 0;
  private lowEnd: boolean;

  constructor(player: any, options: OverlayAdMaskerOptions) {
    this.player = player;
    this.options = options;
    this.root =
      player?.template?.$player ||
      player?.template?.player ||
      player?.template?.$container;
    this.video = player?.video;
    this.lowEnd =
      effectiveTier(readPerformanceMode(), getDeviceProfile()) === 'low';

    this.layer = document.createElement('div');
    this.layer.className = 'moontv-ad-mask-layer';
    this.layer.style.position = 'absolute';
    this.layer.style.inset = '0';
    this.layer.style.overflow = 'hidden';
    this.layer.style.pointerEvents = 'none';
    this.layer.style.zIndex = '2';

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = 96;
    this.sampleCanvas.height = 54;
    this.sampleCtx = this.sampleCanvas.getContext('2d', {
      willReadFrequently: true,
    });

    if (this.root && this.video) {
      // 放在控制条之前，避免打码层盖住底部控件
      const bottom = player?.template?.$bottom;
      if (bottom && bottom.parentElement === this.root) {
        this.root.insertBefore(this.layer, bottom);
      } else {
        this.root.appendChild(this.layer);
      }
      window.addEventListener('resize', this.handleViewportChange);
      document.addEventListener('fullscreenchange', this.handleViewportChange);
      // 低端设备把采样间隔拉长，进一步降低主线程压力
      const interval = this.lowEnd ? 1800 : 1200;
      this.timer = window.setInterval(() => this.tick(), interval);
      this.tick();
    }
  }

  private handleViewportChange = () => {
    this.render();
  };

  private tick(): void {
    if (this.destroyed || this.picking) return;
    const mode = this.options.getMode();
    if (mode !== 'smart') {
      this.smartRects = [];
      this.history = [];
      this.render();
      return;
    }

    if (
      typeof document === 'undefined' ||
      document.hidden ||
      this.video.readyState < 2 ||
      this.video.videoWidth === 0
    ) {
      return;
    }

    const ctx = this.sampleCtx;
    if (!ctx) return;

    try {
      ctx.drawImage(
        this.video,
        0,
        0,
        this.sampleCanvas.width,
        this.sampleCanvas.height
      );
      const image = ctx.getImageData(
        0,
        0,
        this.sampleCanvas.width,
        this.sampleCanvas.height
      );
      const frame = analyzeFrame(
        image.data,
        this.sampleCanvas.width,
        this.sampleCanvas.height
      );

      this.history.push(frame);
      if (this.history.length > HISTORY_SIZE) this.history.shift();

      // 暂停时不更新检测，保留上一轮结果
      if (this.video.paused) {
        this.render();
        return;
      }

      const detected = detectStaticOverlays(
        this.history,
        this.options.getSensitivity()
      );
      this.smartRects = reconcileRects(this.smartRects, detected);
      this.render();
    } catch (err) {
      // 跨域视频会污染 canvas，自动检测只能放弃；手动框选仍然可用
      console.warn('悬浮广告检测不可用:', err);
      this.smartRects = [];
      this.history = [];
    }
  }

  private currentRects(): MaskRect[] {
    const mode = this.options.getMode();
    const manual = this.options.getManualRects();
    if (mode === 'off') return [];
    if (mode === 'manual') {
      return manual.map((rect) => ({ ...rect, source: 'manual' as const }));
    }
    return [
      ...this.smartRects.map((rect) => ({ ...rect, source: 'smart' as const })),
      ...manual.map((rect) => ({ ...rect, source: 'manual' as const })),
    ];
  }

  private render(): void {
    if (this.destroyed || !this.root || !this.video) return;

    const now = Date.now();
    // 采样频率已经很低，这里做一次轻量节流即可
    if (now - this.lastRenderAt < 180) return;
    this.lastRenderAt = now;

    const rects = this.currentRects();
    const rootRect = this.root.getBoundingClientRect();
    const videoRect = this.video.getBoundingClientRect();
    const objectFit = this.video.style.objectFit || 'contain';

    const box: RectLike = {
      left: videoRect.left - rootRect.left,
      top: videoRect.top - rootRect.top,
      width: videoRect.width,
      height: videoRect.height,
    };

    const mapped = rects
      .map((rect) =>
        mapFrameRectToBox(
          rect,
          box,
          this.video.videoWidth,
          this.video.videoHeight,
          objectFit
        )
      )
      .filter((rect): rect is MaskRect => !!rect);

    this.layer.textContent = '';
    mapped.forEach((rect) => {
      const mask = document.createElement('div');
      mask.style.position = 'absolute';
      mask.style.left = `${rect.x * 100}%`;
      mask.style.top = `${rect.y * 100}%`;
      mask.style.width = `${rect.w * 100}%`;
      mask.style.height = `${rect.h * 100}%`;
      mask.style.borderRadius = '4px';
      mask.style.pointerEvents = 'none';
      // 低端设备不做 backdrop-filter，直接压暗，省一次离屏合成
      if (this.lowEnd) {
        mask.style.background = 'rgba(0, 0, 0, 0.82)';
      } else {
        mask.style.background = 'rgba(0, 0, 0, 0.32)';
        mask.style.backdropFilter = 'blur(14px) brightness(0.55)';
        (mask.style as any).webkitBackdropFilter =
          'blur(14px) brightness(0.55)';
      }
      this.layer.appendChild(mask);
    });

    const smart = mapped.filter((rect) => rect.source === 'smart').length;
    const manual = mapped.filter((rect) => rect.source === 'manual').length;
    this.options.onRectsChange?.(mapped, { smart, manual });
  }

  /** 重新读取设置并立即重绘 */
  refresh(): void {
    this.history = [];
    this.lastRenderAt = 0;
    this.tick();
  }

  getStats(): { smart: number; manual: number } {
    return {
      smart: this.smartRects.length,
      manual: this.options.getManualRects().length,
    };
  }

  /** 进入手动框选模式：在画面上拖一个矩形 */
  startPicking(): boolean {
    if (this.destroyed || !this.root) return false;
    this.picking = true;
    this.layer.style.pointerEvents = 'auto';
    this.layer.style.cursor = 'crosshair';
    this.layer.style.touchAction = 'none';
    // 提到控件遮罩之上，保证拖动框选时能收到指针事件
    this.layer.style.zIndex = '5';

    this.layer.addEventListener('pointerdown', this.onPickDown);
    this.layer.addEventListener('pointermove', this.onPickMove);
    this.layer.addEventListener('pointerup', this.onPickUp);
    this.layer.addEventListener('pointercancel', this.onPickCancel);
    this.layer.addEventListener('contextmenu', this.onPickCancel);
    window.addEventListener('keydown', this.onPickKeyDown);

    this.options.onNotice?.('拖动鼠标框选广告区域，右键或 Esc 退出');
    return true;
  }

  private stopPicking(): void {
    if (!this.picking) return;
    this.picking = false;
    this.dragStart = null;
    this.draft?.remove();
    this.draft = null;
    this.layer.style.pointerEvents = 'none';
    this.layer.style.cursor = '';
    this.layer.style.touchAction = '';
    this.layer.style.zIndex = '2';

    this.layer.removeEventListener('pointerdown', this.onPickDown);
    this.layer.removeEventListener('pointermove', this.onPickMove);
    this.layer.removeEventListener('pointerup', this.onPickUp);
    this.layer.removeEventListener('pointercancel', this.onPickCancel);
    this.layer.removeEventListener('contextmenu', this.onPickCancel);
    window.removeEventListener('keydown', this.onPickKeyDown);
  }

  private toFramePoint(event: PointerEvent): { x: number; y: number } | null {
    const rootRect = this.root.getBoundingClientRect();
    const videoRect = this.video.getBoundingClientRect();
    const box: RectLike = {
      left: videoRect.left - rootRect.left,
      top: videoRect.top - rootRect.top,
      width: videoRect.width,
      height: videoRect.height,
    };
    const content = computeContentRect(
      box,
      this.video.videoWidth,
      this.video.videoHeight,
      this.video.style.objectFit || 'contain'
    );
    const x = event.clientX - rootRect.left;
    const y = event.clientY - rootRect.top;
    if (
      x < content.left ||
      x > content.left + content.width ||
      y < content.top ||
      y > content.top + content.height
    ) {
      return null;
    }
    return {
      x: (x - content.left) / content.width,
      y: (y - content.top) / content.height,
    };
  }

  private updateDraft(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) {
    if (!this.draft) {
      this.draft = document.createElement('div');
      this.draft.style.position = 'absolute';
      this.draft.style.border = '2px solid #22c55e';
      this.draft.style.background = 'rgba(34, 197, 94, 0.18)';
      this.draft.style.borderRadius = '4px';
      this.draft.style.pointerEvents = 'none';
      this.layer.appendChild(this.draft);
    }

    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const w = Math.abs(to.x - from.x);
    const h = Math.abs(to.y - from.y);

    // 预览框要按 object-fit 映射到真实显示区域，否则 contain 模式下会偏移
    const rootRect = this.root.getBoundingClientRect();
    const videoRect = this.video.getBoundingClientRect();
    const mapped = mapFrameRectToBox(
      { x, y, w, h },
      {
        left: videoRect.left - rootRect.left,
        top: videoRect.top - rootRect.top,
        width: videoRect.width,
        height: videoRect.height,
      },
      this.video.videoWidth,
      this.video.videoHeight,
      this.video.style.objectFit || 'contain'
    );
    if (!mapped) return;

    this.draft.style.left = `${mapped.x * 100}%`;
    this.draft.style.top = `${mapped.y * 100}%`;
    this.draft.style.width = `${mapped.w * 100}%`;
    this.draft.style.height = `${mapped.h * 100}%`;
  }

  private onPickDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const point = this.toFramePoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    this.layer.setPointerCapture?.(event.pointerId);
    this.dragStart = point;
    this.updateDraft(point, point);
  };

  private onPickMove = (event: PointerEvent) => {
    if (!this.dragStart) return;
    const point = this.toFramePoint(event);
    if (!point) return;
    event.preventDefault();
    this.updateDraft(this.dragStart, point);
  };

  private onPickUp = (event: PointerEvent) => {
    if (!this.dragStart) return;
    const point = this.toFramePoint(event);
    const start = this.dragStart;
    this.stopPicking();
    if (!point) return;

    const x = Math.min(start.x, point.x);
    const y = Math.min(start.y, point.y);
    const w = Math.abs(point.x - start.x);
    const h = Math.abs(point.y - start.y);
    // 小于 1.5% 的拖动多半是误触
    if (w < 0.015 || h < 0.015) {
      this.options.onNotice?.('框选区域太小，已取消');
      return;
    }

    this.options.onManualPick?.({ x, y, w, h, source: 'manual' });
    this.options.onNotice?.('已添加打码区域');
    this.render();
  };

  private onPickCancel = () => {
    this.stopPicking();
    this.options.onNotice?.('已退出框选');
  };

  private onPickKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.onPickCancel();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopPicking();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener('resize', this.handleViewportChange);
    document.removeEventListener('fullscreenchange', this.handleViewportChange);
    this.layer.remove();
    this.smartRects = [];
    this.history = [];
  }
}

export function attachOverlayAdMask(
  player: any,
  options: OverlayAdMaskerOptions
): OverlayAdMasker | null {
  if (
    !player?.video ||
    !(
      player?.template?.$player ||
      player?.template?.player ||
      player?.template?.$container
    )
  ) {
    return null;
  }
  return new OverlayAdMasker(player, options);
}
