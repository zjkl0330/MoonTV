/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 哔哩哔哩资源接入。
 *
 * 推荐方式：配置第三方聚合服务（BILIBILI_RELAY）。
 * 服务只需实现三个 GET 接口：
 *   /search?keyword=xxx  -> { list: [{ bvid, title, pic, pubdate, duration, author, description }] }
 *   /detail?bvid=BVxxx   -> { bvid, title, pic, pubdate, desc, owner, pages: [{ cid, page, part, duration }] }
 *   /play?bvid=&cid=&qn= -> { url: 'https://...mp4' } 或 { durl: [{ url }] }
 *
 * 没有第三方服务时，可通过 BILIBILI_COOKIE + BILIBILI_DIRECT=true 走官方接口，
 * 但官方接口对机房 IP 和登录态要求较高，失败时只返回空结果，不会拖垮其他源。
 */

import type { ApiSite } from './config';
import { parsePublishTime } from './sort';
import type { SearchResult } from './types';
import { cleanHtmlTags } from './utils';

const OFFICIAL_BASE = 'https://api.bilibili.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_QN = 64; // 720P，未登录时更稳
const REQUEST_TIMEOUT_MS = 8000;

const MEDIA_HOST_SUFFIXES = [
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'bilibili.com',
  'biliapi.net',
];

let warnedNotConfigured = false;

function warnNotConfigured(): void {
  if (warnedNotConfigured) return;
  warnedNotConfigured = true;
  console.warn(
    'B 站源未配置：请设置 BILIBILI_RELAY（第三方聚合地址）或 BILIBILI_COOKIE + BILIBILI_DIRECT=true'
  );
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function relayBase(site: ApiSite): string | null {
  const env = process.env.BILIBILI_RELAY?.trim();
  if (env) return trimBase(env);
  const api = site.api?.trim();
  // api.bilibili.com 视为官方直连，不套第三方接口协议
  if (api && !/^https?:\/\/api\.bilibili\.com\/?$/i.test(api)) {
    return trimBase(api);
  }
  return null;
}

function directAllowed(): boolean {
  return (
    process.env.BILIBILI_DIRECT === 'true' ||
    !!process.env.BILIBILI_COOKIE?.trim()
  );
}

function buildHeaders(isRelay: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
  };

  const cookie = process.env.BILIBILI_COOKIE?.trim();
  if (cookie) headers.Cookie = cookie;

  if (isRelay) {
    const key = process.env.BILIBILI_RELAY_KEY?.trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers['X-API-Key'] = key;
    }
  }
  return headers;
}

