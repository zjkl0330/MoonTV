/* eslint-disable @typescript-eslint/no-explicit-any */

import { buildPlayerSettings } from '../playerSettings';

function createContext() {
  const video = document.createElement('video');
  const artPlayerRef = { current: { video, currentTime: 42 } };
  const resumeTimeRef = { current: null as number | null };

  return {
    artPlayerRef,
    resumeTimeRef,
    overlayMaskRef: { current: null },
    blockAdEnabled: true,
    setBlockAdEnabled: jest.fn(),
    destroyPlayer: jest.fn(),
    reloadPlayer: jest.fn(),
    currentSource: 'ffzy',
    incognito: false,
    toggleIncognito: jest.fn().mockResolvedValue(true),
    autoNextEnabled: true,
    toggleAutoNext: jest.fn().mockReturnValue(false),
    toggleShortcuts: jest.fn(),
    buildSkipSettings: () => [],
    clearSkipConfig: jest.fn(),
  };
}

function findSetting(settings: any[], name: string) {
  return settings.find((item) => item.name === name || item.html === name);
}

describe('buildPlayerSettings', () => {
  beforeAll(() => {
    // jsdom 没有 WebGL，探测会打印 not implemented；直接返回 null 即可
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null as any);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => localStorage.clear());

  it('包含播放器核心设置项', () => {
    const settings = buildPlayerSettings(createContext());
    const names = settings
      .map((item) => item.name || item.html)
      .filter(Boolean);

    expect(names).toEqual(
      expect.arrayContaining([
        '去广告',
        '画面填充',
        '画质增强',
        '清晰度上限',
        '性能模式',
        '悬浮广告打码',
        '打码敏感度',
        '无痕模式',
        '自动连播',
        '快捷键',
      ])
    );
  });

  it('切换去广告会记住进度并销毁播放器', () => {
    const ctx = createContext();
    const settings = buildPlayerSettings(ctx);
    const item = findSetting(settings, '去广告');

    const tooltip = item.onClick();

    expect(ctx.resumeTimeRef.current).toBe(42);
    expect(ctx.destroyPlayer).toHaveBeenCalledTimes(1);
    expect(ctx.setBlockAdEnabled).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('enable_blockad')).toBe('false');
    expect(tooltip).toBe('已关闭');
  });

  it('切换性能模式会重建播放器', () => {
    const ctx = createContext();
    const settings = buildPlayerSettings(ctx);
    const item = findSetting(settings, '性能模式');

    item.onSelect({ name: 'perf-smooth' });

    expect(ctx.reloadPlayer).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('player_performance_mode')).toBe('smooth');
  });

  it('快捷键入口调用页面回调', () => {
    const ctx = createContext();
    const settings = buildPlayerSettings(ctx);
    const item = findSetting(settings, '快捷键');

    item.onClick();

    expect(ctx.toggleShortcuts).toHaveBeenCalledTimes(1);
  });
});
