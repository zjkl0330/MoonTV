/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 老浏览器运行时补丁。
 *
 * 目标是「能加载 ES Module、但 ECMAScript/Web API 落后的浏览器」：
 * Chrome/Edge 61+、Safari 10.1+、iOS 10.3+、Firefox 60+。
 * 比这更老的浏览器（IE11、老 Chrome 49）拿不到 module 脚本，由
 * layout 里的 nomodule 提示兜底，不要指望这里的补丁能救回来。
 *
 * 三条原则：
 * 1. 只在原生缺失时定义，绝不覆盖浏览器自带实现；
 * 2. 每个安装器都能单独调用并返回是否真的装了东西，方便单测；
 * 3. 单个补丁失败不影响其它补丁（老浏览器上最常见的死法是补丁自己抛错）。
 */

import {
  createIntersectionObserverClass,
  createResizeObserverClass,
} from './observers';

export type PolyfillTarget = any;

export type Installer = (target: PolyfillTarget) => string[];

function define(target: any, key: string, value: any): boolean {
  if (!target || target[key] !== undefined) return false;
  try {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    return true;
  } catch {
    try {
      target[key] = value;
      return true;
    } catch {
      return false;
    }
  }
}

function defineMethod(target: any, key: string, value: any): boolean {
  return define(target, key, value);
}

function toInteger(value: any): number {
  const num = Number(value);
  if (num !== num) return 0;
  if (!Number.isFinite(num)) return num;
  return num < 0 ? Math.ceil(num) : Math.floor(num);
}

/* ------------------------------------------------------------------ *
 * Object
 * ------------------------------------------------------------------ */

export const installObjectPolyfills: Installer = (t) => {
  const done: string[] = [];
  const O = t.Object;
  if (!O) return done;

  if (!O.assign) {
    O.assign = function assign(target: any, ...sources: any[]) {
      if (target === null || target === undefined) {
        throw new TypeError('Object.assign 不能作用于 null/undefined');
      }
      const to = O(target);
      sources.forEach((source) => {
        if (source === null || source === undefined) return;
        const from = O(source);
        Object.keys(from).forEach((key) => {
          to[key] = from[key];
        });
      });
      return to;
    };
    done.push('Object.assign');
  }

  if (!O.entries) {
    O.entries = function entries(obj: any) {
      return Object.keys(obj).map((key) => [key, obj[key]]);
    };
    done.push('Object.entries');
  }

  if (!O.values) {
    O.values = function values(obj: any) {
      return Object.keys(obj).map((key) => obj[key]);
    };
    done.push('Object.values');
  }

  if (!O.fromEntries) {
    O.fromEntries = function fromEntries(iterable: any) {
      const result: any = {};
      const list = Array.from(iterable || []);
      list.forEach((pair: any) => {
        const key = pair[0];
        const value = pair[1];
        if (key === '__proto__') {
          Object.defineProperty(result, key, {
            value,
            configurable: true,
            enumerable: true,
            writable: true,
          });
        } else {
          result[key] = value;
        }
      });
      return result;
    };
    done.push('Object.fromEntries');
  }

  if (!O.hasOwn) {
    O.hasOwn = function hasOwn(obj: any, key: any) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    };
    done.push('Object.hasOwn');
  }

  return done;
};

/* ------------------------------------------------------------------ *
 * Array / String / Number / Math
 * ------------------------------------------------------------------ */

