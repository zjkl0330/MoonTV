import { NextResponse } from 'next/server';

import { isAllowedMediaUrl, resolveBilibiliPlayUrl } from '@/lib/bilibili';
import { getAvailableApiSites } from '@/lib/config';

export const runtime = 'edge';

/**
 * 解析 B 站分 P 的真实播放地址，然后 302 到同源流代理。
 * 剧集列表里只保存这个轻量地址，点到哪一集才解析哪一集，避免详情页打一堆上游请求。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bvid = searchParams.get('bvid') || '';
  const cid = searchParams.get('cid') || '';
  const qn = Number(searchParams.get('qn')) || 64;
  const sourceKey = searchParams.get('source') || 'bilibili';

  if (!/^BV[0-9A-Za-z]{10}$/i.test(bvid) || !/^\d+$/.test(cid)) {
    return NextResponse.json({ error: '播放参数无效' }, { status: 400 });
  }

  try {
    const sites = await getAvailableApiSites();
    const site = sites.find((item) => item.key === sourceKey) ||
      sites.find((item) => item.type === 'bilibili') || {
        key: 'bilibili',
        api: 'https://api.bilibili.com',
        name: '哔哩哔哩',
        type: 'bilibili' as const,
      };

    const mediaUrl = await resolveBilibiliPlayUrl(site, bvid, cid, qn);
    if (!isAllowedMediaUrl(mediaUrl)) {
      return NextResponse.json(
        { error: '上游返回了不受信任的播放地址' },
        { status: 502 }
      );
    }

    const proxied = new URL('/api/bilibili/stream', request.url);
    proxied.searchParams.set('url', mediaUrl);
    return Response.redirect(proxied.toString(), 302);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message || 'B 站播放地址解析失败' },
      { status: 502 }
    );
  }
}
