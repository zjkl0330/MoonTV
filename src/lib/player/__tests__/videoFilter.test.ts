import {
  buildFilterCss,
  ENHANCE_KEY,
  ensureSharpenFilter,
  getBrightness,
  readEnhanceMode,
  readEnhancePreference,
  saveEnhancePreference,
  setBrightness,
  setEnhance,
  SHARPEN_FILTER_ID,
} from '../videoFilter';

describe('buildFilterCss：亮度和锐化共用一个 filter', () => {
  it('默认状态不产生任何 filter', () => {
    expect(buildFilterCss({ brightness: 1, enhance: false })).toBe('');
  });

  it('只调亮度时不引用滤镜', () => {
    expect(buildFilterCss({ brightness: 0.6, enhance: false })).toBe(
      'brightness(0.60)'
    );
  });

  it('两者同时开启时按顺序拼接，不会互相覆盖', () => {
    expect(buildFilterCss({ brightness: 1.2, enhance: true })).toBe(
      'brightness(1.20) url(#moontv-sharpen)'
    );
  });
});

describe('ensureSharpenFilter', () => {
  it('只注入一份锐化卷积核，且系数和为 1', () => {
    expect(ensureSharpenFilter()).toBe(true);
    expect(ensureSharpenFilter()).toBe(true);

    expect(document.getElementById(SHARPEN_FILTER_ID)).toBeTruthy();
    const convolve = document.getElementsByTagName('feConvolveMatrix')[0];
    expect(convolve).toBeTruthy();
    expect(document.getElementsByTagName('feConvolveMatrix').length).toBe(1);

    const matrix = (convolve.getAttribute('kernelMatrix') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    expect(matrix).toHaveLength(9);
    expect(matrix.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(convolve.getAttribute('edgeMode')).toBe('duplicate');
  });
});

describe('setBrightness / setEnhance 共享同一份状态', () => {
  const video = document.createElement('video');

  it('先开锐化再调亮度，锐化不会丢', () => {
    setEnhance(video, true);
    setBrightness(video, 0.8);

    expect(getBrightness(video)).toBe(0.8);
    expect(video.getAttribute('style') || '').toContain(
      `url(#${SHARPEN_FILTER_ID})`
    );
    expect(video.getAttribute('style') || '').toContain('brightness(0.80)');
  });

  it('关掉锐化只留亮度', () => {
    setEnhance(video, false);
    expect(video.getAttribute('style') || '').not.toContain('url(#');
    expect(video.getAttribute('style') || '').toContain('brightness(0.80)');
  });

  it('回到 1.0 时把 brightness 从字符串里去掉', () => {
    setBrightness(video, 1);
    expect(video.getAttribute('style') || '').not.toContain('brightness');
  });
});

describe('画质增强的跨会话记忆', () => {
  afterEach(() => localStorage.clear());

  it('默认自动（高性能设备启用 GPU，低端设备关闭）', () => {
    expect(readEnhancePreference()).toBe(true);
    expect(readEnhanceMode()).toBe('auto');
  });

  it('开启后写进 localStorage', () => {
    saveEnhancePreference(true);
    expect(localStorage.getItem(ENHANCE_KEY)).toBe('true');
    expect(readEnhancePreference()).toBe(true);

    saveEnhancePreference(false);
    expect(readEnhancePreference()).toBe(false);
  });
});
