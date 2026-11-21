import {
  type SortableVideo,
  normalizeSortMode,
  parsePublishTime,
  sortFavorites,
  sortGroups,
  sortVideos,
} from '../sort';

const items: Array<SortableVideo & { id: string }> = [
  { id: 'a', title: '庆余年 第二季', year: '2024', publish_time: 1000 },
  { id: 'b', title: '庆余年', year: '2019', publish_time: 5000 },
  { id: 'c', title: '漫长的季节', year: '2023' },
  { id: 'd', title: '庆余年 第二季 高清', year: '2024', publish_time: 3000 },
];

describe('parsePublishTime', () => {
  it('兼容秒级与毫秒级时间戳', () => {
    expect(parsePublishTime(1710000000)).toBe(1710000000000);
    expect(parsePublishTime(1710000000000)).toBe(1710000000000);
    expect(parsePublishTime('1710000000')).toBe(1710000000000);
  });

  it('兼容采集站常见的日期字符串', () => {
    expect(parsePublishTime('2024-03-01 12:00:00')).toBeGreaterThan(0);
    expect(parsePublishTime('2024/03/01')).toBeGreaterThan(0);
  });

  it('纯年份与空值不算发布时间', () => {
    expect(parsePublishTime('2024')).toBeUndefined();
    expect(parsePublishTime('')).toBeUndefined();
    expect(parsePublishTime(null)).toBeUndefined();
  });
});

describe('sortVideos', () => {
  it('综合排序把标题完全匹配的排在前面', () => {
    const sorted = sortVideos(items, 'relevance', '庆余年');
    expect(sorted[0].id).toBe('b');
  });

  it('最近发布按 publish_time 降序，缺失的排最后', () => {
    const sorted = sortVideos(items, 'latest', '庆余年');
    expect(sorted.map((item) => item.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('年份排序把 unknown 放最后', () => {
    const sorted = sortVideos(
      [...items, { id: 'e', title: '未知', year: 'unknown' }],
      'year'
    );
    expect(sorted[sorted.length - 1].id).toBe('e');
  });

  it('名称排序可稳定复现', () => {
    const sorted = sortVideos(items, 'title');
    expect(sorted.map((item) => item.title)).toEqual(
      [...sorted.map((item) => item.title)].sort((a, b) =>
        a.localeCompare(b, 'zh-Hans-CN')
      )
    );
  });

  it('非法排序值退回综合', () => {
    expect(normalizeSortMode('oops')).toBe('relevance');
  });
});

describe('sortGroups', () => {
  it('聚合组按组内最新发布时间排序', () => {
    const groups: Array<[string, Array<SortableVideo & { id: string }>]> = [
      ['old', [items[0]]],
      ['new', [items[1], items[3]]],
    ];
    const sorted = sortGroups(groups, 'latest');
    expect(sorted.map(([key]) => key)).toEqual(['new', 'old']);
  });
});

describe('sortFavorites', () => {
  it('默认按添加时间倒序', () => {
    const sorted = sortFavorites(
      [
        { title: 'a', save_time: 100 },
        { title: 'b', save_time: 300 },
        { title: 'c', save_time: 200 },
      ],
      'recent'
    );
    expect(sorted.map((item) => item.title)).toEqual(['b', 'c', 'a']);
  });
});
