import { expect, test } from '@playwright/test';

const E2E_PASSWORD = 'moontv-e2e-password';
const BASE_URL = 'http://127.0.0.1:3000';

const video = {
  id: 'e2e-1',
  title: '测试影片',
  poster:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyIiBoZWlnaHQ9IjMiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjMiIGZpbGw9IiMzMzMiLz48L3N2Zz4=',
  episodes: ['/e2e-fixture.m3u8'],
  source: 'e2e-source',
  source_name: 'E2E 源',
  year: '2026',
  desc: 'E2E 测试用影片',
  type_name: '电影',
};

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: 'auth',
      value: encodeURIComponent(JSON.stringify({ password: E2E_PASSWORD })),
      url: BASE_URL,
    },
  ]);
});

test('搜索 → 播放器冒烟：结果可点击、播放器与设置面板正常渲染', async ({
  page,
}) => {
  await page.route('**/api/search**', (route) =>
    route.fulfill({ json: { results: [video] } })
  );
  await page.route('**/api/detail**', (route) =>
    route.fulfill({ json: video })
  );
  await page.route('**/e2e-fixture.m3u8', (route) =>
    route.fulfill({
      path: 'e2e/fixtures/e2e.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
    })
  );
  await page.route('**/seg*.bin', (route) =>
    route.fulfill({
      path: 'e2e/fixtures/seg0.bin',
      contentType: 'video/mp2t',
    })
  );

  await page.goto('/search?q=测试影片');

  // 搜索结果与排序控件
  await expect(page.getByText('测试影片').first()).toBeVisible();
  await expect(page.getByLabel('搜索结果排序方式')).toBeVisible();
  await page.getByLabel('搜索结果排序方式').selectOption('latest');

  // 进入播放页
  await page.getByText('测试影片').first().click();
  await expect(page).toHaveURL(/\/play\?/);

  // 播放器已经创建，视频加载完成后打开设置面板
  await expect(page.locator('.art-video-player')).toBeVisible();
  await expect(page.getByText('🔄 视频加载中...')).toBeHidden({
    timeout: 20_000,
  });

  await page.locator('[aria-label="显示设置"]').click();
  await expect(page.getByText('画质增强')).toBeVisible();
  await expect(page.getByText('悬浮广告打码')).toBeVisible();

  // 二级设置项应展开子菜单，选中后仍停留在子菜单
  await page.getByText('画质增强').click();
  await expect(page.getByText('GPU 锐化')).toBeVisible();
  await expect(page.getByText('兼容锐化', { exact: true })).toBeVisible();
  await page.getByText('兼容锐化', { exact: true }).click();
  await expect(page.getByText('兼容锐化', { exact: true })).toBeVisible();
  await expect(page.getByText('GPU 锐化')).toBeVisible();
});

test('手动打码区域显示在视频画面之上', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('player_overlay_mask_mode', 'manual');
      localStorage.setItem(
        'player_overlay_manual_masks:e2e-source',
        JSON.stringify([{ x: 0.1, y: 0.1, w: 0.3, h: 0.15, source: 'manual' }])
      );
    } catch {
      /* ignore */
    }
  });

  await page.route('**/api/search**', (route) =>
    route.fulfill({ json: { results: [video] } })
  );
  await page.route('**/api/detail**', (route) =>
    route.fulfill({ json: video })
  );
  await page.route('**/e2e-fixture.m3u8', (route) =>
    route.fulfill({
      path: 'e2e/fixtures/e2e.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
    })
  );
  await page.route('**/seg*.bin', (route) =>
    route.fulfill({
      path: 'e2e/fixtures/seg0.bin',
      contentType: 'video/mp2t',
    })
  );

  await page.goto('/play?source=e2e-source&id=e2e-1&title=测试影片&year=2026');
  await expect(page.locator('.art-video-player')).toBeVisible();
  await expect(page.getByText('🔄 视频加载中...')).toBeHidden({
    timeout: 20_000,
  });

  const mask = page.locator('.moontv-ad-mask').first();
  await expect(mask).toBeVisible();

  const zIndex = await page
    .locator('.moontv-ad-mask-layer')
    .evaluate((element) => Number(getComputedStyle(element).zIndex));
  expect(zIndex).toBeGreaterThan(10);
});
