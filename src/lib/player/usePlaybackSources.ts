/* eslint-disable @typescript-eslint/no-explicit-any, no-console, react-hooks/exhaustive-deps */

'use client';

import type { MutableRefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import {
  deletePlayRecord,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  saveSkipConfig,
} from '@/lib/db.client';
import { SearchResult } from '@/lib/types';

import {
  findFasterSource,
  MeasuredSource,
  orderSourcesByRank,
  pickFallbackSource,
  probeSources,
  rankMeasuredSources,
  sourceKey,
  VideoTestResult,
} from './sourceScore';
import type { SkipConfig } from './useSkipIntro';

// 播放失败时最多自动切换几个源，超过后显示失败面板
const MAX_AUTO_SWITCH_SOURCES = 3;
// 起播后在后台测速的并发数，太多会抢当前播放的带宽
const BACKGROUND_PROBE_CONCURRENCY = 2;

export interface UsePlaybackSourcesOptions {
  searchParams: { get: (key: string) => string | null };
  artPlayerRef: MutableRefObject<any>;
  destroyPlayerRef: MutableRefObject<() => void>;
  skipConfigRef: MutableRefObject<SkipConfig>;
  /** 换源前清掉自动连播倒计时 */
  clearNextEpisodeCountdown: () => void;
}

/**
 * 播放源管理：初始详情加载、候选源搜索、后台测速、自动换源与失败兜底。
 * 播放页只保留 UI 与选集/收藏等交互。
 */
export function usePlaybackSources({
  searchParams,
  artPlayerRef,
  destroyPlayerRef,
  skipConfigRef,
  clearNextEpisodeCountdown,
}: UsePlaybackSourcesOptions) {
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('🔍 正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');
  const [needPrefer, setNeedPrefer] = useState(
    searchParams.get('prefer') === 'true'
  );
  const needPreferRef = useRef(needPrefer);
  useEffect(() => {
    needPreferRef.current = needPrefer;
  }, [needPrefer]);

  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);
  // 异步回调里要用最新的候选源，不能依赖闭包
  const candidatesRef = useRef<SearchResult[]>([]);

  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  const [optimizationEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('enableOptimization');
      if (saved !== null) {
        try {
          return JSON.parse(saved);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  });

  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  const [fasterSource, setFasterSource] =
    useState<MeasuredSource<SearchResult> | null>(null);
  const [playbackFailure, setPlaybackFailure] = useState<{
    message: string;
    triedSourceNames: string[];
  } | null>(null);
  const triedSourcesRef = useRef<Set<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const playRecordReadyRef = useRef<Promise<void>>(Promise.resolve());

  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging'
  >('initing');

  const resumeTimeRef = useRef<number | null>(null);

  /** 更新候选源列表，始终保留正在播放的那个 */
  const applyCandidates = (list: SearchResult[]) => {
    const playing = detailRef.current;
    const merged =
      playing && !list.some((item) => sourceKey(item) === sourceKey(playing))
        ? [playing, ...list]
        : list;
    candidatesRef.current = merged;
    setAvailableSources(merged);
  };

  /** 单独补一个候选源（按 source+id 精确取详情时用） */
  const addCandidate = (detailData: SearchResult) => {
    if (
      candidatesRef.current.some(
        (item) => sourceKey(item) === sourceKey(detailData)
      )
    ) {
      return;
    }
    candidatesRef.current = [detailData, ...candidatesRef.current];
    setAvailableSources(candidatesRef.current);
  };

  /**
   * 起播前等播放记录读完：进度恢复发生在 video:canplay，
   * 记录读晚了就来不及跳转。给一个上限，慢存储不能拖住首帧。
   */
  const waitPlayRecord = async () => {
    await Promise.race([
      playRecordReadyRef.current,
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
  };

  /** 切换到指定播放源，尽量沿用当前集数与进度 */
  const switchToSource = async (
    newDetail: SearchResult,
    fallbackTitle = ''
  ) => {
    const prevSource = currentSourceRef.current;
    const prevId = currentIdRef.current;
    const prevIndex = currentEpisodeIndexRef.current;

    setVideoLoadingStage('sourceChanging');
    setIsVideoLoading(true);
    setFasterSource(null);
    setPlaybackFailure(null);
    clearNextEpisodeCountdown();

    const currentPlayTime = artPlayerRef.current?.currentTime || 0;
    const targetIndex =
      newDetail.episodes && prevIndex < newDetail.episodes.length
        ? prevIndex
        : 0;

    // 只有仍播同一集时才恢复原进度，否则交给播放记录
    if (targetIndex !== prevIndex) {
      resumeTimeRef.current = 0;
    } else if (
      (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
      currentPlayTime > 1
    ) {
      resumeTimeRef.current = currentPlayTime;
    }

    if (prevSource && prevId) {
      try {
        await deletePlayRecord(prevSource, prevId);
      } catch (err) {
        console.error('清除播放记录失败:', err);
      }

      try {
        await deleteSkipConfig(prevSource, prevId);
        await saveSkipConfig(
          newDetail.source,
          newDetail.id,
          skipConfigRef.current
        );
      } catch (err) {
        console.error('迁移跳过片头片尾配置失败:', err);
      }
    }

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('source', newDetail.source);
    newUrl.searchParams.set('id', newDetail.id);
    newUrl.searchParams.set('year', newDetail.year);
    window.history.replaceState({}, '', newUrl.toString());

    setVideoTitle(newDetail.title || fallbackTitle || videoTitleRef.current);
    setVideoYear(newDetail.year);
    setVideoCover(newDetail.poster);
    setCurrentSource(newDetail.source);
    setCurrentId(newDetail.id);
    setDetail(newDetail);
    setCurrentEpisodeIndex(targetIndex);
  };

  /**
   * 后台测速：先让当前源播起来，测完再决定静默切换还是提示用户。
   * playingKey 为起播时选中源的标识。
   */
  const runBackgroundSpeedTest = async (
    candidates: SearchResult[],
    playingKey: string
  ) => {
    if (!optimizationEnabled || candidates.length < 2) return;

    const infoMap = new Map<string, VideoTestResult>();
    const measured: Array<{
      source: SearchResult;
      testResult: VideoTestResult;
    }> = [];

    await probeSources(
      candidates,
      (source) => source.episodes,
      (source, testResult) => {
        if (!testResult) return;
        infoMap.set(sourceKey(source), testResult);
        measured.push({ source, testResult });
        setPrecomputedVideoInfo(new Map(infoMap));
      },
      BACKGROUND_PROBE_CONCURRENCY
    );

    if (measured.length === 0) return;

    const ranked = rankMeasuredSources(measured);
    applyCandidates(orderSourcesByRank(candidates, ranked));

    const faster = findFasterSource(ranked, playingKey);
    if (!faster) return;

    // 还没真正播起来就直接换，已经开播则交给用户决定
    if ((artPlayerRef.current?.currentTime || 0) < 1) {
      await switchToSource(faster.source);
    } else {
      setFasterSource(faster);
    }
  };

  /**
   * 播放源断开：自动换到还没试过的源，连续失败到达上限后交给失败面板。
   */
  const handlePlaybackFailure = async (reason: string) => {
    const playing = detailRef.current;
    if (playing) triedSourcesRef.current.add(sourceKey(playing));

    const next =
      triedSourcesRef.current.size > MAX_AUTO_SWITCH_SOURCES
        ? null
        : pickFallbackSource(candidatesRef.current, triedSourcesRef.current);

    if (!next) {
      setIsVideoLoading(false);
      setPlaybackFailure({
        message: reason,
        triedSourceNames: candidatesRef.current
          .filter((item) => triedSourcesRef.current.has(sourceKey(item)))
          .map((item) => item.source_name || item.source),
      });
      return;
    }

    const player = artPlayerRef.current;
    if (player) {
      player.notice.show = `播放失败，正在切换到 ${
        next.source_name || next.source
      }`;
    }
    await switchToSource(next);
  };

  /** 失败面板的“重新载入”：重建播放器并从当前位置重试同一源 */
  const reloadCurrentSource = () => {
    const player = artPlayerRef.current;
    if (player) resumeTimeRef.current = player.currentTime || 0;

    setPlaybackFailure(null);
    setVideoLoadingStage('sourceChanging');
    setIsVideoLoading(true);
    destroyPlayerRef.current();
    setReloadToken((token) => token + 1);
  };

  // 更新视频地址
  const updateVideoUrl = (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= detailData.episodes.length
    ) {
      setVideoUrl('');
      return;
    }
    const newUrl = detailData.episodes[episodeIndex] || '';
    setVideoUrl((prev) => (prev === newUrl ? prev : newUrl));
  };

  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 进入页面时获取源信息：先起播，测速放到后台
  useEffect(() => {
    const fetchSourceDetail = async (
      source: string,
      id: string
    ): Promise<SearchResult[]> => {
      try {
        const detailResponse = await fetch(
          `/api/detail?source=${source}&id=${id}`
        );
        if (!detailResponse.ok) {
          throw new Error('获取视频详情失败');
        }
        const detailData = (await detailResponse.json()) as SearchResult;
        addCandidate(detailData);
        return [detailData];
      } catch (err) {
        console.error('获取视频详情失败:', err);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };

    const fetchSourcesData = async (query: string): Promise<SearchResult[]> => {
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}`
        );
        if (!response.ok) {
          throw new Error('搜索失败');
        }
        const data = await response.json();

        const results = data.results.filter(
          (result: SearchResult) =>
            result.title.replaceAll(' ', '').toLowerCase() ===
              videoTitleRef.current.replaceAll(' ', '').toLowerCase() &&
            (videoYearRef.current
              ? result.year.toLowerCase() === videoYearRef.current.toLowerCase()
              : true) &&
            (searchType
              ? (searchType === 'tv' && result.episodes.length > 1) ||
                (searchType === 'movie' && result.episodes.length === 1)
              : true)
        );
        applyCandidates(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };

    /** 确定起始源并立即交给播放器 */
    const startPlaying = async (detailData: SearchResult) => {
      setNeedPrefer(false);
      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(detailData.title || videoTitleRef.current);
      setVideoCover(detailData.poster);
      setDetail(detailData);
      if (currentEpisodeIndexRef.current >= detailData.episodes.length) {
        setCurrentEpisodeIndex(0);
      }

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      window.history.replaceState({}, '', newUrl.toString());

      // 播放记录要赶在 canplay 之前读到，否则恢复不了进度
      await waitPlayRecord();
      setLoading(false);
    };

    const initAll = async () => {
      if (!currentSource && !currentId && !videoTitle && !searchTitle) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }

      setLoading(true);
      const specified = !!currentSource && !!currentId;

      if (specified && !needPreferRef.current) {
        setLoadingMessage('🎬 正在获取视频详情...');

        const only = await fetchSourceDetail(currentSource, currentId);
        if (only.length === 0) {
          setError('未找到匹配结果');
          setLoading(false);
          return;
        }

        await startPlaying(only[0]);
        await fetchSourcesData(searchTitle || videoTitle);
        void runBackgroundSpeedTest(candidatesRef.current, sourceKey(only[0]));
        return;
      }

      setLoadingMessage('🔍 正在搜索播放源...');

      const results = await fetchSourcesData(searchTitle || videoTitle);
      if (results.length === 0) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      }

      let startSource = results[0];
      if (specified) {
        const matched = results.find(
          (item) => item.source === currentSource && item.id === currentId
        );
        startSource =
          matched ??
          (await fetchSourceDetail(currentSource, currentId))[0] ??
          startSource;
      }

      await startPlaying(startSource);
      void runBackgroundSpeedTest(
        candidatesRef.current,
        sourceKey(startSource)
      );
    };

    initAll();
  }, []);

  // 播放记录处理：仅在初次挂载时检查
  useEffect(() => {
    playRecordReadyRef.current = (async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

        if (record) {
          const targetIndex = record.index - 1;
          const targetTime = record.play_time;

          if (targetIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(targetIndex);
          }

          resumeTimeRef.current = targetTime;
        }
      } catch (err) {
        console.error('读取播放记录失败:', err);
      }
    })();
  }, []);

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    const newDetail = candidatesRef.current.find(
      (item) => item.source === newSource && item.id === newId
    );
    if (!newDetail) {
      setError('未找到匹配结果');
      return;
    }

    await switchToSource(newDetail, newTitle);
  };

  return {
    // 状态
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
    searchType,
    currentEpisodeIndex,
    setCurrentEpisodeIndex,
    videoUrl,
    totalEpisodes: detail?.episodes?.length || 0,
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
    setVideoLoadingStage,
    resumeTimeRef,
    // refs
    currentSourceRef,
    currentIdRef,
    videoTitleRef,
    videoYearRef,
    detailRef,
    currentEpisodeIndexRef,
    candidatesRef,
    // 动作
    switchToSource,
    handlePlaybackFailure,
    reloadCurrentSource,
    handleSourceChange,
  };
}
