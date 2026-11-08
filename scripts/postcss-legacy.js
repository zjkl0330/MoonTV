/* eslint-disable @typescript-eslint/no-var-requires, no-console */
'use strict';

/**
 * 老浏览器 CSS 降级插件。
 *
 * Tailwind 3.4 + autoprefixer 只会按「现代语法」输出，而下面三样东西
 * 在 Chrome 61~87 / Safari 10.1~14 上会被整条丢弃：
 *
 * 1. `rgb(0 0 0 / .5)` 空格+斜杠语法 —— Chrome 65 / Safari 12.1 才有。
 *    这是最致命的：Tailwind 所有带透明度的颜色都用它，老浏览器会变成「无背景色」。
 *    → 转成 `rgba(0, 0, 0, .5)`，alpha 为 var() 时也成立（var() 在旧内核同样可用）。
 * 2. `inset: 0` 简写 —— Chrome 87 / Safari 14.1 才有。
 *    → 展开成 top/right/bottom/left 放在前面，现代浏览器仍走 inset，结果一致。
 * 3. `aspect-ratio` —— Chrome 88 / Safari 15 才有。缺了海报卡片直接塌成 0 高。
 *    → 用 `@supports not (aspect-ratio: 1 / 1)` 包一层 padding-top 经典写法。
 *
 * 刻意没做的：flex `gap` 兜底。要正确模拟需要逐个容器算 margin，收益远小于风险，
 * 老浏览器上的表现只是「间距没了」，不至于破版，见 浏览器兼容性.md。
 */

const postcss = require('postcss');

/** 从 open 位置的 '(' 开始，找到配对的 ')'，支持嵌套 */
function findClosingParen(input, open) {
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 找顶层（不在括号/引号里）的斜杠，返回下标或 -1 */
function findTopLevelSlash(input) {
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '/' && depth === 0) return i;
  }
  return -1;
}

/** 找顶层（不在括号里）的逗号，返回下标或 -1 */
function findTopLevelComma(input) {
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/** 百分比 alpha 转成 0~1 的小数，旧内核只认这个 */
function normalizeAlpha(alpha) {
  const raw = String(alpha).trim();
  if (!raw) return raw;
  if (/^-?[\d.]+%$/.test(raw)) {
    const value = Number(raw.slice(0, -1)) / 100;
    if (!Number.isFinite(value)) return raw;
    return String(Math.min(1, Math.max(0, value)));
  }
  return raw;
}

/**
 * 把单个 `rgb(...)` / `hsl(...)` 的参数改写成旧语法。
 * 返回 null 表示不需要/不能转换（已经是逗号语法、参数个数不对等）。
 */
function convertColorArgs(name, inner) {
  // 顶层已经有逗号 = 旧语法，不用动（注意 var(--x, 1) 里的逗号不算）
  if (findTopLevelComma(inner) !== -1) return null;
  const isHsl = name === 'hsl' || name === 'hsla';

  const slash = findTopLevelSlash(inner);
  const colorPart = slash === -1 ? inner : inner.slice(0, slash);
  const alphaPart = slash === -1 ? '' : normalizeAlpha(inner.slice(slash + 1));

  const tokens = colorPart
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length !== 3) return null;

  if (alphaPart) {
    return `${isHsl ? 'hsla' : 'rgba'}(${tokens.join(', ')}, ${alphaPart})`;
  }
  return `${isHsl ? 'hsl' : 'rgb'}(${tokens.join(', ')})`;
}

/**
 * 遍历一个属性值，把其中所有现代颜色函数改写成旧语法。
 */
