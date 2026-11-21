import { isAllowedMediaUrl } from '../bilibili';

describe('isAllowedMediaUrl', () => {
  const originalRelay = process.env.BILIBILI_RELAY;
  const originalHosts = process.env.BILIBILI_STREAM_HOSTS;

  afterEach(() => {
    if (originalRelay === undefined) delete process.env.BILIBILI_RELAY;
    else process.env.BILIBILI_RELAY = originalRelay;
    if (originalHosts === undefined) delete process.env.BILIBILI_STREAM_HOSTS;
    else process.env.BILIBILI_STREAM_HOSTS = originalHosts;
  });

  it('允许 B 站 CDN 域名', () => {
    expect(
      isAllowedMediaUrl('https://upos-sz-mirrorcos.bilivideo.com/a.m4s')
    ).toBe(true);
    expect(isAllowedMediaUrl('https://i0.hdslb.com/cover.jpg')).toBe(true);
  });

  it('拒绝内网与任意第三方地址', () => {
    expect(isAllowedMediaUrl('http://127.0.0.1:8080/a.mp4')).toBe(false);
    expect(isAllowedMediaUrl('http://192.168.1.2/a.mp4')).toBe(false);
    expect(isAllowedMediaUrl('https://evil.example.com/a.mp4')).toBe(false);
  });

  it('允许显式配置的第三方域名', () => {
    process.env.BILIBILI_STREAM_HOSTS = 'cdn.example.com';
    expect(isAllowedMediaUrl('https://cdn.example.com/a.mp4')).toBe(true);
  });

  it('允许第三方聚合服务自身的域名', () => {
    process.env.BILIBILI_RELAY = 'https://bili-relay.example.com';
    expect(isAllowedMediaUrl('https://bili-relay.example.com/a.mp4')).toBe(
      true
    );
  });
});
