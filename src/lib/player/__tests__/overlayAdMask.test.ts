import {
  type GridFrame,
  type MaskRect,
  analyzeFrame,
  computeContentRect,
  detectStaticOverlays,
  mapFrameRectToBox,
  mergeRects,
  readManualMasks,
  reconcileRects,
  saveManualMasks,
} from '../overlayAdMask';

const COLS = 16;
const ROWS = 9;

function buildFrame(backgroundLuma: number, stable: Set<number>): GridFrame {
  const cells = Array.from({ length: COLS * ROWS }, (_, index) =>
    stable.has(index)
      ? { luma: 0.5, detail: 0.3 }
      : { luma: backgroundLuma, detail: 0.25 }
  );
  return { cols: COLS, rows: ROWS, cells };
}

function topLeftBlock(): Set<number> {
  return new Set([0, 1, 2, COLS, COLS + 1, COLS + 2]);
}

describe('analyzeFrame', () => {
  it('统计每格平均亮度和纹理强度', () => {
    // 4x4 图像，左半黑右半白
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const value = x < 2 ? 0 : 255;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    const frame = analyzeFrame(data, width, height, 2, 1);
    expect(frame.cells).toHaveLength(2);
    expect(frame.cells[0].luma).toBeCloseTo(0, 2);
    expect(frame.cells[1].luma).toBeCloseTo(1, 2);
    expect(frame.cells[1].detail).toBeGreaterThanOrEqual(0);
  });
});

describe('detectStaticOverlays', () => {
  it('画面在动、局部不动时能框出角标区域', () => {
    const history = [0.2, 0.8, 0.2, 0.8].map((luma) =>
      buildFrame(luma, topLeftBlock())
    );

    const rects = detectStaticOverlays(history, 'medium');
    expect(rects.length).toBeGreaterThan(0);

    const matched = rects.some(
      (rect) =>
        rect.x <= 0.01 &&
        rect.y <= 0.01 &&
        rect.x + rect.w >= 0.18 &&
        rect.y + rect.h >= 0.2
    );
    expect(matched).toBe(true);
  });

  it('整帧静止时不做判断，避免误伤静态背景', () => {
    const history = [0.5, 0.5, 0.5, 0.5].map((luma) =>
      buildFrame(luma, topLeftBlock())
    );
    expect(detectStaticOverlays(history, 'medium')).toEqual([]);
  });

  it('历史帧不足时不猜', () => {
    const history = [0.2, 0.8].map((luma) => buildFrame(luma, topLeftBlock()));
    expect(detectStaticOverlays(history, 'medium')).toEqual([]);
  });
});

describe('mergeRects / reconcileRects', () => {
  it('重叠的框会合并成一个', () => {
    const merged = mergeRects([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.1, source: 'smart' },
      { x: 0.15, y: 0.1, w: 0.2, h: 0.1, source: 'smart' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].w).toBeCloseTo(0.25, 2);
  });

  it('检测结果与已有框做迟滞匹配', () => {
    const current: MaskRect[] = [
      { x: 0.1, y: 0.1, w: 0.2, h: 0.1, source: 'smart' },
    ];
    const detected: MaskRect[] = [
      { x: 0.11, y: 0.1, w: 0.2, h: 0.1, source: 'smart' },
      { x: 0.6, y: 0.6, w: 0.1, h: 0.1, source: 'smart' },
    ];
    const next = reconcileRects(current, detected);
    expect(next).toHaveLength(2);
  });
});

describe('computeContentRect / mapFrameRectToBox', () => {
  it('contain 模式居中留黑边', () => {
    const content = computeContentRect(
      { left: 0, top: 0, width: 1000, height: 500 },
      1000,
      1000,
      'contain'
    );
    expect(content.width).toBeCloseTo(500);
    expect(content.height).toBeCloseTo(500);
    expect(content.left).toBeCloseTo(250);
    expect(content.top).toBeCloseTo(0);
  });

  it('fill 模式直接铺满，归一化坐标原样映射', () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    const mapped = mapFrameRectToBox(
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      box,
      1000,
      1000,
      'fill'
    );
    expect(mapped?.x).toBeCloseTo(0.1);
    expect(mapped?.w).toBeCloseTo(0.3);
  });

  it('cover 模式裁掉盒子外的部分', () => {
    const box = { left: 0, top: 0, width: 100, height: 50 };
    const mapped = mapFrameRectToBox(
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      box,
      100,
      100,
      'cover'
    );
    expect(mapped).not.toBeNull();
    if (!mapped) throw new Error('cover 模式下可见区域不应为空');
    expect(mapped.x).toBeGreaterThanOrEqual(0);
    expect(mapped.x + mapped.w).toBeLessThanOrEqual(1);
  });
});

describe('手动打码区域持久化', () => {
  afterEach(() => localStorage.clear());

  it('保存并读取合法区域', () => {
    const rects = saveManualMasks('ffzy', [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, source: 'manual' },
    ]);
    expect(rects).toHaveLength(1);
    expect(readManualMasks('ffzy')).toHaveLength(1);
    expect(readManualMasks('other')).toEqual([]);
  });

  it('过滤掉过小或非法区域', () => {
    const rects = saveManualMasks('ffzy', [
      { x: 0.1, y: 0.2, w: 0.001, h: 0.1 },
      { x: 0.1, y: 0.2, w: 0.2, h: 0.1 },
    ]);
    expect(rects).toHaveLength(1);
  });
});
