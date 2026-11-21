'use client';

import { useEffect } from 'react';

import { CURRENT_VERSION } from '@/lib/version';

const RELOAD_KEY = 'moontv_sw_reload_version';

/**
 * 线上更新后，旧 Service Worker 可能继续返回旧 JS。
 * 这里主动检查更新，并在新 SW 接管时刷新一次页面。
 */
export function ServiceWorkerUpdater() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;

      try {
        if (sessionStorage.getItem(RELOAD_KEY) === CURRENT_VERSION) return;
        sessionStorage.setItem(RELOAD_KEY, CURRENT_VERSION);
      } catch {
        /* 隐私模式忽略 */
      }
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      onControllerChange
    );
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined);

    return () => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange
      );
    };
  }, []);

  return null;
}
