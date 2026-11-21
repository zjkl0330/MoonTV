import { NextResponse } from 'next/server';

import { isAllowedMediaUrl } from '@/lib/bilibili';

export const runtime = 'edge';

const FETCH_TIMEOUT_MS = 15000;

const PASS_THROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];

function isPlaylist(contentType: string, pathname: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.includes('mpegurl') ||
    type.includes('x-mpegurl') ||
    pathname.toLowerCase().endsWith('.m3u8')
  );
}

function proxyPlaylistUrl(target: string, requestUrl: string): string {
  const proxied = new URL('/api/bilibili/stream', requestUrl);
  proxied.searchParams.set('url', target);
  return proxied.toString();
}

/**
 * m3u8 里的分片/密钥都是相对地址，必须改写成同源代理地址，
 * 否则浏览器会直接去 B 站 CDN 拉取，被 Referer 防盗链拦下。
 */
function rewritePlaylist(
  content: string,
  baseUrl: string,
  requestUrl: string
): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (matched, uri: string) => {
          try {
            const absolute = new URL(uri, baseUrl).toString();
            return `URI="${proxyPlaylistUrl(absolute, requestUrl)}"`;
          } catch {
            return matched;
          }
        });
      }

      try {
        const absolute = new URL(trimmed, baseUrl).toString();
        return proxyPlaylistUrl(absolute, requestUrl);
      } catch {
        return line;
      }
    })
    .join('\n');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: '缺少 url 参数' }, { status: 400 });
  }
  if (!isAllowedMediaUrl(rawUrl)) {
    return NextResponse.json({ error: '不允许代理该地址' }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Accept: '*/*',
    };

    // 视频播放依赖 Range，必须原样带给上游
    const range = request.headers.get('range');
    if (range) headers.Range = range;
    const ifRange = request.headers.get('if-range');
    if (ifRange) headers['If-Range'] = ifRange;

    const upstream = await fetch(rawUrl, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(null, { status: upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const target = new URL(rawUrl);

    if (isPlaylist(contentType, target.pathname)) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, target.toString(), request.url);
      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const responseHeaders = new Headers();
    PASS_THROUGH_HEADERS.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    });
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return NextResponse.json(
      { error: aborted ? '上游超时' : 'B 站流代理失败' },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
