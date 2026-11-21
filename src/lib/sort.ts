/**
 * 搜索/收藏结果的排序规则。
 *
 * 采集站返回的列表顺序并不可靠，用户需要按「最新发布」翻片，
 * 这里把排序抽成纯函数，便于单测和复用。
 */

export type SearchSortMode = 'relevance' | 'latest' | 'year' | 'title';

export interface SortableVideo {
  title: string;
  year?: string;
  /** 发布时间，毫秒时间戳 */
  publish_time?: number;
  source_name?: string;
  source?: string;
}

export const SEARCH_SORT_KEY = 'search_sort_mode';

const SORT_MODES: SearchSortMode[] = ['relevance', 'latest', 'year', 'title'];

export function normalizeSortMode(value: unknown): SearchSortMode {
  return SORT_MODES.includes(value as SearchSortMode)
    ? (value as SearchSortMode)
    : 'relevance';
}

export function sortModeLabel(value: SearchSortMode): string {
  if (value === 'latest') return '最近发布';
  if (value === 'year') return '年份从新到旧';
  if (value === 'title') return '名称';
  return '综合';
}

export function readSearchSortMode(): SearchSortMode {
  if (typeof window === 'undefined') return 'relevance';
  return normalizeSortMode(localStorage.getItem(SEARCH_SORT_KEY));
}

export function saveSearchSortMode(value: unknown): SearchSortMode {
  const mode = normalizeSortMode(value);
  try {
    localStorage.setItem(SEARCH_SORT_KEY, mode);
  } catch {
    /* 隐私模式写不进去 */
  }
  return mode;
}

/**
 * 兼容采集站的多种时间格式：
 * - 10/13 位时间戳；
 * - '2024-01-02 12:00:00' / '2024/01/02'；
 * - ISO 字符串。
 * 纯年份不算发布时间，返回 undefined，避免把 2024 当成 1970。
 */
export function parsePublishTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return undefined;

  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  if (!/\d{4}[-/]\d{1,2}/.test(raw)) return undefined;

  const normalized = raw.replace(/\//g, '-').replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function yearNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').match(/(\d{4})/);
  return match ? Number(match[1]) : 0;
}

function normalizeTitle(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function relevanceRank(title: string, query: string): number {
  const q = normalizeTitle(query);
  if (!q) return 0;
  const t = normalizeTitle(title);
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return 3;
}

function compareTitle(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN');
}

export function compareVideos(
  a: SortableVideo,
  b: SortableVideo,
  mode: SearchSortMode,
  query = ''
): number {
  if (mode === 'latest') {
    const at = a.publish_time || 0;
    const bt = b.publish_time || 0;
    if (at !== bt) return bt - at;
  } else if (mode === 'year') {
    const ay = yearNumber(a.year);
    const by = yearNumber(b.year);
    if (ay !== by) return by - ay;
  } else if (mode === 'title') {
    return compareTitle(a.title, b.title);
  } else {
    const ar = relevanceRank(a.title, query);
    const br = relevanceRank(b.title, query);
    if (ar !== br) return ar - br;

    const ay = yearNumber(a.year);
    const by = yearNumber(b.year);
    if (ay !== by) return by - ay;
  }

  // 同分时按名称、来源稳定排序，避免每次请求顺序漂移
  const byTitle = compareTitle(a.title, b.title);
  if (byTitle !== 0) return byTitle;
  return compareTitle(
    a.source_name || a.source || '',
    b.source_name || b.source || ''
  );
}

export function sortVideos<T extends SortableVideo>(
  items: T[],
  mode: SearchSortMode,
  query = ''
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const compared = compareVideos(a.item, b.item, mode, query);
      return compared !== 0 ? compared : a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** 聚合结果取组内最新发布时间与最新年份参与排序 */
export function sortGroups<T extends SortableVideo>(
  groups: Array<[string, T[]]>,
  mode: SearchSortMode,
  query = ''
): Array<[string, T[]]> {
  const representatives = new Map<string, SortableVideo>();

  groups.forEach(([key, items]) => {
    const first = items[0];
    if (!first) return;
    const latest = items.reduce(
      (max, item) => Math.max(max, item.publish_time || 0),
      0
    );
    const newestYear = items.reduce(
      (max, item) => Math.max(max, yearNumber(item.year)),
      0
    );
    representatives.set(key, {
      ...first,
      publish_time: latest || undefined,
      year: newestYear ? String(newestYear) : first.year,
    });
  });

  return groups
    .map((group, index) => ({
      group,
      index,
      rep: representatives.get(group[0]),
    }))
    .sort((a, b) => {
      if (!a.rep || !b.rep) return a.index - b.index;
      const compared = compareVideos(a.rep, b.rep, mode, query);
      return compared !== 0 ? compared : a.index - b.index;
    })
    .map((entry) => entry.group);
}

export interface FavoriteSortable {
  title: string;
  year?: string;
  save_time?: number;
}

export type FavoriteSortMode = 'recent' | 'year' | 'title';

export function sortFavorites<T extends FavoriteSortable>(
  items: T[],
  mode: FavoriteSortMode
): T[] {
  const copy = items.map((item, index) => ({ item, index }));
  copy.sort((a, b) => {
    if (mode === 'year') {
      const ay = yearNumber(a.item.year);
      const by = yearNumber(b.item.year);
      if (ay !== by) return by - ay;
    } else if (mode === 'title') {
      const compared = compareTitle(a.item.title, b.item.title);
      if (compared !== 0) return compared;
    } else {
      const at = a.item.save_time || 0;
      const bt = b.item.save_time || 0;
      if (at !== bt) return bt - at;
    }
    return a.index - b.index;
  });
  return copy.map((entry) => entry.item);
}
