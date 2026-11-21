import {
  buildHlsTuning,
  classifyDevice,
  effectiveTier,
  resolveAutoLevelCapping,
  resolveQualityCap,
} from '../deviceProfile';

describe('classifyDevice', () => {
  it('低核心数/低内存判为 low', () => {
    expect(classifyDevice({ cores: 4, memoryGB: 4 }).tier).toBe('low');
    expect(classifyDevice({ cores: 8, memoryGB: 3 }).tier).toBe('low');
  });

  it('系统省流模式直接判为 low', () => {
    expect(
      classifyDevice({ cores: 12, memoryGB: 12, saveData: true }).tier
    ).toBe('low');
  });

  it('高核心数/大内存判为 high', () => {
    expect(classifyDevice({ cores: 8, memoryGB: 8 }).tier).toBe('high');
  });

  it('中间档位判为 balanced', () => {
    expect(classifyDevice({ cores: 6, memoryGB: 8 }).tier).toBe('balanced');
  });
});

describe('effectiveTier', () => {
  const low = classifyDevice({ cores: 4, memoryGB: 4 });
  const high = classifyDevice({ cores: 8, memoryGB: 8 });

  it('流畅优先强制 low，画质优先至少 balanced', () => {
    expect(effectiveTier('smooth', low)).toBe('low');
    expect(effectiveTier('quality', low)).toBe('balanced');
    expect(effectiveTier('quality', high)).toBe('high');
  });

  it('自动跟随设备', () => {
    expect(effectiveTier('auto', low)).toBe('low');
    expect(effectiveTier('auto', high)).toBe('high');
  });
});

describe('buildHlsTuning', () => {
  it('低端设备缓冲更短、默认码率更低', () => {
    const low = buildHlsTuning('low', false);
    const high = buildHlsTuning('high', true);

    expect(low.maxBufferLength).toBeLessThan(high.maxBufferLength);
    expect(low.maxBufferSize).toBeLessThan(high.maxBufferSize);
    expect(low.abrEwmaDefaultEstimate).toBeLessThan(
      high.abrEwmaDefaultEstimate
    );
    expect(low.lowLatencyMode).toBe(false);
    expect(high.enableWorker).toBe(true);
  });
});

describe('resolveAutoLevelCapping', () => {
  const levels = [{ height: 1080 }, { height: 720 }, { height: 480 }];

  it('按上限选择最高可用档位', () => {
    expect(resolveAutoLevelCapping(levels, '720')).toBe(1);
    expect(resolveAutoLevelCapping(levels, '1080')).toBe(0);
  });

  it('auto 不限制', () => {
    expect(resolveAutoLevelCapping(levels, 'auto')).toBe(-1);
  });

  it('没有满足上限的档位时退到最低档', () => {
    expect(resolveAutoLevelCapping([{ height: 1080 }], '480')).toBe(0);
  });
});

describe('resolveQualityCap', () => {
  afterEach(() => localStorage.clear());

  it('低端设备默认压在 720P 以内', () => {
    const low = classifyDevice({ cores: 4, memoryGB: 4 });
    expect(resolveQualityCap(low)).toBe('720');
  });

  it('用户手动设置优先于设备默认值', () => {
    localStorage.setItem('player_quality_cap', '480');
    const high = classifyDevice({ cores: 8, memoryGB: 8 });
    expect(resolveQualityCap(high)).toBe('480');
  });
});
