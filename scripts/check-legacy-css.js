/* eslint-disable @typescript-eslint/no-var-requires, no-console */
'use strict';

/**
 * 老浏览器 CSS 输出的产物校验（不跑 next build，只跑构建里那段 PostCSS）。
 *
 * 用法：node scripts/check-legacy-css.js
 *
 * 为什么还要过一遍 cssnano：Next 生产构建会用 cssnano-simple 压缩 CSS，
 * 它会把短属性合并成 shorthand、把规则按相同声明重新分组。
 * 只校验未压缩产物会漏掉「压缩后又把兜底改回去」这种坑（本项目踩过）。
 */

const postcss = require('postcss');

const tailwind = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const legacyPlugin = require('./postcss-legacy.js');

let cssnano = null;
try {
  // Next 内置的压缩器，优先用它，保证和真实构建一致
  cssnano = require('next/dist/compiled/cssnano-simple');
} catch {
  console.warn('（未找到 next 内置 cssnano，跳过压缩校验）');
}

const FIXTURE = `
<div class="flex gap-2 bg-black/50 bg-black text-white/70 text-white inset-0 aspect-[2/3] backdrop-blur-sm
  border-white/10 border-gray-200 dark:bg-gray-800/80 placeholder-gray-500
  bg-gradient-to-t from-black/80 via-black/20" />
`;

const MODERN_COLOR = /(?:rgb|hsl)a?\(\s*[\d.]+[\s]+[\d.]+[^)]*\/[^)]*\)/g;

async function build({ minify }) {
  const plugins = [
    tailwind({ content: [{ raw: FIXTURE }] }),
    legacyPlugin(),
    autoprefixer(),
  ];
  if (minify) plugins.push(cssnano());
  const result = await postcss(plugins).process('@tailwind utilities;', {
    from: undefined,
  });
  return result.css;
}

/** 把选择器里含 target 的规则声明全部并起来（压缩后同一个类可能被拆成多条规则） */
function declarationsFor(css, selector) {
  const decls = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = rulePattern.exec(css);
  while (match) {
    const selectors = match[1].split(',').map((part) => part.trim());
    if (selectors.includes(selector)) decls.push(match[2]);
    match = rulePattern.exec(css);
  }
  return decls.join(';');
}

/** 去掉空白、把 `.5` 补成 `0.5`，让压缩/未压缩产物能用同一套断言 */
function normalize(text) {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/,(?=\.)/g, ',0');
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    return true;
  }
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function assertAll(css, label) {
  let ok = true;
  console.log(`\n[${label}]`);

  const leftovers = css.match(MODERN_COLOR) || [];
  ok =
    check('没有 rgb/hsl 空格+斜杠语法', leftovers.length === 0, leftovers[0]) &&
    ok;

  const bgBlack50 = normalize(declarationsFor(css, '.bg-black\\/50'));
  ok =
    check(
      '带透明度的颜色是 rgba() 旧语法',
      bgBlack50.includes('rgba(0,0,0,0.5)'),
      bgBlack50.slice(0, 80)
    ) && ok;

  // Tailwind 的「静态色 + 变量透明度」是最容易在压缩后被打回现代语法的一类
  const bgBlack = normalize(declarationsFor(css, '.bg-black'));
  ok =
    check(
      '静态色 + var() 透明度也能降级',
      bgBlack.includes('rgba(0,0,0,var(--tw-bg-opacity'),
      bgBlack.slice(0, 80)
    ) && ok;

  // 压缩后同一个类可能被拆到多条规则里（cssnano 会按相同声明重新分组）
  const insetParts = css.match(/\.inset-0[^{]*\{[^}]*\}/g) || [];
  const insetUnion = normalize(insetParts.join(';'));
  ok =
    check(
      'inset 四向都有兜底',
      ['top:0', 'right:0', 'bottom:0', 'left:0'].every((decl) =>
        insetUnion.includes(decl)
      ),
      insetUnion.slice(0, 140)
    ) && ok;

  ok =
    check(
      'aspect-ratio 有 @supports 兜底',
      /@supports not \(aspect-ratio:\s*1\s*\/\s*1\)/.test(css)
    ) && ok;
  ok =
    check('兜底里 padding-top 比例正确', /padding-top:\s*150%/.test(css)) && ok;
  ok =
    check(
      'backdrop-filter 带 -webkit- 前缀',
      css.includes('-webkit-backdrop-filter')
    ) && ok;
  const fromBlack = normalize(declarationsFor(css, '.from-black\\/80'));
  ok =
    check(
      '渐变色标仍是旧语法',
      fromBlack.includes('--tw-gradient-from:rgba(0,0,0,0.8)'),
      fromBlack.slice(0, 100)
    ) && ok;

  return ok;
}

(async () => {
  console.log('老浏览器 CSS 产物校验');

  const raw = await build({ minify: false });
  let ok = assertAll(raw, '未压缩产物');

  if (cssnano) {
    const minified = await build({ minify: true });
    ok = assertAll(minified, '压缩后产物（真实生产形态）') && ok;
    console.log(
      `\n产物体积：未压缩 ${(raw.length / 1024).toFixed(1)} KB → 压缩 ${(
        minified.length / 1024
      ).toFixed(1)} KB`
    );
  }

  if (!ok) {
    console.error('\n校验失败');
    process.exit(1);
  }
  console.log('\n全部通过');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
