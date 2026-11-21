/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 设备能力探测与播放降载策略。
 *
 * 目标：同一个页面在老手机/电视盒子上少解码、少缓冲、少跑特效；
 * 在性能足够的设备上保留高清与 GPU 增强。
 * 这里只做纯判断，副作用（写 localStorage、改 hls 实例）放在调用方。
 */

export type DeviceTier = 'low' | 'balanced' | 'high';
export type PerformanceMode = 'auto' | 'smooth' | 'quality';
export type QualityCap = 'auto' | '1080' | '720' | '480';

export interface DeviceSignals {
  cores?: number;
  memoryGB?: number;
  saveData?: boolean;
  webgl?: boolean;
  webgl2?: boolean;
}

export interface DeviceProfile {
  tier: DeviceTier;
  cores: number;
  memoryGB: number;
  saveData: boolean;
  webgl: boolean;
  webgl2: boolean;
  /** 判定依据，用于设置面板 tooltip */
  reasons: string[];
}

export const PERFORMANCE_MODE_KEY = 'player_performance_mode';
export const QUALITY_CAP_KEY = 'player_quality_cap';

const PERFORMANCE_MODES: PerformanceMode[] = ['auto', 'smooth', 'quality'];
const QUALITY_CAPS: QualityCap[] = ['auto', '1080', '720', '480'];

export function normalizePerformanceMode(value: unknown): PerformanceMode {
  return PERFORMANCE_MODES.includes(value as PerformanceMode)
    ? (value as PerformanceMode)
    : 'auto';
}

export function normalizeQualityCap(value: unknown): QualityCap {
  return QUALITY_CAPS.includes(value as QualityCap)
    ? (value as QualityCap)
    : 'auto';
}

export function performanceModeLabel(value: PerformanceMode): string {
  if (value === 'smooth') return '流畅优先';
  if (value === 'quality') return '画质优先';
  return '自动';
}

export function qualityCapLabel(value: QualityCap): string {
  if (value === 'auto') return '不限制';
  return `${value}P 以内`;
}

/**
 * 根据硬件信号判定档位。纯函数，方便单测。
 * 内存/核心数拿不到时按主流设备处理，避免误伤高端机。
 */
export function classifyDevice(signals: DeviceSignals = {}): DeviceProfile {
  const cores = Number.isFinite(signals.cores)
    ? Math.max(1, Number(signals.cores))
    : 8;
  const memoryGB = Number.isFinite(signals.memoryGB)
    ? Math.max(1, Number(signals.memoryGB))
    : 8;
  const saveData = !!signals.saveData;
  const reasons: string[] = [];

  if (saveData) reasons.push('系统省流模式');

  let tier: DeviceTier = 'balanced';
  if (
    saveData ||
    cores <= 4 ||
    memoryGB <= 4 ||
    (cores <= 6 && memoryGB <= 6)
  ) {
    tier = 'low';
  } else if (cores >= 8 && memoryGB >= 8) {
    tier = 'high';
  }

  if (cores <= 4) reasons.push(`CPU ${cores} 核`);
  if (memoryGB <= 4) reasons.push(`内存 ${memoryGB}GB`);
  if (tier === 'high') reasons.push('高性能设备');
  if (tier === 'balanced' && reasons.length === 0) reasons.push('主流设备');

  return {
    tier,
    cores,
    memoryGB,
    saveData,
    webgl: !!signals.webgl,
    webgl2: !!signals.webgl2,
    reasons,
  };
}

function probeWebgl(): { webgl: boolean; webgl2: boolean } {
  if (typeof document === 'undefined') {
    return { webgl: false, webgl2: false };
  }

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    const options: WebGLContextAttributes = {
      failIfMajorPerformanceCaveat: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    };
    const gl2 = canvas.getContext('webgl2', options);
    if (gl2) return { webgl: true, webgl2: true };
    const gl = canvas.getContext('webgl', options);
    return { webgl: !!gl, webgl2: false };
  } catch {
    return { webgl: false, webgl2: false };
  } finally {
    // 探测用的上下文立即释放，避免占用 GPU 资源
    try {
      const gl: any =
        (canvas as HTMLCanvasElement | null)?.getContext('webgl2') ??
        (canvas as HTMLCanvasElement | null)?.getContext('webgl');
      gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    } catch {
      /* 探测失败不影响主流程 */
    }
  }
}

let cachedProfile: DeviceProfile | null = null;

/** 读取当前设备档位；同一会话内只探测一次 WebGL。 */
export function getDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;
  if (typeof window === 'undefined') {
    cachedProfile = classifyDevice({ webgl: false, webgl2: false });
    return cachedProfile;
  }

  const nav = window.navigator as any;
  const connection =
    nav?.connection || nav?.mozConnection || nav?.webkitConnection;
  const gl = probeWebgl();

  cachedProfile = classifyDevice({
    cores: Number(nav?.hardwareConcurrency) || undefined,
    memoryGB: Number(nav?.deviceMemory) || undefined,
    saveData: !!connection?.saveData,
    webgl: gl.webgl,
    webgl2: gl.webgl2,
  });
  return cachedProfile;
}