export const installArrayPolyfills: Installer = (t) => {
  const done: string[] = [];
  const A = t.Array;
  const proto = A && A.prototype;
  if (!proto) return done;

  if (!proto.includes) {
    defineMethod(
      proto,
      'includes',
      function includes(this: any[], item: any, fromIndex?: number) {
        const len = this.length >>> 0;
        let start = toInteger(fromIndex) || 0;
        if (start < 0) start = Math.max(len + start, 0);
        for (let i = start; i < len; i += 1) {
          const value = this[i];
          // 与规范一致：NaN 也能被找到
          if (value === item || (value !== value && item !== item)) return true;
        }
        return false;
      }
    );
    done.push('Array.prototype.includes');
  }

  if (!proto.flat) {
    defineMethod(proto, 'flat', function flat(this: any[], depth?: number) {
      const level = depth === undefined ? 1 : toInteger(depth);
      const flatten = (input: any[], rest: number): any[] => {
        const output: any[] = [];
        input.forEach((item) => {
          if (Array.isArray(item) && rest > 0) {
            output.push(...flatten(item, rest - 1));
          } else {
            output.push(item);
          }
        });
        return output;
      };
      return flatten(Array.from(this), level < 0 ? Infinity : level);
    });
    done.push('Array.prototype.flat');
  }

  if (!proto.flatMap) {
    defineMethod(
      proto,
      'flatMap',
      function flatMap(this: any[], fn: any, thisArg?: any) {
        const mapped = Array.from(this).map((item, index) =>
          fn.call(thisArg, item, index, this)
        );
        return (proto.flat ? proto.flat.call(mapped, 1) : mapped) as any[];
      }
    );
    done.push('Array.prototype.flatMap');
  }

  if (!proto.at) {
    defineMethod(proto, 'at', function at(this: any[], index: number) {
      const len = this.length >>> 0;
      const rel = toInteger(index) || 0;
      const key = rel >= 0 ? rel : len + rel;
      return key < 0 || key >= len ? undefined : this[key];
    });
    done.push('Array.prototype.at');
  }

  return done;
};

export const installStringPolyfills: Installer = (t) => {
  const done: string[] = [];
  const proto = t.String && t.String.prototype;
  if (!proto) return done;

  const pad = (repeatCount: number, padString: any) => {
    let filler = padString === undefined ? ' ' : String(padString);
    if (!filler) filler = '';
    if (repeatCount <= 0 || !filler) return '';
    return new Array(Math.ceil(repeatCount / filler.length) + 1)
      .join(filler)
      .slice(0, repeatCount);
  };

  if (!proto.padStart) {
    defineMethod(
      proto,
      'padStart',
      function padStart(
        this: string,
        targetLength: number,
        padString?: string
      ) {
        const str = String(this);
        const length = toInteger(targetLength) || 0;
        if (str.length >= length) return str;
        return pad(length - str.length, padString) + str;
      }
    );
    done.push('String.prototype.padStart');
  }

  if (!proto.padEnd) {
    defineMethod(
      proto,
      'padEnd',
      function padEnd(this: string, targetLength: number, padString?: string) {
        const str = String(this);
        const length = toInteger(targetLength) || 0;
        if (str.length >= length) return str;
        return str + pad(length - str.length, padString);
      }
    );
    done.push('String.prototype.padEnd');
  }

  if (!proto.trimStart) {
    defineMethod(proto, 'trimStart', function trimStart(this: string) {
      return String(this).replace(/^\s+/, '');
    });
    done.push('String.prototype.trimStart');
  }

  if (!proto.trimEnd) {
    defineMethod(proto, 'trimEnd', function trimEnd(this: string) {
      return String(this).replace(/\s+$/, '');
    });
    done.push('String.prototype.trimEnd');
  }

  if (!proto.at) {
    defineMethod(proto, 'at', function at(this: string, index: number) {
      const chars = String(this).split('');
      const len = chars.length;
      const rel = toInteger(index) || 0;
      const key = rel >= 0 ? rel : len + rel;
      return key < 0 || key >= len ? undefined : chars[key];
    });
    done.push('String.prototype.at');
  }

  if (!proto.replaceAll) {
    defineMethod(
      proto,
      'replaceAll',
      function replaceAll(this: string, searchValue: any, replaceValue: any) {
        const source = String(this);
        if (searchValue instanceof RegExp) {
          if (!searchValue.global) {
            throw new TypeError('replaceAll 的 RegExp 参数必须带 g 标志');
          }
          return source.replace(searchValue, replaceValue);
        }
        // 转成全局正则，这样 $&、$1、函数替换的语义都与原生一致
        const escaped = String(searchValue).replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&'
        );
        return source.replace(new RegExp(escaped, 'g'), replaceValue);
      }
    );
    done.push('String.prototype.replaceAll');
  }

  if (!proto.repeat) {
    defineMethod(proto, 'repeat', function repeat(this: string, count: number) {
      const times = toInteger(count) || 0;
      if (times < 0 || times === Infinity)
        throw new RangeError('repeat 次数非法');
      return new Array(times + 1).join(String(this));
    });
    done.push('String.prototype.repeat');
  }

  return done;
};