async function fetchJson(url: string, isRelay: boolean): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: buildHeaders(isRelay),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`上游返回 ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizePic(pic: string | undefined): string {
  if (!pic) return '';
  if (pic.startsWith('//')) return `https:${pic}`;
  return pic;
}

function yearFromTimestamp(value: unknown): string {
  const time = parsePublishTime(value);
  if (!time) return '';
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());
}

function buildPlayUrl(
  sourceKey: string,
  bvid: string,
  cid: string,
  qn = DEFAULT_QN
): string {
  const params = new URLSearchParams({
    source: sourceKey,
    bvid,
    cid,
    qn: String(qn),
  });
  return `/api/bilibili/play?${params.toString()}`;
}

interface NormalizedSearchItem {
  bvid?: string;
  title?: string;
  pic?: string;
  pubdate?: number | string;
  duration?: number | string;
  author?: string;
  description?: string;
  pages?: number;
}

function extractSearchItems(data: any): NormalizedSearchItem[] {
  const candidates = [
    data?.list,
    data?.result,
    data?.data?.list,
    data?.data?.result,
    data?.data,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function mapSearchItem(
  item: NormalizedSearchItem,
  site: ApiSite
): SearchResult | null {
  const bvid = String(item?.bvid || (item as any)?.bv_id || '').trim();
  if (!bvid) return null;

  return {
    id: bvid,
    title: cleanHtmlTags(String(item.title || bvid)).replace(/\n/g, ' '),
    poster: normalizePic(item.pic),
    // 搜索阶段拿不到分P，先留空；详情接口会补齐
    episodes: [],
    source: site.key,
    source_name: site.name,
    class: item.author,
    year: yearFromTimestamp(item.pubdate) || 'unknown',
    desc: cleanHtmlTags(item.description || ''),
    type_name: 'B站视频',
    publish_time: parsePublishTime(item.pubdate),
  };
}

export async function searchBilibili(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  const base = relayBase(site);
  if (!base && !directAllowed()) {
    warnNotConfigured();
    return [];
  }

  try {
    if (base) {
      const url = `${base}/search?keyword=${encodeURIComponent(query)}&page=1`;
      const data = await fetchJson(url, true);
      return extractSearchItems(data)
        .map((item) => mapSearchItem(item, site))
        .filter((item): item is SearchResult => !!item);
    }

    const url = `${OFFICIAL_BASE}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
      query
    )}&page=1`;
    const data = await fetchJson(url, false);
    if (data?.code !== 0) {
      console.warn('B 站搜索失败:', data?.code, data?.message);
      return [];
    }
    return extractSearchItems(data)
      .map((item) => mapSearchItem(item, site))
      .filter((item): item is SearchResult => !!item);
  } catch (err) {
    console.warn('B 站搜索不可用:', (err as Error).message);
    return [];
  }
}

interface NormalizedPage {
  cid: string;
  page?: number;
  part?: string;
  duration?: number;
}

interface NormalizedDetail {
  bvid: string;
  cid?: string;
  title: string;
  pic: string;
  pubdate?: number | string;
  desc?: string;
  owner?: string;
  pages: NormalizedPage[];
}

function normalizeDetail(
  data: any,
  fallbackBvid: string
): NormalizedDetail | null {
  const source = data?.data || data;
  if (!source) return null;

  const bvid = String(source.bvid || fallbackBvid).trim();
  if (!bvid) return null;

  const owner =
    typeof source.owner === 'string'
      ? source.owner
      : source.owner?.name || source.author || '';

  const pages = Array.isArray(source.pages)
    ? source.pages
        .map((page: any) => ({
          cid: String(page?.cid || '').trim(),
          page: Number(page?.page) || undefined,
          part: page?.part ? String(page.part) : undefined,
          duration: Number(page?.duration) || undefined,
        }))
        .filter((page: NormalizedPage) => !!page.cid)
    : [];

  return {
    bvid,
    cid: source.cid ? String(source.cid) : undefined,
    title: String(source.title || bvid),
    pic: normalizePic(source.pic),
    pubdate: source.pubdate || source.pub_time || source.ctime,
    desc: source.desc || source.description || '',
    owner,
    pages,
  };
}

export async function getBilibiliDetail(
  site: ApiSite,
  id: string
): Promise<SearchResult> {
  if (!/^BV[0-9A-Za-z]{10}$/i.test(id)) {
    throw new Error('无效的 B 站视频 ID');
  }

  const base = relayBase(site);
  if (!base && !directAllowed()) {
    throw new Error(
      'B 站源未配置：请设置 BILIBILI_RELAY（第三方聚合地址）或 BILIBILI_COOKIE + BILIBILI_DIRECT=true'
    );
  }

  const url = base
    ? `${base}/detail?bvid=${encodeURIComponent(id)}`
    : `${OFFICIAL_BASE}/x/web-interface/view?bvid=${encodeURIComponent(id)}`;
  const data = await fetchJson(url, !!base);

  if (!base && data?.code !== 0) {
    throw new Error(`B 站详情获取失败: ${data?.message || data?.code}`);
  }

  const detail = normalizeDetail(data, id);
  if (!detail) throw new Error('B 站详情内容为空');

  // 多分 P 视频按分 P 生成剧集；单 P 视频用主 cid 兜底
  const pages =
    detail.pages.length > 0
      ? detail.pages
      : detail.cid
      ? [{ cid: detail.cid }]
      : [];

  const episodes = pages.map((page) =>
    buildPlayUrl(site.key, detail.bvid, page.cid)
  );

  return {
    id: detail.bvid,
    title: detail.title,
    poster: detail.pic,
    episodes,
    source: site.key,
    source_name: site.name,
    class: detail.owner,
    year: yearFromTimestamp(detail.pubdate) || 'unknown',
    desc: cleanHtmlTags(detail.desc || ''),
    type_name: pages.length > 1 ? `B站视频 · ${pages.length}P` : 'B站视频',
    publish_time: parsePublishTime(detail.pubdate),
  };
}

/** 解析实际播放地址（mp4/m3u8），供 /api/bilibili/play 重定向到流代理 */
export async function resolveBilibiliPlayUrl(
  site: ApiSite,
  bvid: string,
  cid: string,
  qn = DEFAULT_QN
): Promise<string> {
  if (!/^BV[0-9A-Za-z]{10}$/i.test(bvid) || !/^\d+$/.test(cid)) {
    throw new Error('播放参数无效');
  }

  const base = relayBase(site);
  if (!base && !directAllowed()) {
    throw new Error('B 站源未配置第三方服务');
  }

  const url = base
    ? `${base}/play?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(
        cid
      )}&qn=${qn}`
    : `${OFFICIAL_BASE}/x/player/playurl?bvid=${encodeURIComponent(
        bvid
      )}&cid=${encodeURIComponent(
        cid
      )}&qn=${qn}&fnval=0&fnver=0&fourk=1&platform=html5&high_quality=1`;

  const data = await fetchJson(url, !!base);

  if (!base && data?.code !== 0) {
    throw new Error(`B 站播放地址获取失败: ${data?.message || data?.code}`);
  }

  const source = data?.data || data;
  const direct =
    source?.url || source?.durl?.[0]?.url || source?.result?.url || data?.url;

  if (!direct || typeof direct !== 'string') {
    throw new Error('上游没有返回可播放地址');
  }

  // 第三方接口可能返回相对路径
  try {
    return new URL(direct, base || OFFICIAL_BASE).toString();
  } catch {
    throw new Error('播放地址格式无效');
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 只允许代理 B 站 CDN 与显式配置的第三方域名，避免变成任意 URL 转发器 */
export function isAllowedMediaUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (isPrivateHost(parsed.hostname)) return false;

  const relayHost = (() => {
    try {
      const relay = process.env.BILIBILI_RELAY?.trim();
      return relay ? new URL(relay).hostname.toLowerCase() : '';
    } catch {
      return '';
    }
  })();
  if (relayHost && parsed.hostname.toLowerCase() === relayHost) return true;

  const extra = (process.env.BILIBILI_STREAM_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  return [...MEDIA_HOST_SUFFIXES, ...extra].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}
