'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, no-console, simple-import-sort/imports */

// 引入即安装补丁：必须是本模块的第一条 import，顺序不能交给自动排序
import '@/lib/legacy/polyfills';

import { useEffect, useState } from 'react';

import {
  blockingMissing,
  degradableMissing,
  describeFeatures,
  hlsStrategy,
  readBrowserEnv,
} from '@/lib/legacy/browser-support';

const DISMISS_KEY = 'legacy_notice_dismissed';

/**
 * 老浏览器提示条。
 *
 * 补丁装完之后再探测一次：
 * - 关键能力（Promise/fetch/Module）缺失 → 整站不可用，给强提示；
 * - 只缺 HLS 播放能力 → 只在播放页提示（这里统一用一句文案说明）。
 */
export function LegacySupport() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      dismissed = false;
    }
    if (dismissed) return;

    // 注意：这里读到的是「补丁装完之后」的能力
    const env = readBrowserEnv();
    const blocking = blockingMissing(env);
    if (blocking.length) {
      setMessage(
        `当前浏览器缺少 ${describeFeatures(blocking).join(
          '、'
        )}，页面可能无法正常使用，建议升级浏览器。`
      );
      return;
    }

    if (hlsStrategy(env) === 'unsupported') {
      setMessage(
        '当前浏览器不支持 HLS 播放（缺少 MediaSource），可以浏览内容，但视频需要换用新版浏览器或系统自带播放器。'
      );
      return;
    }

    const degradable = degradableMissing(env);
    if (degradable.length > 0) {
      console.info('[legacy] 已启用降级补丁：', degradable.join(', '));
    }
  }, []);

  if (!message) return null;

  const handleDismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* 隐私模式写不进去就算了 */
    }
    setMessage(null);
  };

  return (
    <div
      role='status'
      className='fixed inset-x-0 bottom-0 z-[9999] flex items-start gap-3 border-t border-amber-300 bg-amber-50/95 px-4 py-3 text-sm text-amber-900 shadow-lg backdrop-blur sm:items-center'
    >
      <span className='flex-1 leading-relaxed'>{message}</span>
      <button
        type='button'
        onClick={handleDismiss}
        className='shrink-0 rounded border border-amber-400 px-2 py-1 text-xs text-amber-900 hover:bg-amber-100'
      >
        知道了
      </button>
    </div>
  );
}

export default LegacySupport;
