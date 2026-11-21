/* eslint-disable @typescript-eslint/no-explicit-any, no-console, react-hooks/exhaustive-deps */

import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

import {
  AD_FILTER_SETTING_NAME,
  adFilterTooltip,
  buildArtPlayerOptions,
  ensureVideoSource,
  PLAYBACK_RATES,
} from './artPlayerOptions';
import { effectiveTier, readPerformanceMode } from './deviceProfile';
import { subscribeAdsFiltered } from './m3u8AdFilter';
import {
  type MaskRect,
  type OverlayAdMasker,
  attachOverlayAdMask,
  OVERLAY_MASK_SETTING_NAME,
  overlayMaskTooltip,
  readManualMasks,
  readMaskSensitivity,
  readOverlayMaskMode,
  saveManualMasks,
} from './overlayAdMask';
import { attachMouseGestures } from './playerGestures';
import { keepSettingSubmenuOpen } from './playerSettings';
import { applyObjectFit, readObjectFit } from './playerViewPrefs';
import { bindQualityMenu } from './qualityMenu';
import { attachSubtitleDrop } from './subtitleLoader';
import { destroyEnhance, readEnhanceMode, setEnhanceMode } from './videoFilter';

const VOLUME_KEY = 'player_volume';
const PLAYBACK_RATE_KEY = 'player_playback_rate';

function readPreference(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const saved = parseFloat(localStorage.getItem(key) || '');
  return Number.isFinite(saved) ? saved : fallback;
}

function savePreference(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式下写不进 localStorage，记住也没关系 */
  }
}

interface UseArtPlayerParams {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  playerRef: React.MutableRefObject<any>;
  url: string;
  poster: string;
  title: string;
  episodeIndex: number;
  loading: boolean;
  blockAdEnabled: boolean;
  /** 变化时强制重建播放器，用于播放失败后一键重新载入 */
  reloadToken: number;
  detail: any;
  totalEpisodes: number;
  /** 悬浮广告打码的手动框选按片源隔离 */
  adMaskStorageKey: string;
  /** 每次创建播放器时调用，用于组装设置面板条目 */
  buildSettings: () => any[];
  resumeTimeRef: React.MutableRefObject<number | null>;
  /** 播放就绪，可清除错误态 */
  onReady: () => void;
  /** 播放地址/集数变化时保存上一集进度 */
  onSaveProgress: () => void;
  /** video:timeupdate，用于跳过片头片尾与限频保存进度 */
  onTick: (player: any) => void;
  onNextEpisode: () => void;
  /** 复制当前播放直链，交给外部播放器 */
  onCopySourceUrl: () => void;
  /** 一集播放结束，由调用方决定是否连播 */
  onEnded: () => void;
  /** 可播放后隐藏换源遮罩 */
  onCanPlay: () => void;
  onInvalidEpisode: (message: string) => void;
  /** 播放源断开且无法自愈 */
  /** 播放源断开且无法自愈，data 为 hls.js 的错误信息 */
  onSourceBroken: (player: any, data: any) => void;
}

/**
 * 创建并维护 Artplayer 实例：换源/换集时切换或重建，卸载时销毁。
 *
 * WebKit 内核（Safari）在切换地址时不能正确释放解码器，只能销毁重建；
 * 其余浏览器用 art.switch 原地换源，避免黑屏。
 */