export const installNumberPolyfills: Installer = (t) => {
  const done: string[] = [];
  const N = t.Number;
  if (!N) return done;

  if (!N.isFinite) {
    N.isFinite = (value: any) => typeof value === 'number' && isFinite(value);
    done.push('Number.isFinite');
  }
  if (!N.isNaN) {
    N.isNaN = (value: any) => typeof value === 'number' && value !== value;
    done.push('Number.isNaN');
  }
  if (!N.isInteger) {
    N.isInteger = (value: any) =>
      typeof value === 'number' &&
      isFinite(value) &&
      Math.floor(value) === value;
    done.push('Number.isInteger');
  }
  if (!N.parseInt) {
    N.parseInt = t.parseInt;
    done.push('Number.parseInt');
  }
  if (!N.parseFloat) {
    N.parseFloat = t.parseFloat;
    done.push('Number.parseFloat');
  }
  if (!N.EPSILON) {
    N.EPSILON = Math.pow(2, -52);
    done.push('Number.EPSILON');
  }
  if (!N.MAX_SAFE_INTEGER) {
    N.MAX_SAFE_INTEGER = 9007199254740991;
    done.push('Number.MAX_SAFE_INTEGER');
  }

  const M = t.Math;
  if (M) {
    if (!M.trunc) {
      M.trunc = (value: number) =>
        value < 0 ? Math.ceil(value) : Math.floor(value);
      done.push('Math.trunc');
    }
    if (!M.sign) {
      M.sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : value);
      done.push('Math.sign');
    }
    if (!M.log2) {
      M.log2 = (value: number) => Math.log(value) / Math.LN2;
      done.push('Math.log2');
    }
    if (!M.log10) {
      M.log10 = (value: number) => Math.log(value) / Math.LN10;
      done.push('Math.log10');
    }
  }

  return done;
};

/* ------------------------------------------------------------------ *
 * Promise / 微任务
 * ------------------------------------------------------------------ */

