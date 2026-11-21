/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { Heart } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import {
  deleteFavorite,
  deletePlayRecord,
  generateStorageKey,
  isFavorited,
  saveFavorite,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { copyText } from '@/lib/legacy/clipboard';
import { describeHlsError } from '@/lib/player/artPlayerOptions';
import { getPlayerOsd } from '@/lib/player/playerOsd';
import { buildPlayerSettings } from '@/lib/player/playerSettings';
import { useArtPlayer } from '@/lib/player/useArtPlayer';
import { useKeyboardShortcuts } from '@/lib/player/useKeyboardShortcuts';
import { usePlaybackSources } from '@/lib/player/usePlaybackSources';
import { usePlayProgress } from '@/lib/player/usePlayProgress';
import {
  type SkipConfig,
  EMPTY_SKIP_CONFIG,
  useSkipIntro,
} from '@/lib/player/useSkipIntro';
import { processImageUrl } from '@/lib/utils';

import PageLayout from '@/components/PageLayout';
import PlayerStage from '@/components/PlayerStage';
import {
  PlayErrorPanel,
  PlayLoadingPanel,
} from '@/components/PlayStatusPanels';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

// 一集播完后自动连播的倒计时秒数
const AUTO_NEXT_SECONDS = 5;

function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });

  const artPlayerRef = useRef<any>(null);
  const artRef = useRef<HTMLDivElement | null>(null);
  // useArtPlayer 的返回值在设置面板回调里要用，先留一个稳定的转发 ref
  const destroyPlayerRef = useRef<() => void>(() => undefined);
  const reloadPlayerRef = useRef<() => void>(() => undefined);
  // 跳过片头片尾配置需要在换源逻辑里迁移，放到两个 hook 之外共享
  const skipConfigRef = useRef<SkipConfig>(EMPTY_SKIP_CONFIG);

  // 自动连播：播完一集后倒计时切下一集
  const [autoNextEnabled, setAutoNextEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('enable_auto_next');
    return saved === null ? true : saved === 'true';
  });
  const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState<{
    index: number;
    left: number;
  } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // 无痕模式：本页不写播放记录
  const [incognito, setIncognito] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('enable_incognito') === 'true';
  });
  const incognitoRef = useRef(incognito);
  useEffect(() => {
    incognitoRef.current = incognito;
  }, [incognito]);

  // 折叠状态（仅在 lg 及以上屏幕有效）
  const [isEpisodeSelectorCollapsed, setIsEpisodeSelectorCollapsed] =
    useState(false);

  // 播放源管理：初始加载、候选源、后台测速、自动换源
  const {
    loading,
    loadingMessage,
    error,
    setError,
    detail,
    videoTitle,
    videoYear,
    videoCover,
    currentSource,
    currentId,
    searchTitle,
    currentEpisodeIndex,
    setCurrentEpisodeIndex,
    videoUrl,
    totalEpisodes,
    availableSources,
    sourceSearchLoading,
    sourceSearchError,
    precomputedVideoInfo,
    fasterSource,
    setFasterSource,
    playbackFailure,
    setPlaybackFailure,
    reloadToken,
    setReloadToken,
    isVideoLoading,
    setIsVideoLoading,
    videoLoadingStage,
    resumeTimeRef,
    currentSourceRef,
    currentIdRef,
    videoTitleRef,
    detailRef,
    currentEpisodeIndexRef,
    switchToSource,
    handlePlaybackFailure,
    reloadCurrentSource,
    handleSourceChange,
  } = usePlaybackSources({
    searchParams,
    artPlayerRef,
    destroyPlayerRef,
    skipConfigRef,
    clearNextEpisodeCountdown: () => setNextEpisodeCountdown(null),
  });

  // 跳过片头片尾：配置读写、面板项与自动跳过
  const {
    buildSkipSettings,
    clearSkipConfig,
    onTimeUpdate: applySkipRules,
  } = useSkipIntro({
    sourceRef: currentSourceRef,
    idRef: currentIdRef,
    artPlayerRef,
    configRef: skipConfigRef,
    hasNextEpisode: () => {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      return !!d?.episodes?.length && idx < d.episodes.length - 1;
    },
    playNextEpisode: () => handleNextEpisode(),
  });

  // 播放进度保存：限频写入与页面隐藏/卸载时补写
  const { saveProgress, saveProgressOnTick } = usePlayProgress({
    artPlayerRef,
    sourceRef: currentSourceRef,
    idRef: currentIdRef,
    titleRef: videoTitleRef,
    detailRef,
    episodeIndexRef: currentEpisodeIndexRef,
    searchTitle,
    isIncognito: () => incognitoRef.current,
  });

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 处理集数切换
  const handleEpisodeChange = (episodeNumber: number) => {
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      setNextEpisodeCountdown(null);
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current) {
        saveProgress();
      }
      setCurrentEpisodeIndex(episodeNumber);
    }
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      if (artPlayerRef.current) {
        saveProgress();
      }
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      if (artPlayerRef.current) {
        saveProgress();
      }
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  /** 开关自动连播，状态写入 localStorage */
  const toggleAutoNext = (): boolean => {
    const newVal = !autoNextEnabled;
    setAutoNextEnabled(newVal);
    if (!newVal) setNextEpisodeCountdown(null);
    try {
      localStorage.setItem('enable_auto_next', String(newVal));
    } catch (_) {
      // ignore
    }
    return newVal;
  };

  /** 开关无痕模式：开启时把这条影片已写入的记录清掉，否则名不副实 */
  const toggleIncognito = async (): Promise<boolean> => {
    const newVal = !incognito;
    setIncognito(newVal);
    try {
      localStorage.setItem('enable_incognito', String(newVal));
    } catch (_) {
      // ignore
    }

    if (newVal && currentSourceRef.current && currentIdRef.current) {
      try {
        await deletePlayRecord(currentSourceRef.current, currentIdRef.current);
      } catch (err) {
        console.error('清除播放记录失败:', err);
      }
    }

    return newVal;
  };

  /** 复制当前播放直链，粘给 PotPlayer / VLC 等外部播放器 */
  const copySourceUrl = async () => {
    const player = artPlayerRef.current;
    const url = videoUrl || player?.url || '';
    if (!url) return;

    let copied = false;
    try {
      // 老浏览器没有 navigator.clipboard，内部会退回 execCommand
      copied = await copyText(url);
    } catch (err) {
      console.warn('剪贴板写入失败:', err);
    }

    getPlayerOsd(player).show(
      copied ? '播放地址已复制' : '复制失败，请手动选取'
    );
  };

  // 倒计时走完就切下一集；期间手动切集或取消会清掉状态
  useEffect(() => {
    if (!nextEpisodeCountdown) return;

    if (nextEpisodeCountdown.left <= 0) {
      handleEpisodeChange(nextEpisodeCountdown.index);
      return;
    }

    const timer = setTimeout(
      () =>
        setNextEpisodeCountdown((prev) =>
          prev ? { ...prev, left: prev.left - 1 } : prev
        ),
      1000
    );
    return () => clearTimeout(timer);
  }, [nextEpisodeCountdown]);

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
  useKeyboardShortcuts({
    artPlayerRef,
    goPreviousEpisode: handlePreviousEpisode,
    goNextEpisode: handleNextEpisode,
    canGoPreviousEpisode: () => currentEpisodeIndexRef.current > 0,
    canGoNextEpisode: () => {
      const d = detailRef.current;
      return (
        !!d?.episodes && currentEpisodeIndexRef.current < d.episodes.length - 1
      );
    },
    toggleShortcutHelp: () => setShowShortcuts((prev) => !prev),
  });

  // ---------------------------------------------------------------------------
  // 播放器生命周期
  // ---------------------------------------------------------------------------
  // 错误页会移除播放器容器，此时同步销毁实例避免残留
  useEffect(() => {
    if (error) {
      destroyPlayer();
    }
  }, [error]);

  // ---------------------------------------------------------------------------
  // 收藏相关
  // ---------------------------------------------------------------------------
  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!currentSource || !currentId) return;
    (async () => {
      try {
        const fav = await isFavorited(currentSource, currentId);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [currentSource, currentId]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!currentSource || !currentId) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(currentSource, currentId);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [currentSource, currentId]);

  // 切换收藏
  const handleToggleFavorite = async () => {
    if (
      !videoTitleRef.current ||
      !detailRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(currentSourceRef.current, currentIdRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(currentSourceRef.current, currentIdRef.current, {
          title: videoTitleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  // 创建并维护 Artplayer 实例
  const { destroyPlayer, overlayMaskRef } = useArtPlayer({
    containerRef: artRef,
    playerRef: artPlayerRef,
    url: videoUrl,
    poster: videoCover,
    title: videoTitle,
    episodeIndex: currentEpisodeIndex,
    loading,
    blockAdEnabled,
    reloadToken,
    detail,
    totalEpisodes,
    adMaskStorageKey: currentSource || 'global',
    resumeTimeRef,
    buildSettings: () =>
      buildPlayerSettings({
        artPlayerRef,
        resumeTimeRef,
        overlayMaskRef,
        blockAdEnabled,
        setBlockAdEnabled,
        destroyPlayer: () => destroyPlayerRef.current(),
        reloadPlayer: () => reloadPlayerRef.current(),
        currentSource,
        incognito,
        toggleIncognito,
        autoNextEnabled,
        toggleAutoNext,
        toggleShortcuts: () => setShowShortcuts((prev) => !prev),
        buildSkipSettings,
        clearSkipConfig,
      }),
    onReady: () => setError(null),
    onSaveProgress: () => saveProgress(),
    onTick: (player: any) => {
      applySkipRules(player, player.currentTime || 0, player.duration || 0);
      saveProgressOnTick();
    },
    onNextEpisode: () => handleNextEpisode(),
    onCopySourceUrl: () => void copySourceUrl(),
    onEnded: () => {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (!d?.episodes || idx >= d.episodes.length - 1) return;
      if (autoNextEnabled) {
        setNextEpisodeCountdown({
          index: idx + 1,
          left: AUTO_NEXT_SECONDS,
        });
      }
    },
    onCanPlay: () => {
      setIsVideoLoading(false);
      setPlaybackFailure(null);
    },
    onInvalidEpisode: (message: string) => setError(message),
    onSourceBroken: (_player: any, data: any) => {
      void handlePlaybackFailure(describeHlsError(data));
    },
  });

  // 设置面板回调晚于 hook 返回执行，这里把稳定的销毁/重建入口接上
  destroyPlayerRef.current = destroyPlayer;
  reloadPlayerRef.current = () => {
    resumeTimeRef.current = artPlayerRef.current?.currentTime || 0;
    destroyPlayer();
    setReloadToken((token) => token + 1);
  };

  if (loading) {
    return <PlayLoadingPanel message={loadingMessage} />;
  }

  if (error) {
    return (
      <PlayErrorPanel
        message={error}
        hasTitle={!!videoTitle}
        onBack={() => {
          if (videoTitle) {
            router.push(`/search?q=${encodeURIComponent(videoTitle)}`);
          } else {
            router.back();
          }
        }}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col gap-3 py-4 px-5 lg:px-[3rem] 2xl:px-20'>
        {/* 第一行：影片标题 */}
        <div className='py-1'>
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='text-gray-500 dark:text-gray-400'>
                {` > 第 ${currentEpisodeIndex + 1} 集`}
              </span>
            )}
          </h1>
        </div>
        {/* 第二行：播放器和选集 */}
        <PlayerStage
          artRef={artRef}
          collapsed={isEpisodeSelectorCollapsed}
          onToggleCollapsed={() =>
            setIsEpisodeSelectorCollapsed((value) => !value)
          }
          isVideoLoading={isVideoLoading}
          videoLoadingStage={videoLoadingStage}
          fasterSource={fasterSource}
          onDismissFasterSource={() => setFasterSource(null)}
          onSwitchSource={(source) => void switchToSource(source)}
          playbackFailure={playbackFailure}
          totalSources={availableSources.length}
          onRetryPlayback={reloadCurrentSource}
          onOpenSourceSwitcher={() => {
            setPlaybackFailure(null);
            setIsEpisodeSelectorCollapsed(false);
          }}
          nextEpisodeCountdown={nextEpisodeCountdown}
          autoNextSeconds={AUTO_NEXT_SECONDS}
          onPlayNextEpisode={handleEpisodeChange}
          onCancelNextEpisode={() => setNextEpisodeCountdown(null)}
          showShortcuts={showShortcuts}
          onCloseShortcuts={() => setShowShortcuts(false)}
          totalEpisodes={totalEpisodes}
          currentEpisodeIndex={currentEpisodeIndex}
          currentSource={currentSource}
          currentId={currentId}
          searchTitle={searchTitle}
          videoTitle={videoTitle}
          availableSources={availableSources}
          sourceSearchLoading={sourceSearchLoading}
          sourceSearchError={sourceSearchError}
          precomputedVideoInfo={precomputedVideoInfo}
          onEpisodeChange={handleEpisodeChange}
          onSourceChange={handleSourceChange}
        />

        {/* 详情展示 */}
        <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
          {/* 文字区 */}
          <div className='md:col-span-3'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite();
                  }}
                  className='ml-3 flex-shrink-0 hover:opacity-80 transition-opacity'
                >
                  <FavoriteIcon filled={favorited} />
                </button>
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-3 text-base mb-4 opacity-80 flex-shrink-0'>
                {detail?.class && (
                  <span className='text-green-600 font-semibold'>
                    {detail.class}
                  </span>
                )}
                {(detail?.year || videoYear) && (
                  <span>{detail?.year || videoYear}</span>
                )}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
                {detail?.type_name && <span>{detail.type_name}</span>}
              </div>
              {/* 剧情简介 */}
              {detail?.desc && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {detail.desc}
                </div>
              )}
            </div>
          </div>

          {/* 封面展示 */}
          <div className='hidden md:block md:col-span-1 md:order-first'>
            <div className='pl-0 py-4 pr-6'>
              <div className='bg-gray-300 dark:bg-gray-700 aspect-[2/3] flex items-center justify-center rounded-xl overflow-hidden'>
                {videoCover ? (
                  <img
                    src={processImageUrl(videoCover)}
                    alt={videoTitle}
                    className='w-full h-full object-cover'
                  />
                ) : (
                  <span className='text-gray-600 dark:text-gray-400'>
                    封面图片
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

// FavoriteIcon 组件
const FavoriteIcon = ({ filled }: { filled: boolean }) => {
  if (filled) {
    return (
      <svg
        className='h-7 w-7'
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444' /* Tailwind red-500 */
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return (
    <Heart className='h-7 w-7 stroke-[1] text-gray-600 dark:text-gray-300' />
  );
};

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