/** 设置面板选择性能模式后，实际生效的档位 */
export function effectiveTier(
  mode: PerformanceMode,
  profile: DeviceProfile = getDeviceProfile()
): DeviceTier {
  if (mode === 'smooth') return 'low';
  if (mode === 'quality') return profile.tier === 'low' ? 'balanced' : 'high';
  return profile.tier;
}

export function readPerformanceMode(): PerformanceMode {
  if (typeof window === 'undefined') return 'auto';
  return normalizePerformanceMode(localStorage.getItem(PERFORMANCE_MODE_KEY));
}

export function savePerformanceMode(value: unknown): PerformanceMode {
  const mode = normalizePerformanceMode(value);
  try {
    localStorage.setItem(PERFORMANCE_MODE_KEY, mode);
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  return mode;
}

export function readQualityCap(): QualityCap {
  if (typeof window === 'undefined') return 'auto';
  return normalizeQualityCap(localStorage.getItem(QUALITY_CAP_KEY));
}

export function saveQualityCap(value: unknown): QualityCap {
  const cap = normalizeQualityCap(value);
  try {
    localStorage.setItem(QUALITY_CAP_KEY, cap);
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  return cap;
}

/** 低端设备默认压在 720P 以内，减少解码与带宽压力 */
export function defaultQualityCap(profile: DeviceProfile): QualityCap {
  if (profile.tier === 'low') {
    if (profile.cores <= 2 || profile.memoryGB <= 2) return '480';
    return '720';
  }
  return 'auto';
}

/** 读取用户设置，没设置过则用设备默认值 */
export function resolveQualityCap(profile: DeviceProfile): QualityCap {
  if (typeof window === 'undefined') return defaultQualityCap(profile);
  const saved = localStorage.getItem(QUALITY_CAP_KEY);
  return saved === null
    ? defaultQualityCap(profile)
    : normalizeQualityCap(saved);
}

export interface HlsTuning {
  enableWorker: boolean;
  lowLatencyMode: boolean;
  capLevelToPlayerSize: boolean;
  testBandwidth: boolean;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  maxBufferSize: number;
  startFragPrefetch: boolean;
  abrEwmaDefaultEstimate: number;
  manifestLoadingMaxRetry: number;
  levelLoadingMaxRetry: number;
  fragLoadingMaxRetry: number;
}

/**
 * 按档位生成 hls.js 的缓冲/ABR 参数。
 * VOD 场景统一关掉 lowLatencyMode，LL-HLS 的额外开销对点播没有收益。
 */
export function buildHlsTuning(
  tier: DeviceTier,
  enableWorker: boolean
): HlsTuning {
  const low = tier === 'low';
  const high = tier === 'high';

  return {
    enableWorker,
    lowLatencyMode: false,
    // 解码尺寸跟随播放器实际大小，电视盒子/手机上能明显少解码
    capLevelToPlayerSize: !high,
    testBandwidth: high,
    maxBufferLength: low ? 16 : high ? 30 : 24,
    maxMaxBufferLength: low ? 30 : high ? 60 : 40,
    backBufferLength: low ? 10 : high ? 30 : 20,
    maxBufferSize: low
      ? 30 * 1000 * 1000
      : high
      ? 80 * 1000 * 1000
      : 60 * 1000 * 1000,
    startFragPrefetch: !low,
    abrEwmaDefaultEstimate: low ? 500_000 : high ? 1_500_000 : 1_000_000,
    manifestLoadingMaxRetry: low ? 2 : 4,
    levelLoadingMaxRetry: low ? 2 : 4,
    fragLoadingMaxRetry: low ? 3 : 6,
  };
}

/**
 * 计算 hls.js 的 autoLevelCapping。
 * 返回 -1 表示不限制；没有满足上限的档位时退到最低档，避免继续拉高分辨率。
 */
export function resolveAutoLevelCapping(
  levels: Array<{ height?: number }>,
  cap: QualityCap
): number {
  if (cap === 'auto') return -1;
  const limit = Number(cap);
  if (!Number.isFinite(limit) || levels.length === 0) return -1;

  let best = -1;
  let bestHeight = -1;
  let lowest = 0;
  let lowestHeight = Number.POSITIVE_INFINITY;

  levels.forEach((level, index) => {
    const height = Number(level?.height) || 0;
    if (height <= 0) return;
    if (height < lowestHeight) {
      lowestHeight = height;
      lowest = index;
    }
    if (height <= limit && height > bestHeight) {
      bestHeight = height;
      best = index;
    }
  });

  return best >= 0 ? best : lowest;
}

/**
 * 把清晰度上限落到 hls 实例上。手动选清晰度时仍可高于上限，
 * 这里只限制“自动”模式的最高档。
 */
export function applyQualityCap(hls: any, cap: QualityCap): number {
  if (!hls || !Array.isArray(hls.levels)) return -1;
  const capping = resolveAutoLevelCapping(hls.levels, cap);
  try {
    hls.autoLevelCapping = capping;
  } catch {
    /* 实例尚未就绪时忽略 */
  }
  return capping;
}