export const installPromisePolyfills: Installer = (t) => {
  const done: string[] = [];
  const P = t.Promise;
  if (typeof P !== 'function' || !P.prototype) return done;

  if (!P.prototype.finally) {
    defineMethod(
      P.prototype,
      'finally',
      function finallyFn(this: any, onFinally: any) {
        const Ctor =
          this.constructor && this.constructor.resolve ? this.constructor : P;
        const run = () =>
          typeof onFinally === 'function' ? onFinally() : onFinally;
        return this.then(
          (value: any) => Ctor.resolve(run()).then(() => value),
          (reason: any) =>
            Ctor.resolve(run()).then(() => {
              throw reason;
            })
        );
      }
    );
    done.push('Promise.prototype.finally');
  }

  if (!P.allSettled) {
    P.allSettled = function allSettled(iterable: any) {
      return new P((resolve: any, reject: any) => {
        let items: any[];
        try {
          items = Array.from(iterable || []);
        } catch (err) {
          reject(new TypeError('Promise.allSettled 需要可迭代对象'));
          return;
        }
        if (!items.length) {
          resolve([]);
          return;
        }
        const results: any[] = new Array(items.length);
        let remaining = items.length;
        items.forEach((item, index) => {
          P.resolve(item).then(
            (value: any) => {
              results[index] = { status: 'fulfilled', value };
              remaining -= 1;
              if (remaining === 0) resolve(results);
            },
            (reason: any) => {
              results[index] = { status: 'rejected', reason };
              remaining -= 1;
              if (remaining === 0) resolve(results);
            }
          );
        });
      });
    };
    done.push('Promise.allSettled');
  }

  if (!P.any) {
    P.any = function any(iterable: any) {
      return new P((resolve: any, reject: any) => {
        const items = Array.from(iterable || []);
        if (!items.length) {
          reject(new Error('Promise.any 需要至少一个 Promise'));
          return;
        }
        const errors: any[] = new Array(items.length);
        let remaining = items.length;
        items.forEach((item, index) => {
          P.resolve(item).then(resolve, (reason: any) => {
            errors[index] = reason;
            remaining -= 1;
            if (remaining === 0) {
              const err: any = new Error('全部 Promise 都被拒绝');
              err.name = 'AggregateError';
              err.errors = errors;
              reject(err);
            }
          });
        });
      });
    };
    done.push('Promise.any');
  }

  if (!t.queueMicrotask) {
    const runLater = (fn: () => void) => {
      if (typeof P === 'function') {
        P.resolve().then(fn);
      } else {
        t.setTimeout(fn, 0);
      }
    };
    define(t, 'queueMicrotask', (fn: () => void) => {
      if (typeof fn !== 'function')
        throw new TypeError('queueMicrotask 需要函数');
      runLater(fn);
    });
    done.push('queueMicrotask');
  }

  return done;
};

/* ------------------------------------------------------------------ *
 * DOM 基础
 * ------------------------------------------------------------------ */

export const installDomPolyfills: Installer = (t) => {
  const done: string[] = [];
  const Element = t.Element;
  const proto = Element && Element.prototype;

  if (proto) {
    if (!proto.matches) {
      const vendor =
        proto.msMatchesSelector ||
        proto.webkitMatchesSelector ||
        proto.mozMatchesSelector;
      if (vendor) {
        defineMethod(
          proto,
          'matches',
          function matches(this: any, selector: string) {
            return vendor.call(this, selector);
          }
        );
        done.push('Element.prototype.matches');
      }
    }

    if (!proto.closest && proto.matches) {
      defineMethod(
        proto,
        'closest',
        function closest(this: any, selector: string) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          let node = this;
          while (node && node.nodeType === 1) {
            if (node.matches(selector)) return node;
            node = node.parentElement || node.parentNode;
          }
          return null;
        }
      );
      done.push('Element.prototype.closest');
    }

    if (!proto.remove) {
      defineMethod(proto, 'remove', function remove(this: any) {
        if (this.parentNode) this.parentNode.removeChild(this);
      });
      done.push('Element.prototype.remove');
    }

    if (!proto.append) {
      defineMethod(
        proto,
        'append',
        function append(this: any, ...nodes: any[]) {
          nodes.forEach((node) => {
            this.appendChild(
              typeof node === 'string' ? t.document.createTextNode(node) : node
            );
          });
        }
      );
      done.push('Element.prototype.append');
    }

    if (!proto.prepend) {
      defineMethod(
        proto,
        'prepend',
        function prepend(this: any, ...nodes: any[]) {
          const first = this.firstChild;
          nodes.forEach((node) => {
            this.insertBefore(
              typeof node === 'string' ? t.document.createTextNode(node) : node,
              first
            );
          });
        }
      );
      done.push('Element.prototype.prepend');
    }
  }

  const NodeList = t.NodeList;
  if (NodeList && NodeList.prototype && !NodeList.prototype.forEach) {
    defineMethod(
      NodeList.prototype,
      'forEach',
      function forEach(this: any, fn: any, thisArg?: any) {
        Array.prototype.forEach.call(this, fn, thisArg);
      }
    );
    done.push('NodeList.prototype.forEach');
  }

  return done;
};

