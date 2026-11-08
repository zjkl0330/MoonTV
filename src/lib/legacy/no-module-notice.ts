/**
 * 给「不支持 ES Module」的浏览器准备的兜底提示脚本。
 *
 * Next.js 14 只产出 module 脚本，没有 nomodule 回退包：
 * IE11、Chrome 49 以下、Safari 10.1 以下的用户会看到纯白页。
 * 这段是 ES5，带 nomodule 属性，现代浏览器会直接跳过它。
 */
export const NO_MODULE_NOTICE = `
(function () {
  var MESSAGE = '当前浏览器版本过低（不支持 ES Module），页面无法加载。请升级到 Chrome 61+ / Safari 10.1+ / Firefox 60+ 后再试。';
  function render() {
    if (document.getElementById('legacy-no-module')) return;
    var box = document.createElement('div');
    box.id = 'legacy-no-module';
    box.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#0b1020;color:#e8ecf5;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;');
    var inner = document.createElement('div');
    inner.setAttribute('style', 'max-width:520px;text-align:center;');
    var title = document.createElement('div');
    title.setAttribute('style', 'font-size:18px;font-weight:600;margin-bottom:12px;');
    title.appendChild(document.createTextNode('浏览器版本过低'));
    var body = document.createElement('div');
    body.setAttribute('style', 'opacity:.85;');
    body.appendChild(document.createTextNode(MESSAGE));
    inner.appendChild(title);
    inner.appendChild(body);
    box.appendChild(inner);
    (document.body || document.documentElement).appendChild(box);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
`.trim();

export default NO_MODULE_NOTICE;
