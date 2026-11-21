/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MutableRefObject } from 'react';

import { AD_FILTER_SETTING_NAME, adFilterTooltip } from './artPlayerOptions';
import {
  applyQualityCap,
  getDeviceProfile,
  performanceModeLabel,
  qualityCapLabel,
  readPerformanceMode,
  resolveQualityCap,
  savePerformanceMode,
  saveQualityCap,
} from './deviceProfile';
import {
  type OverlayAdMasker,
  maskSensitivityLabel,
  OVERLAY_MASK_SETTING_NAME,
  overlayMaskTooltip,
  readMaskSensitivity,
  readOverlayMaskMode,
  saveManualMasks,
  saveMaskSensitivity,
  saveOverlayMaskMode,
} from './overlayAdMask';
import {
  applyObjectFit,
  OBJECT_FIT_OPTIONS,
  objectFitLabel,
  readObjectFit,
  saveObjectFit,
} from './playerViewPrefs';
import { buildSubtitleSettings } from './subtitleLoader';
import {
  enhanceModeLabel,
  normalizeEnhanceMode,
  readEnhanceMode,
  resolveEnhanceMode,
  saveEnhanceMode,
  setEnhanceMode,
} from './videoFilter';

export interface PlayerSettingsContext {
  artPlayerRef: MutableRefObject<any>;
  resumeTimeRef: MutableRefObject<number | null>;
  overlayMaskRef: MutableRefObject<OverlayAdMasker | null>;
  blockAdEnabled: boolean;
  setBlockAdEnabled: (value: boolean) => void;
  destroyPlayer: () => void;
  /** 记住进度、销毁并重建播放器，用于性能模式切换 */
  reloadPlayer: () => void;
  currentSource: string;
  incognito: boolean;
  toggleIncognito: () => Promise<boolean>;
  autoNextEnabled: boolean;
  toggleAutoNext: () => boolean;
  toggleShortcuts: () => void;
  buildSkipSettings: () => any[];
  clearSkipConfig: () => void;
}

function deviceTierLabel(): string {
  const tier = getDeviceProfile().tier;
  if (tier === 'low') return '低端设备';
  if (tier === 'high') return '高性能';
  return '主流';
}

/**
 * 组装 Artplayer 设置面板。
 * 播放页只负责状态与回调，这里集中处理各能力条的展示与持久化。
 */