function convertModernColors(value) {
  const source = String(value);
  if (source.indexOf('(') === -1) return source;

  const pattern = /\b(rgb|rgba|hsl|hsla)\(/g;
  let output = '';
  let cursor = 0;
  let match = pattern.exec(source);

  while (match) {
    const start = match.index;
    const open = start + match[0].length - 1;
    const close = findClosingParen(source, open);
    if (close === -1) break;

    const inner = source.slice(open + 1, close);
    const converted = convertColorArgs(match[1], inner);

    if (converted === null) {
      output += source.slice(cursor, close + 1);
    } else {
      output += source.slice(cursor, start) + converted;
    }

    cursor = close + 1;
    pattern.lastIndex = close + 1;
    match = pattern.exec(source);
  }

  return output + source.slice(cursor);
}

/** 1~4 个值展开成四向 */
function expandFourValues(value) {
  const parts = String(value).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const [a, b = a, c = a, d = b] = parts;
  return { top: a, right: b, bottom: c, left: d };
}

/** 解析 `2/3` 或 `2 / 3`，返回 width/height 中的 height/width 百分比 */
function parseAspectRatio(value) {
  const matched = /^\s*([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?$/.exec(String(value));
  if (!matched) return null;
  const width = Number(matched[1]);
  const height = matched[2] === undefined ? 1 : Number(matched[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return (height / width) * 100;
}

function selectorsWithSuffix(selector, suffix) {
  return String(selector)
    .split(',')
    .map((part) => `${part.trim()}${suffix}`)
    .join(', ');
}

function legacyColorPlugin() {
  return {
    postcssPlugin: 'postcss-legacy-colors',
    Once(root) {
      root.walkDecls((decl) => {
        if (!decl.value || decl.value.indexOf('(') === -1) return;
        // 变量定义里也可能有颜色（Tailwind 的 --tw-shadow 之类），一并处理
        const next = convertModernColors(decl.value);
        if (next !== decl.value) decl.value = next;
      });
    },
  };
}

function legacyInsetPlugin() {
  return {
    postcssPlugin: 'postcss-legacy-inset',
    Once(root) {
      root.walkDecls('inset', (decl) => {
        const expanded = expandFourValues(decl.value);
        if (!expanded) return;
        Object.keys(expanded).forEach((prop) => {
          decl.cloneBefore({ prop, value: expanded[prop] });
        });
      });
    },
  };
}

function legacyAspectRatioPlugin() {
  return {
    postcssPlugin: 'postcss-legacy-aspect-ratio',
    Once(root) {
      root.walkDecls('aspect-ratio', (decl) => {
        const padding = parseAspectRatio(decl.value);
        if (padding === null) return;

        const rule = decl.parent;
        if (!rule || rule.type !== 'rule' || rule.__legacyAspectDone) return;
        rule.__legacyAspectDone = true;

        const supports = postcss.atRule({
          name: 'supports',
          params: 'not (aspect-ratio: 1 / 1)',
        });

        const base = postcss.rule({ selector: rule.selector });
        base.append({ prop: 'position', value: 'relative' });
        base.append({ prop: 'height', value: 'auto' });

        const spacer = postcss.rule({
          selector: selectorsWithSuffix(rule.selector, '::before'),
        });
        spacer.append({ prop: 'content', value: '""' });
        spacer.append({ prop: 'display', value: 'block' });
        spacer.append({
          prop: 'padding-top',
          value: `${Number(padding.toFixed(4))}%`,
        });

        // 撑高的同时把子元素压成绝对定位，回到 padding-top 撑版式的经典路子
        const children = postcss.rule({
          selector: selectorsWithSuffix(rule.selector, ' > *'),
        });
        children.append({ prop: 'position', value: 'absolute' });
        children.append({ prop: 'top', value: '0' });
        children.append({ prop: 'right', value: '0' });
        children.append({ prop: 'bottom', value: '0' });
        children.append({ prop: 'left', value: '0' });

        supports.append(base);
        supports.append(spacer);
        supports.append(children);
        rule.after(supports);
      });
    },
  };
}

/**
 * 插件入口：一个 plugin 里串三个 visitor，减少 postcss 遍历次数。
 */
function legacyCssPlugin() {
  const color = legacyColorPlugin();
  const inset = legacyInsetPlugin();
  const aspect = legacyAspectRatioPlugin();

  return {
    postcssPlugin: 'postcss-legacy-css',
    Once(root, helpers) {
      color.Once(root, helpers);
      inset.Once(root, helpers);
      aspect.Once(root, helpers);
    },
  };
}

legacyCssPlugin.postcss = true;

module.exports = legacyCssPlugin;
module.exports.convertModernColors = convertModernColors;
module.exports.convertColorArgs = convertColorArgs;
module.exports.expandFourValues = expandFourValues;
module.exports.parseAspectRatio = parseAspectRatio;