export function useArtPlayer(params: UseArtPlayerParams) {
  const { playerRef } = params;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // 音量与倍速跨会话保留，切集/换源后也沿用
  const lastVolumeRef = useRef<number>(readPreference(VOLUME_KEY, 0.7));
  const lastPlaybackRateRef = useRef<number>(
    readPreference(PLAYBACK_RATE_KEY, 1)
  );

  // 画面层手势、字幕拖拽等额外绑定的解绑函数
  const disposersRef = useRef<Array<() => void>>([]);

  // 当前这一集被剔除的广告，用于回写设置面板
  const adStatsRef = useRef({ segments: 0, seconds: 0 });
  // 悬浮广告打码控制器，供设置面板/失败重载时复用
  const overlayMaskRef = useRef<OverlayAdMasker | null>(null);

  const mountOverlayMask = (player: any) => {
    overlayMaskRef.current?.destroy();

    const storageKey = paramsRef.current.adMaskStorageKey || 'global';
    overlayMaskRef.current = attachOverlayAdMask(player, {
      storageKey,
      getMode: readOverlayMaskMode,
      getSensitivity: readMaskSensitivity,
      getManualRects: () => readManualMasks(storageKey),
      onManualPick: (rect: MaskRect) => {
        saveManualMasks(storageKey, [...readManualMasks(storageKey), rect]);
        overlayMaskRef.current?.refresh();
      },
      onRectsChange: (_rects, stats) => {
        player.setting?.update?.({
          name: OVERLAY_MASK_SETTING_NAME,
          tooltip: overlayMaskTooltip(readOverlayMaskMode(), stats),
        });
      },
      onNotice: (message: string) => {
        if (player?.notice) player.notice.show = message;
      },
    });

    // 初始化时把命中数量同步到设置面板
    const stats = overlayMaskRef.current?.getStats();
    player.setting?.update?.({
      name: OVERLAY_MASK_SETTING_NAME,
      tooltip: overlayMaskTooltip(readOverlayMaskMode(), stats),
    });
  };

  const resetAdStats = () => {
    adStatsRef.current = { segments: 0, seconds: 0 };
    playerRef.current?.setting?.update?.({
      name: AD_FILTER_SETTING_NAME,
      tooltip: adFilterTooltip(paramsRef.current.blockAdEnabled),
    });
  };

  const destroyPlayer = () => {
    disposersRef.current.forEach((dispose) => dispose());
    disposersRef.current = [];

    overlayMaskRef.current?.destroy();
    overlayMaskRef.current = null;

    const player = playerRef.current;
    if (!player) return;

    try {
      destroyEnhance(player.video as HTMLVideoElement);
      if (player.video?.hls) {
        player.video.hls.destroy();
      }
      player.destroy();
    } catch (err) {
      console.error('销毁播放器失败:', err);
    }
    playerRef.current = null;
  };

  useEffect(() => {
    const state = paramsRef.current;

    if (!Hls || !state.url || state.loading || !state.containerRef.current) {
      return;
    }

    if (
      !state.detail ||
      !state.detail.episodes ||
      state.episodeIndex >= state.detail.episodes.length ||
      state.episodeIndex < 0
    ) {
      state.onInvalidEpisode(`选集索引无效，当前共 ${state.totalEpisodes} 集`);
      return;
    }

    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 换集/换源都从当前这一集重新统计广告
    resetAdStats();

    // 非 WebKit 且实例已存在：原地换源
    if (!isWebkit && playerRef.current) {
      playerRef.current.switch = state.url;
      playerRef.current.title = `${state.title} - 第${
        state.episodeIndex + 1
      }集`;
      playerRef.current.poster = state.poster;
      if (playerRef.current.video) {
        ensureVideoSource(
          playerRef.current.video as HTMLVideoElement,
          state.url
        );
      }
      // 换源后手动打码按新片源隔离，需要重新挂载
      mountOverlayMask(playerRef.current);
      return;
    }

    destroyPlayer();

    try {
      Artplayer.PLAYBACK_RATE = PLAYBACK_RATES;
      // 低端设备关掉 RAF 驱动的时间更新，减少主线程唤醒次数
      Artplayer.USE_RAF = effectiveTier(readPerformanceMode()) !== 'low';

      playerRef.current = new Artplayer(
        buildArtPlayerOptions({
          container: state.containerRef.current,
          url: state.url,
          poster: state.poster,
          blockAdEnabled: state.blockAdEnabled,
          volume: lastVolumeRef.current,
          settings: state.buildSettings(),
          onNextEpisode: () => paramsRef.current.onNextEpisode(),
          onCopySourceUrl: () => paramsRef.current.onCopySourceUrl(),
          onHlsUnrecoverable: (data: any) => {
            paramsRef.current.onSourceBroken(playerRef.current, data);
          },
        })
      );

      const player = playerRef.current;
      keepSettingSubmenuOpen(player);
      applyObjectFit(player.video as HTMLVideoElement, readObjectFit());
      setEnhanceMode(player.video as HTMLVideoElement, readEnhanceMode());
      mountOverlayMask(player);
      disposersRef.current = [
        attachMouseGestures(player),
        attachSubtitleDrop(player),
      ];

      player.on('ready', () => {
        paramsRef.current.onReady();
        bindQualityMenu(playerRef.current);
      });

      // 原地换源会重建 hls 实例，元数据到位后再挂清晰度菜单
      player.on('video:loadedmetadata', () =>
        bindQualityMenu(playerRef.current)
      );

      player.on('video:volumechange', () => {
        lastVolumeRef.current = playerRef.current.volume;
        savePreference(VOLUME_KEY, lastVolumeRef.current);
      });
      player.on('video:ratechange', () => {
        lastPlaybackRateRef.current = playerRef.current.playbackRate;
        savePreference(PLAYBACK_RATE_KEY, lastPlaybackRateRef.current);
      });

      // 可播放时再恢复进度，过早 seek 会被重新加载覆盖
      player.on('video:canplay', () => {
        const art = playerRef.current;
        if (!art) return;

        if (state.resumeTimeRef.current && state.resumeTimeRef.current > 0) {
          try {
            const duration = art.duration || 0;
            let target = state.resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            art.currentTime = target;
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        state.resumeTimeRef.current = null;

        setTimeout(() => {
          const current = playerRef.current;
          if (!current) return;

          if (Math.abs(current.volume - lastVolumeRef.current) > 0.01) {
            current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(current.playbackRate - lastPlaybackRateRef.current) > 0.01
          ) {
            current.playbackRate = lastPlaybackRateRef.current;
          }
          current.notice.show = '';
        }, 0);

        paramsRef.current.onCanPlay();
      });

      player.on('video:timeupdate', () => {
        const art = playerRef.current;
        if (!art) return;
        paramsRef.current.onTick(art);
      });

      player.on('error', (err: any) => {
        console.error('播放器错误:', err);
      });

      player.on('video:ended', () => paramsRef.current.onEnded());

      player.on('pause', () => paramsRef.current.onSaveProgress());
    } catch (err) {
      console.error('创建播放器失败:', err);
      paramsRef.current.onInvalidEpisode('播放器初始化失败');
    }
  }, [params.url, params.loading, params.blockAdEnabled, params.reloadToken]);

  // 去广告命中统计来自 hls loader，与播放器实例无关，整个组件订阅一次
  useEffect(() => {
    return subscribeAdsFiltered((event) => {
      const stats = adStatsRef.current;
      // 列表会重复拉取同一个 level，取峰值而不是累加
      stats.segments = Math.max(stats.segments, event.removedSegments);
      stats.seconds = Math.max(stats.seconds, event.removedSeconds);

      playerRef.current?.setting?.update?.({
        name: AD_FILTER_SETTING_NAME,
        tooltip: adFilterTooltip(true, stats),
      });
    });
  }, []);

  // 组件卸载时释放实例；错误页会移除容器，也要同步销毁
  useEffect(() => {
    return () => destroyPlayer();
  }, []);

  return { artPlayerRef: playerRef, destroyPlayer, overlayMaskRef };
}