export function buildPlayerSettings(ctx: PlayerSettingsContext): any[] {
  const {
    artPlayerRef,
    resumeTimeRef,
    overlayMaskRef,
    blockAdEnabled,
    setBlockAdEnabled,
    destroyPlayer,
    reloadPlayer,
    currentSource,
    incognito,
    toggleIncognito,
    autoNextEnabled,
    toggleAutoNext,
    toggleShortcuts,
    buildSkipSettings,
    clearSkipConfig,
  } = ctx;

  return [
    {
      name: AD_FILTER_SETTING_NAME,
      html: '去广告',
      icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
      tooltip: adFilterTooltip(blockAdEnabled),
      onClick() {
        const newVal = !blockAdEnabled;
        try {
          localStorage.setItem('enable_blockad', String(newVal));
          if (artPlayerRef.current) {
            resumeTimeRef.current = artPlayerRef.current.currentTime;
            destroyPlayer();
          }
          setBlockAdEnabled(newVal);
        } catch (_) {
          // ignore
        }
        return adFilterTooltip(newVal);
      },
    },
    {
      name: '画面填充',
      html: '画面填充',
      tooltip: objectFitLabel(readObjectFit()),
      selector: OBJECT_FIT_OPTIONS.map((option) => ({
        name: option.value,
        html: option.label,
        active: option.value === readObjectFit(),
      })),
      onSelect(item: any) {
        const mode = applyObjectFit(artPlayerRef.current?.video, item?.name);
        saveObjectFit(mode);
        return objectFitLabel(mode);
      },
    },
    {
      name: '画质增强',
      html: '画质增强',
      tooltip: (() => {
        const applied = resolveEnhanceMode(readEnhanceMode());
        if (applied === 'off') return '已关闭';
        return `${enhanceModeLabel(applied)} · 已开启`;
      })(),
      selector: [
        {
          name: 'enhance-off',
          html: '关闭',
          active: readEnhanceMode() === 'off',
        },
        {
          name: 'enhance-auto',
          html: '自动（GPU 优先）',
          active: readEnhanceMode() === 'auto',
        },
        {
          name: 'enhance-gpu',
          html: 'GPU 锐化',
          active: readEnhanceMode() === 'gpu',
        },
        {
          name: 'enhance-css',
          html: '兼容锐化',
          active: readEnhanceMode() === 'css',
        },
      ],
      onSelect(item: any) {
        const mode = saveEnhanceMode(
          normalizeEnhanceMode(String(item?.name || '').replace('enhance-', ''))
        );
        const applied = setEnhanceMode(artPlayerRef.current?.video, mode);
        return applied === 'off'
          ? '已关闭'
          : `${enhanceModeLabel(applied)} · 已开启`;
      },
    },
    {
      name: '清晰度上限',
      html: '清晰度上限',
      tooltip: qualityCapLabel(resolveQualityCap(getDeviceProfile())),
      selector: (['auto', '1080', '720', '480'] as const).map((cap) => ({
        name: `cap-${cap}`,
        html: qualityCapLabel(cap),
        active: cap === resolveQualityCap(getDeviceProfile()),
      })),
      onSelect(item: any) {
        const cap = saveQualityCap(
          String(item?.name || '').replace('cap-', '')
        );
        applyQualityCap(artPlayerRef.current?.video?.hls, cap);
        return qualityCapLabel(cap);
      },
    },
    {
      name: '性能模式',
      html: '性能模式',
      tooltip: `${performanceModeLabel(
        readPerformanceMode()
      )} · ${deviceTierLabel()}`,
      selector: (['auto', 'smooth', 'quality'] as const).map((mode) => ({
        name: `perf-${mode}`,
        html: performanceModeLabel(mode),
        active: mode === readPerformanceMode(),
      })),
      onSelect(item: any) {
        const mode = savePerformanceMode(
          String(item?.name || '').replace('perf-', '')
        );
        // 缓冲/ABR 参数在创建 hls 时读取，改完需要重建播放器
        reloadPlayer();
        return performanceModeLabel(mode);
      },
    },
    {
      name: OVERLAY_MASK_SETTING_NAME,
      html: OVERLAY_MASK_SETTING_NAME,
      tooltip: overlayMaskTooltip(
        readOverlayMaskMode(),
        overlayMaskRef.current?.getStats()
      ),
      selector: [
        {
          name: 'mask-off',
          html: '关闭',
          active: readOverlayMaskMode() === 'off',
        },
        {
          name: 'mask-smart',
          html: '智能打码',
          active: readOverlayMaskMode() === 'smart',
        },
        {
          name: 'mask-manual',
          html: '仅手动框选',
          active: readOverlayMaskMode() === 'manual',
        },
      ],
      onSelect(item: any) {
        const mode = saveOverlayMaskMode(
          String(item?.name || '').replace('mask-', '')
        );
        overlayMaskRef.current?.refresh();
        return overlayMaskTooltip(mode, overlayMaskRef.current?.getStats());
      },
    },
    {
      name: '打码敏感度',
      html: '打码敏感度',
      tooltip: maskSensitivityLabel(readMaskSensitivity()),
      selector: (['low', 'medium', 'high'] as const).map((level) => ({
        name: `sensitivity-${level}`,
        html: maskSensitivityLabel(level),
        active: level === readMaskSensitivity(),
      })),
      onSelect(item: any) {
        const level = saveMaskSensitivity(
          String(item?.name || '').replace('sensitivity-', '')
        );
        overlayMaskRef.current?.refresh();
        return maskSensitivityLabel(level);
      },
    },
    {
      html: '框选广告区域',
      tooltip: '拖动鼠标框选',
      onClick() {
        const started = overlayMaskRef.current?.startPicking();
        return started ? '拖动框选，右键退出' : '打码层未就绪';
      },
    },
    {
      html: '清除打码区域',
      tooltip: '移除手动框选',
      onClick() {
        saveManualMasks(currentSource || 'global', []);
        overlayMaskRef.current?.refresh();
        return '已清除';
      },
    },
    {
      name: '无痕模式',
      html: '无痕模式',
      tooltip: incognito ? '已开启' : '已关闭',
      onClick() {
        const newVal = !incognito;
        void toggleIncognito();
        return newVal ? '已开启' : '已关闭';
      },
    },
    ...buildSkipSettings(),
    ...buildSubtitleSettings(() => artPlayerRef.current),
    {
      html: '自动连播',
      tooltip: autoNextEnabled ? '已开启' : '已关闭',
      onClick() {
        return toggleAutoNext() ? '已开启' : '已关闭';
      },
    },
    {
      html: '快捷键',
      tooltip: '查看',
      onClick() {
        toggleShortcuts();
        return '';
      },
    },
    {
      html: '删除跳过配置',
      onClick() {
        clearSkipConfig();
        return '';
      },
    },
  ];
}