/* ------------------------------------------------------------------ *
 * AbortController（fetch 取消/超时的前提）
 * ------------------------------------------------------------------ */

function makeAbortError(): any {
  try {
    return new t_AbortError();
  } catch {
    const err: any = new Error('操作已取消');
    err.name = 'AbortError';
    return err;
  }
}

// 小技巧：用闭包持有一个 DOMException 构造器，拿不到就退回普通 Error
let t_AbortError: any = function AbortErrorShim(message: string) {
  const err: any = new Error(message);
  err.name = 'AbortError';
  return err;
};

export const installAbortController: Installer = (t) => {
  const done: string[] = [];
  if (
    typeof t.AbortController === 'function' &&
    typeof t.AbortSignal === 'function'
  ) {
    return done;
  }

  if (t.DOMException) {
    t_AbortError = function AbortErrorCtor(message: string) {
      return new t.DOMException(message || '操作已取消', 'AbortError');
    };
  }

  class AbortSignalShim {
    aborted = false;

    onabort: any = null;

    reason: any = undefined;

    __legacyPolyfill = true;

    private _listeners: Array<{ type: string; fn: any }> = [];

    addEventListener(type: string, fn: any) {
      if (typeof fn !== 'function') return;
      if (
        !this._listeners.some((item) => item.type === type && item.fn === fn)
      ) {
        this._listeners.push({ type, fn });
      }
    }

    removeEventListener(type: string, fn: any) {
      this._listeners = this._listeners.filter(
        (item) => !(item.type === type && item.fn === fn)
      );
    }

    dispatchEvent(event: any) {
      const type = event && event.type ? event.type : 'abort';
      this._listeners
        .filter((item) => item.type === type)
        .slice()
        .forEach((item) => {
          try {
            item.fn.call(this, event);
          } catch (err) {
            console.error('[legacy] abort 监听器异常', err);
          }
        });
      if (type === 'abort' && typeof this.onabort === 'function') {
        this.onabort.call(this, event);
      }
      return true;
    }

    throwIfAborted() {
      if (this.aborted) throw this.reason || makeAbortError();
    }
  }

  class AbortControllerShim {
    signal: any = new AbortSignalShim();

    abort(reason?: any) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason || makeAbortError();
      this.signal.dispatchEvent({ type: 'abort', target: this.signal });
    }
  }

  if (!t.AbortSignal) {
    define(t, 'AbortSignal', AbortSignalShim);
    done.push('AbortSignal');
  }
  if (!t.AbortController) {
    define(t, 'AbortController', AbortControllerShim);
    done.push('AbortController');
  }

  // 原生 fetch 不认我们伪造的 signal，需要自己包一层让超时/取消能 reject
  if (typeof t.fetch === 'function' && !t.fetch.__legacySignalWrapped) {
    const originalFetch = t.fetch;
    const wrappedFetch = function fetchWithSignal(
      this: any,
      input: any,
      init?: any
    ) {
      const signal = init && init.signal;
      if (!signal || !signal.__legacyPolyfill) {
        return originalFetch.call(this || t, input, init);
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal.reason || makeAbortError());
        };

        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);

        originalFetch.call(t, input, init).then(
          (response: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(response);
          },
          (err: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          }
        );
      });
    };
    wrappedFetch.__legacySignalWrapped = true;
    t.fetch = wrappedFetch;
    done.push('fetch(signal)');
  }

  return done;
};

/* ------------------------------------------------------------------ *
 * scrollTo / scrollBy 的 options 参数（Safari 10.1 只认 (x, y)）
 * ------------------------------------------------------------------ */

