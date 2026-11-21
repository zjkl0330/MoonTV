/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import type { MutableRefObject } from 'react';

import type { MeasuredSource } from '@/lib/player/sourceScore';
import type { SearchResult } from '@/lib/types';

import EpisodeSelector from '@/components/EpisodeSelector';
import {
  FasterSourceTip,
  LoadingOverlay,
  NextEpisodeCountdown,
  PlaybackFailurePanel,
  ShortcutHelpPanel,
} from '@/components/PlayerOverlays';

export interface PlayerStageProps {
  artRef: MutableRefObject<HTMLDivElement | null>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isVideoLoading: boolean;
  videoLoadingStage: 'initing' | 'sourceChanging';
  fasterSource: MeasuredSource<SearchResult> | null;
  onDismissFasterSource: () => void;
  onSwitchSource: (source: SearchResult) => void;
  playbackFailure: { message: string; triedSourceNames: string[] } | null;
  totalSources: number;
  onRetryPlayback: () => void;
  onOpenSourceSwitcher: () => void;
  nextEpisodeCountdown: { index: number; left: number } | null;
  autoNextSeconds: number;
  onPlayNextEpisode: (index: number) => void;
  onCancelNextEpisode: () => void;
  showShortcuts: boolean;
  onCloseShortcuts: () => void;
  totalEpisodes: number;
  currentEpisodeIndex: number;
  currentSource: string;
  currentId: string;
  searchTitle: string;
  videoTitle: string;
  availableSources: SearchResult[];
  sourceSearchLoading: boolean;
  sourceSearchError: string | null;
  precomputedVideoInfo: Map<
    string,
    { quality: string; loadSpeed: string; pingTime: number }
  >;
  onEpisodeChange: (episodeNumber: number) => void;
  onSourceChange: (source: string, id: string, title: string) => void;
}

/**
 * 播放器舞台：播放器、加载/失败/连播浮层、选集与换源面板。
 */
export default function PlayerStage({
  artRef,
  collapsed,
  onToggleCollapsed,
  isVideoLoading,
  videoLoadingStage,
  fasterSource,
  onDismissFasterSource,
  onSwitchSource,
  playbackFailure,
  totalSources,
  onRetryPlayback,
  onOpenSourceSwitcher,
  nextEpisodeCountdown,
  autoNextSeconds,
  onPlayNextEpisode,
  onCancelNextEpisode,
  showShortcuts,
  onCloseShortcuts,
  totalEpisodes,
  currentEpisodeIndex,
  currentSource,
  currentId,
  searchTitle,
  videoTitle,
  availableSources,
  sourceSearchLoading,
  sourceSearchError,
  precomputedVideoInfo,
  onEpisodeChange,
  onSourceChange,
}: PlayerStageProps) {
  return (
    <div className='space-y-2'>
      <div className='hidden lg:flex justify-end'>
        <button
          onClick={onToggleCollapsed}
          className='group relative flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/80 hover:bg-white dark:bg-gray-800/80 dark:hover:bg-gray-800 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200'
          title={collapsed ? '显示选集面板' : '隐藏选集面板'}
        >
          <svg
            className={`w-3.5 h-3.5 text-gray-500 dark:text-gray-400 transition-transform duration-200 ${
              collapsed ? 'rotate-180' : 'rotate-0'
            }`}
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2'
              d='M9 5l7 7-7 7'
            />
          </svg>
          <span className='text-xs font-medium text-gray-600 dark:text-gray-300'>
            {collapsed ? '显示' : '隐藏'}
          </span>
          <div
            className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full transition-all duration-200 ${
              collapsed ? 'bg-orange-400 animate-pulse' : 'bg-green-400'
            }`}
          ></div>
        </button>
      </div>

      <div
        className={`grid gap-4 lg:h-[500px] xl:h-[650px] 2xl:h-[750px] transition-all duration-300 ease-in-out ${
          collapsed ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-4'
        }`}
      >
        <div
          className={`h-full transition-all duration-300 ease-in-out rounded-xl border border-white/0 dark:border-white/30 ${
            collapsed ? 'col-span-1' : 'md:col-span-3'
          }`}
        >
          <div className='relative w-full h-[300px] lg:h-full'>
            <div
              ref={artRef}
              className='bg-black w-full h-full rounded-xl overflow-hidden shadow-lg'
            ></div>

            {isVideoLoading && !playbackFailure && (
              <LoadingOverlay
                message={
                  videoLoadingStage === 'sourceChanging'
                    ? '🔄 切换播放源...'
                    : '🔄 视频加载中...'
                }
              />
            )}

            {fasterSource && !playbackFailure && (
              <FasterSourceTip
                sourceName={
                  fasterSource.source.source_name || fasterSource.source.source
                }
                quality={fasterSource.testResult.quality}
                loadSpeed={fasterSource.testResult.loadSpeed}
                onSwitch={() => onSwitchSource(fasterSource.source)}
                onDismiss={onDismissFasterSource}
              />
            )}

            {playbackFailure && (
              <PlaybackFailurePanel
                message={playbackFailure.message}
                triedSourceNames={playbackFailure.triedSourceNames}
                totalSources={totalSources}
                onRetry={onRetryPlayback}
                onOpenSourceSwitcher={onOpenSourceSwitcher}
              />
            )}

            {nextEpisodeCountdown && !playbackFailure && (
              <NextEpisodeCountdown
                nextEpisodeNumber={nextEpisodeCountdown.index + 1}
                secondsLeft={nextEpisodeCountdown.left}
                totalSeconds={autoNextSeconds}
                onPlayNow={() => onPlayNextEpisode(nextEpisodeCountdown.index)}
                onCancel={onCancelNextEpisode}
              />
            )}

            {showShortcuts && <ShortcutHelpPanel onClose={onCloseShortcuts} />}
          </div>
        </div>

        <div
          className={`h-[300px] lg:h-full md:overflow-hidden transition-all duration-300 ease-in-out ${
            collapsed
              ? 'md:col-span-1 lg:hidden lg:opacity-0 lg:scale-95'
              : 'md:col-span-1 lg:opacity-100 lg:scale-100'
          }`}
        >
          <EpisodeSelector
            totalEpisodes={totalEpisodes}
            value={currentEpisodeIndex + 1}
            onChange={onEpisodeChange}
            onSourceChange={onSourceChange}
            currentSource={currentSource}
            currentId={currentId}
            videoTitle={searchTitle || videoTitle}
            availableSources={availableSources}
            sourceSearchLoading={sourceSearchLoading}
            sourceSearchError={sourceSearchError}
            precomputedVideoInfo={precomputedVideoInfo}
          />
        </div>
      </div>
    </div>
  );
}
