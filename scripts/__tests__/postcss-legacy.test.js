/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';

const postcss = require('postcss');

const plugin = require('../postcss-legacy');

async function run(css, options = {}) {
  const result = await postcss([plugin]).process(css, {
    from: undefined,
    ...options,
  });
  return result.css;
}

describe('convertModernColors', () => {
  const { convertModernColors } = plugin;

  it('空格语法的 rgb 转成逗号语法', () => {
    expect(convertModernColors('rgb(255 255 255)')).toBe('rgb(255, 255, 255)');
  });

  it('带斜杠 alpha 的转成 rgba', () => {
    expect(convertModernColors('rgb(0 0 0 / 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('alpha 是 var() 时保持可变量', () => {
    expect(convertModernColors('rgb(255 255 255 / var(--tw-bg-opacity))')).toBe(
      'rgba(255, 255, 255, var(--tw-bg-opacity))'
    );
  });

  it('百分比 alpha 转成小数', () => {
    expect(convertModernColors('hsl(210 40% 50% / 60%)')).toBe(
      'hsla(210, 40%, 50%, 0.6)'
    );
  });

  it('var() 里的逗号不会被误判成旧语法', () => {
    // Tailwind 的静态色 + 变量透明度就是这种形状，压缩后斜杠两侧还没有空格
    expect(convertModernColors('rgb(0 0 0 / var(--tw-bg-opacity, 1))')).toBe(
      'rgba(0, 0, 0, var(--tw-bg-opacity, 1))'
    );
    expect(convertModernColors('rgb(0 0 0/var(--tw-bg-opacity,1))')).toBe(
      'rgba(0, 0, 0, var(--tw-bg-opacity,1))'
    );
  });

  it('已经是逗号语法的原样返回', () => {
    const legacy = 'rgba(0, 0, 0, 0.8)';
    expect(convertModernColors(legacy)).toBe(legacy);
  });

  it('一个值里多个颜色函数都能处理', () => {
    expect(
      convertModernColors(
        'linear-gradient(to top, rgb(0 0 0 / 0.8), rgb(255 255 255 / 0.2))'
      )
    ).toBe(
      'linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(255, 255, 255, 0.2))'
    );
  });

  it('参数个数不对时不动它', () => {
    const weird = 'rgb(0 0)';
    expect(convertModernColors(weird)).toBe(weird);
  });
});

describe('postcss 插件整体行为', () => {
  it('颜色、inset、aspect-ratio 三件事都做了', async () => {
    const css = await run(`
      .card { background-color: rgb(255 255 255 / 0.5); inset: 0; aspect-ratio: 2 / 3; }
    `);

    expect(css).toContain('rgba(255, 255, 255, 0.5)');
    // inset 展开，原来的 inset 保留给现代浏览器
    expect(css).toContain('top: 0');
    expect(css).toContain('left: 0');
    expect(css).toContain('inset: 0');
    // aspect-ratio 的 @supports 兜底（2:3 → 高是宽的 150%）
    expect(css).toContain('@supports not (aspect-ratio: 1 / 1)');
    expect(css).toContain('padding-top: 150%');
    expect(css).toContain('.card > *');
  });
});

describe('expandFourValues', () => {
  const { expandFourValues } = plugin;

  it('单值四向相同', () => {
    expect(expandFourValues('0')).toEqual({
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
    });
  });

  it('两值按上下/左右', () => {
    expect(expandFourValues('0 auto')).toEqual({
      top: '0',
      right: 'auto',
      bottom: '0',
      left: 'auto',
    });
  });

  it('四值原样对应', () => {
    expect(expandFourValues('1px 2px 3px 4px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '4px',
    });
  });

  it('超过四个值不处理', () => {
    expect(expandFourValues('1px 2px 3px 4px 5px')).toBeNull();
  });
});

describe('parseAspectRatio', () => {
  const { parseAspectRatio } = plugin;

  it('2/3 换算成 150%', () => {
    expect(parseAspectRatio('2 / 3')).toBeCloseTo(150, 5);
  });

  it('16/9 换算成 56.25%', () => {
    expect(parseAspectRatio('16/9')).toBeCloseTo(56.25, 5);
  });

  it('auto 之类的值不处理', () => {
    expect(parseAspectRatio('auto')).toBeNull();
  });
});
