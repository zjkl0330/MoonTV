/* eslint-disable @typescript-eslint/no-explicit-any */

// 画面填充模式：Kazumi 在桌面端有“填充/适应”选项，Web 端用 object-fit 实现。

export const OBJECT_FIT_KEY = 'player_object_fit';

export interface ObjectFitOption {
  value: string;
  label: string;
}

export const OBJECT_FIT_OPTIONS: ObjectFitOption[] = [
  { value: 'contain', label: '适应画面' },
  { value: 'cover', label: '铺满裁边' },
  { value: 'fill', label: '拉伸填满' },
];

export function normalizeObjectFit(value: unknown): string {
  return OBJECT_FIT_OPTIONS.some((option) => option.value === value)
    ? String(value)
    : 'contain';
}

export function readObjectFit(): string {
  if (typeof window === 'undefined') return 'contain';
  return normalizeObjectFit(localStorage.getItem(OBJECT_FIT_KEY));
}

export function objectFitLabel(value: string): string {
  const matched = OBJECT_FIT_OPTIONS.find((option) => option.value === value);
  return matched ? matched.label : '适应画面';
}

export function applyObjectFit(
  video: HTMLVideoElement | undefined | null,
  value: unknown
): string {
  const mode = normalizeObjectFit(value);
  if (video) video.style.objectFit = mode;
  return mode;
}

export function saveObjectFit(value: unknown): string {
  const mode = normalizeObjectFit(value);
  try {
    localStorage.setItem(OBJECT_FIT_KEY, mode);
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  return mode;
}
