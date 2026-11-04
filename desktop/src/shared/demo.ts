import { SnapshotSchema } from './protocol';
import type { Snapshot } from './protocol';

export const TEST_PREFIX = '【测试数据】';

/** 虚拟内容只在内存中生成，日期沿用当前选择；所有活动文本显式标记。 */
export function demoSnapshot(day: string): Snapshot {
  const rows = [
    [
      '09:05',
      '09:45',
      'VS Code',
      '梳理明镜客户端脱敏逻辑',
      '检查截图进入客户端后的隐私保护链路，梳理应用排除、敏感内容判别与安全保存的先后顺序。',
    ],
    [
      '10:00',
      '10:35',
      'Chrome',
      '细化 OCR 敏感内容判别',
      '结合虚构文字样例检查 OCR 识别结果，调整敏感规则与判别边界，整理普通内容和敏感内容的处理方式。',
    ],
    [
      '10:45',
      '11:10',
      '终端',
      '验证脱敏处理流程',
      '用合成截图核对隐私检查、图片保存与重试流程，检查敏感内容拦截和 OCR 识别异常时的处理。',
    ],
    [
      '11:20',
      '12:00',
      'VS Code',
      '梳理模型分析流程',
      '沿截图筛选、拼图分析、活动记录逐步检查数据流，核对隐私检查通过后的模型输入与分析结果展示。',
    ],
    [
      '13:05',
      '13:40',
      'Chrome',
      '梳理今日总结流程',
      '检查活动记录到周期总结、再到今日总结的衔接，核对日期归属、完整正文展示和档案图片保存。',
    ],
  ];
  const activities = rows.map((row, index) => {
    const [start, end, app, title, analysis] = row;
    return {
      id: `demo-${day}-${String(index)}`,
      start: `${day}T${start ?? '09:00'}:00+08:00`,
      end: `${day}T${end ?? '09:00'}:00+08:00`,
      app: app ?? '未知应用',
      bundleId: null,
      analysis: `${TEST_PREFIX}${analysis ?? ''}`,
      title: `${TEST_PREFIX}${title ?? ''}`,
      source: 'screen',
      screenshot: '',
      mini: '',
    };
  });
  return SnapshotSchema.parse({
    day,
    source: 'demo',
    sourceRevision: '',
    activities,
    summaries: [
      {
        windowStart: `${day}T09:00:00+08:00`,
        windowEnd: `${day}T13:40:00+08:00`,
        generatedAt: `${day}T13:45:00+08:00`,
        timeline: [],
        gaps: [],
        summary: `${TEST_PREFIX}今天持续调整明镜客户端的脱敏逻辑，细化 OCR 判别并用合成截图验证。\n随后梳理截图到模型分析、活动记录到今日总结的完整流程，核对正文展示与档案保存。`,
        trigger: 'periodic',
      },
    ],
    issues: [],
    locations: { configPath: '', home: '', screenshotDir: '' },
  });
}

/** 每日回顾演示只在内存生成，完整标明测试来源。 */
export function demoDailyReview(day: string) {
  return {
    status: 'ready' as const,
    review: {
      day,
      generatedAt: `${day}T13:45:00+08:00`,
      sourceCount: 1,
      sourceHash: '0'.repeat(64),
      response: `${TEST_PREFIX}今天，你一直在打磨明镜客户端的脱敏逻辑。从 OCR 判别，到模型分析，再到今日总结，一天的工作围绕同一个目标展开：让被记录的日常，始终带着清晰的隐私边界。

上午 09:05，你从截图的处理顺序开始梳理，逐步核对应用排除、敏感内容判别与安全保存。哪些画面可以进入后续分析，哪些内容需要在本地拦截，每一个入口都沿着实际流程重新走了一遍。

10:00 起，你把注意力放到 OCR 判别上，结合虚构文字样例查看识别结果，细化敏感规则和判别边界。随后在终端用合成截图验证处理流程，检查普通内容通过、敏感内容拦截，以及识别异常后的重试。反复核对这些细节，让隐私保护逐渐变成可检查的具体步骤。

午前，你继续梳理模型分析流程：截图经过筛选与隐私检查，再组成拼图交给模型，分析结果整理为活动记录，回到客户端时间线。你沿着数据流逐段核对输入、输出和展示，让每条活动都能对应到清楚的观察依据。

下午，你又把今日总结的流程串了起来。从活动记录到周期总结，再到当天的完整回顾，逐项检查日期归属、正文呈现与档案图片保存。散落在一天里的调试和思考，终于能够在同一份当日档案里连贯地被看见。

今天的进展，藏在一次次规则调整和流程核对里。你为明镜补上了更细致的隐私边界，也让记录、理解与回顾之间的衔接更清楚。收起这一页，给专注了一天的自己留一点休息时间。`,
    },
  };
}