function supportsScrollToOptions(t: any): boolean {
  const doc = t.document;
  if (!doc || !doc.createElement) return true;

  const box = doc.createElement('div');
  const inner = doc.createElement('div');
  box.style.cssText =
    'position:absolute;top:-1000px;left:-1000px;width:10px;height:10px;overflow:hidden;';
  inner.style.cssText = 'width:10px;height:100px;';
  box.appendChild(inner);

  const host = doc.body || doc.documentElement;
  if (!host) return true;
  host.appendChild(box);

  let supported = false;
  try {
    box.scrollTo({ top: 10 });
    supported = Math.abs(box.scrollTop - 10) < 2;
  } catch {
    supported = false;
  }

  if (box.parentNode) box.parentNode.removeChild(box);
  return supported;
}

function wrapScrollMethod(holder: any, name: string) {
  const original = holder && holder[name];
  if (typeof original !== 'function') return false;
  holder[name] = function scrollWithOptions(this: any, ...args: any[]) {
    const first = args[0];
    if (first && typeof first === 'object') {
      const left = Number(first.left) || 0;
      const top = Number(first.top) || 0;
      // 老实现不支持 behavior，直接瞬移，总比完全不滚动好
      return original.call(this, left, top);
    }
    return original.apply(this, args);
  };
  return true;
}

export const installScrollPolyfills: Installer = (t) => {
  const done: string[] = [];
  if (!t.document || supportsScrollToOptions(t)) return done;

  ['scrollTo', 'scrollBy'].forEach((name) => {
    let patched = false;
    if (t.Element && t.Element.prototype) {
      patched = wrapScrollMethod(t.Element.prototype, name) || patched;
    }
    if (t.Window && t.Window.prototype) {
      patched = wrapScrollMethod(t.Window.prototype, name) || patched;
    }
    if (!patched && typeof t[name] === 'function') {
      patched = wrapScrollMethod(t, name);
    }
    if (patched) done.push(`scroll(${name} options)`);
  });

  return done;
};

/* ------------------------------------------------------------------ *
 * Observers
 * ------------------------------------------------------------------ */

export const installObserverPolyfills: Installer = (t) => {
  const done: string[] = [];
  if (!t.document) return done;

  if (typeof t.IntersectionObserver !== 'function') {
    define(t, 'IntersectionObserver', createIntersectionObserverClass(t));
    done.push('IntersectionObserver');
  }

  if (typeof t.ResizeObserver !== 'function') {
    define(t, 'ResizeObserver', createResizeObserverClass(t));
    done.push('ResizeObserver');
  }

  return done;
};

export const installGlobalThis: Installer = (t) => {
  if (t.globalThis) return [];
  define(t, 'globalThis', t);
  return ['globalThis'];
};

/** 安装器注册表，顺序即执行顺序 */
export const INSTALLERS: Installer[] = [
  installGlobalThis,
  installObjectPolyfills,
  installArrayPolyfills,
  installStringPolyfills,
  installNumberPolyfills,
  installPromisePolyfills,
  installDomPolyfills,
  installAbortController,
  installScrollPolyfills,
  installObserverPolyfills,
];

/** 已安装的补丁清单，调试/诊断面板用 */
export const installedPolyfills: string[] = [];

/**
 * 依次执行所有安装器。单个失败不影响后续。
 */
export function installPolyfills(target?: PolyfillTarget): string[] {
  const t =
    target || (typeof globalThis !== 'undefined' ? (globalThis as any) : {});
  const installed: string[] = [];

  INSTALLERS.forEach((installer) => {
    try {
      const result = installer(t) || [];
      installed.push(...result);
    } catch (err) {
      console.error('[legacy] 补丁安装失败', err);
    }
  });

  installedPolyfills.length = 0;
  installedPolyfills.push(...installed);
  return installed;
}

// 模块被导入即安装（LegacySupport 在 layout 里最先加载）
if (typeof window !== 'undefined') {
  installPolyfills(window);
}
