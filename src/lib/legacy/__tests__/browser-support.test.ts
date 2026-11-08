import {
  type BrowserEnv,
  blockingMissing,
  degradableMissing,
  describeFeatures,
  EMPTY_ENV,
  hlsStrategy,
  parseOlderDeviceHint,
  readBrowserEnv,
  shouldUseHlsWorker,
} from '../browser-support';

const modernEnv: BrowserEnv = {
  modules: true,
  promise: true,
  fetch: true,
  mse: true,
  nativeHls: false,
  intersectionObserver: true,
  resizeObserver: true,
  abortController: true,
  clipboard: true,
  worker: true,
};

describe('browser-support', () => {
  it('现代浏览器不应报缺失', () => {
    expect(blockingMissing(modernEnv)).toEqual([]);
    expect(degradableMissing(modernEnv)).toEqual([]);
  });

  it('缺 MSE 的老 Safari 应走原生 HLS', () => {
    const legacy: BrowserEnv = { ...modernEnv, mse: false, nativeHls: true };
    expect(hlsStrategy(legacy)).toBe('native');
  });

  it('既没 MSE 也没原生 HLS 时判定为不支持', () => {
    const legacy: BrowserEnv = { ...modernEnv, mse: false, nativeHls: false };
    expect(hlsStrategy(legacy)).toBe('unsupported');
    expect(degradableMissing(legacy)).toEqual([]);
  });

  it('缺 fetch/Promise 时算致命缺失', () => {
    const legacy: BrowserEnv = { ...modernEnv, fetch: false, promise: false };
    expect(blockingMissing(legacy)).toEqual(['promise', 'fetch']);
    expect(describeFeatures(blockingMissing(legacy))).toEqual([
      'Promise',
      'fetch',
    ]);
  });

  it('服务端探测返回全 false 的空环境', () => {
    const env = readBrowserEnv();
    // jsdom 里带 window，能读到真实能力；只校验结构完整
    expect(Object.keys(env).sort()).toEqual(Object.keys(EMPTY_ENV).sort());
  });
});

describe('shouldUseHlsWorker', () => {
  it('没有 Worker 直接关掉', () => {
    expect(shouldUseHlsWorker({ worker: false })).toBe(false);
  });

  it('现代设备保持开启', () => {
    expect(
      shouldUseHlsWorker(
        { worker: true },
        { worker: true, chromeMajor: 120, androidMajor: 13 }
      )
    ).toBe(true);
  });

  it('Android 5 及以下关掉 worker', () => {
    expect(
      shouldUseHlsWorker(
        { worker: true },
        { worker: true, chromeMajor: 70, androidMajor: 5 }
      )
    ).toBe(false);
  });

  it('Chrome 53 以下关掉 worker', () => {
    expect(
      shouldUseHlsWorker(
        { worker: true },
        { worker: true, chromeMajor: 49, androidMajor: null }
      )
    ).toBe(false);
  });
});

describe('parseOlderDeviceHint', () => {
  it('解析 Android WebView 的 UA', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 5.1; SM-G900F Build/LMY47X; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/52.0.2743.98 Mobile Safari/537.36';
    expect(parseOlderDeviceHint(ua)).toEqual({
      worker: false,
      chromeMajor: 52,
      androidMajor: 5,
    });
  });

  it('解析 iOS Safari 的 UA（无 Chrome 版本号）', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1';
    expect(parseOlderDeviceHint(ua)).toEqual({
      worker: true,
      chromeMajor: null,
      androidMajor: null,
    });
  });

  it('空 UA 不抛错', () => {
    expect(parseOlderDeviceHint('')).toEqual({
      worker: true,
      chromeMajor: null,
      androidMajor: null,
    });
  });
});
