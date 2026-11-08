/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * 构建顺序：Tailwind 生成原子类 → 自身的老浏览器降级 → autoprefixer 补前缀。
 *
 * 注意：Next.js 只接受「插件名字符串」的写法，直接 require() 出来的函数会被拒绝
 * （postcss-shape 报错）。这里用绝对路径当插件名，交给 Next 自己 require.resolve，
 * 既满足它的形状校验，也不用把脚本发布成 npm 包。
 */
const path = require('path');

/** @type {import('postcss-load-config').Config} */
module.exports = {
  plugins: {
    tailwindcss: {},
    [path.resolve(__dirname, 'scripts/postcss-legacy.js')]: {},
    autoprefixer: {},
  },
};
