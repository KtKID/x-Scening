import type { EditableConfig } from './protocol';

/** 页面名称与分组；值及其约束分别来自 YAML 和生成契约。 */
export const settingGroups = [
  {
    title: '每日总结',
    description: '按本地时间为已结束的日期生成总结；保存后立即重新安排。',
    fields: [
      [
        'dailyReview.scheduledTime',
        '自动生成时间',
        '24小时制，为前一天生成，默认凌晨03:00。',
      ],
      [
        'dailyReview.maxAutoAttempts',
        '每日自动尝试总数',
        '正整数，包含首次，已消耗次数跨重启保留。',
      ],
      [
        'dailyReview.retryIntervalSeconds',
        '每日重试间隔（秒）',
        '失败结束后等待，手动重试单次执行。',
      ],
      [
        'dailyReview.checkIntervalSeconds',
        '每日调度检查间隔（秒）',
        '启动、恢复和设置保存也立即检查。',
      ],
    ],
  },
  {
    title: '截图隐私',
    description: '沿用现有本地敏感判定配置；列表每行填写一项。',
    fields: [
      [
        'privacy.enabled',
        '启用隐私闸门',
        '正式发布与补分析前执行现有敏感判定。',
      ],
      ['privacy.sensitiveApps', '敏感应用列表', '每行一个应用名称。'],
      ['privacy.appKeywords', '应用关键词列表', '每行一个现有规则关键词。'],
      ['privacy.ocrEnabled', '启用文字敏感识别', '使用现有本地OCR规则。'],
      ['privacy.longTokenMin', '长令牌最小长度', '至少6个字符。'],
      ['privacy.splitTokenMin', '拆分令牌最小长度', '至少6个字符。'],
      ['privacy.splitJoinedMin', '拼接令牌最小长度', '至少12个字符。'],
      ['privacy.cardCheck', '银行卡号规则', '沿用现有银行卡判定。'],
      ['privacy.idCheck', '身份证号规则', '沿用现有身份号判定。'],
      ['privacy.labelCheck', '标签规则', '保存现有规则选择。'],
    ],
  },
  {
    title: '分析与截图频率',
    description:
      '截图先进入候选队列，凑齐一批后分析；实际分析次数随画面变化和模型处理速度调整。',
    fields: [
      [
        'scening.observationIntervalSeconds',
        '定时截图间隔（秒）',
        '定时选取一张候选截图，启动时先观察首帧。',
      ],
      [
        'scening.captureFps',
        '截图缓存频率（帧/秒）',
        '每秒刷新各屏幕缓存的次数，保存的截图从缓存中选取。',
      ],
      [
        'scening.highResolutionFps',
        '高分辨率缓存频率（帧/秒）',
        '屏幕宽度或高度超过下方分辨率条件时使用。',
      ],
      [
        'sampleIntervalSeconds',
        '分析候选处理间隔（秒）',
        '两次开始处理候选截图的最短间隔；满批且达到变化阈值后调用分析。',
      ],
      [
        'analysis.batchSize',
        '每次分析截图数（张）',
        '每批收集2至3张截图，当前默认3张。',
      ],
      [
        'scening.actionIntervalSeconds',
        '操作选图间隔（秒）',
        '整理已完成键鼠操作并选择截图的周期。',
      ],
      [
        'summaryIntervalSeconds',
        '活动总结周期（秒）',
        '1800秒为30分钟，按本次启动时间计时。',
      ],
      [
        'desktop.refreshIntervalSeconds',
        '页面自动刷新间隔（秒）',
        '自动读取采集状态和本地活动记录的周期。',
      ],
    ],
  },
  {
    title: '分析与总结',
    description: '调整画面变化判断、文字篇幅与每次采集的运行轮数。',
    fields: [
      [
        'differenceThreshold',
        '画面变化阈值',
        '大于0、至多1；达到阈值重新分析，调大可减少调用。',
      ],
      ['captureCount', '采集轮数上限', '非负整数，0表示持续运行。'],
      [
        'analysis.retryIntervalSeconds',
        '批次重试间隔（秒）',
        '现有截图分析的重试等待基数。',
      ],
      ['analysis.maxRetries', '批次重试次数', '现有截图分析自动重试上限。'],
      [
        'analysisMaxChars',
        '活动分析字数',
        '正整数，向模型提出的最大中文字数要求。',
      ],
      [
        'summaryMaxChars',
        '活动总结字数',
        '正整数，向模型提出的最大中文字数要求。',
      ],
      [
        'dailyReview.maxChars',
        '每日回顾字数',
        '正整数，下次生成每日回顾时读取，完整回复按原文保存。',
      ],
    ],
  },
  {
    title: '存储与高级设置',
    description:
      '相对路径以当前配置文件所在目录为基准；桌面分析使用内置 KMH scening。',
    fields: [
      ['home', '活动与总结目录', '保存每日记录、总结与 KMH 运行数据。'],
      ['screenshotDir', '截图保存目录', '保存原始 JPEG 与分析拼图。'],
      [
        'kmhLauncher',
        'KMH 启动脚本',
        '命令行及其他 profile 使用的外部启动脚本。',
      ],
      [
        'kmhProfile',
        'KMH profile 名称',
        '桌面默认 scening，模型与密钥在上方配置；其他 profile 使用外部入口。',
      ],
    ],
  },
  {
    title: '分析拼图',
    description: '拼图面积须在像素预算内，标签高度须能容纳字号。',
    fields: [
      [
        'analysis.frameMaxWidth',
        '每帧最大宽度（像素）',
        '正整数，等比缩放，小图保持原尺寸。',
      ],
      [
        'analysis.frameMaxHeight',
        '每帧最大高度（像素）',
        '正整数，同时约束竖屏截图。',
      ],
      [
        'analysis.labelHeight',
        '时间标签高度（像素）',
        '正整数，至少等于标签字号。',
      ],
      [
        'analysis.labelFontSize',
        '时间标签字号（像素）',
        '正整数，用于时间、间隔和屏幕标签。',
      ],
      ['analysis.jpegQuality', '拼图 JPEG 品质', '1至95的整数。'],
      [
        'analysis.maxImagePixels',
        '拼图像素上限',
        '正整数，最大宽度 ×（最大高度 + 标签高度）× 每批张数须在预算内。',
      ],
    ],
  },
  {
    title: '屏幕与截图策略',
    description: '配置屏幕识别、空闲暂停、截图品质与候选队列。',
    fields: [
      [
        'scening.highResolutionWidth',
        '高分辨率宽度条件（像素）',
        '正整数，屏幕宽度严格大于此值时降低缓存频率。',
      ],
      [
        'scening.highResolutionHeight',
        '高分辨率高度条件（像素）',
        '正整数，屏幕高度严格大于此值时降低缓存频率。',
      ],
      [
        'scening.monitorRefreshSeconds',
        '屏幕布局检查间隔（秒）',
        '正数，重新检查连接的显示器。',
      ],
      [
        'scening.sensingIdleSeconds',
        '系统空闲暂停时间（秒）',
        '正数，无输入活动达到此时间后暂停抓屏。',
      ],
      [
        'scening.recentActivityMultiplier',
        '近期活动窗口倍数',
        '正数，定时观察周期乘以此值。',
      ],
      [
        'scening.recentActivityPaddingSeconds',
        '近期活动窗口补充（秒）',
        '非负数，活动窗口至少为观察周期加此时间。',
      ],
      [
        'scening.jpegQuality',
        '原始截图 JPEG 品质',
        '1至95的整数，截图保持原采集分辨率。',
      ],
      [
        'scening.candidateQueueSize',
        '候选截图队列上限',
        '正整数，过载时保留较新候选并记录中断。',
      ],
      [
        'scening.maxStoredActions',
        '操作与输入队列上限',
        '大于1的整数，限制内存中待处理操作。',
      ],
    ],
  },
  {
    title: '键鼠与画面选取',
    description: '调整点击、输入、滚动后的截图时机和稳定画面判断。',
    fields: [
      [
        'scening.clickDebounceSeconds',
        '点击结束等待（秒）',
        '正数，最后一次点击后等待截图的时间。',
      ],
      [
        'scening.keyboardIdleSeconds',
        '键盘输入静默等待（秒）',
        '正数，连续输入结束后的等待时间。',
      ],
      [
        'scening.scrollDebounceSeconds',
        '滚动事件最短间隔（秒）',
        '正数，连续滚动记录的最短间隔。',
      ],
      [
        'scening.scrollMinPointerDistance',
        '滚动指针最小位移（像素）',
        '非负数，较近的滚动事件需达到此位移。',
      ],
      [
        'scening.scrollMaxEventsPerSecond',
        '滚动记录每秒上限',
        '正数，连续滚动记录的平均每秒数量上限。',
      ],
      [
        'scening.scrollResetSeconds',
        '滚动会话重置时间（秒）',
        '正数，从首次滚动事件开始计时。',
      ],
      [
        'scening.scrollAfterSeconds',
        '滚动结束等待（秒）',
        '非负数，0表示随后采集轮立即完成，继续滚动会重新计时。',
      ],
      [
        'scening.minRawEvents',
        '操作选图最少事件数',
        '正整数，新增键鼠事件达到此数量后参与操作选图。',
      ],
      [
        'scening.segmentDifferenceThreshold',
        '画面分段差异阈值',
        '正数，比较上一操作结束图与下一操作开始图的 RGB 平方差。',
      ],
      [
        'scening.stableComparisonCount',
        '稳定画面比较次数',
        '正整数，连续低差异达到此次数后标记稳定片段。',
      ],
      [
        'scening.missingImageDifference',
        '缺图替代差异分数',
        '正数，建议高于画面分段差异阈值，使未知衔接形成分段。',
      ],
    ],
  },
  {
    title: '超时与进程控制',
    description: '高级参数，调整候选等待、模型等待及停止收尾的时间预算。',
    fields: [
      [
        'captureTimeoutSeconds',
        '首张候选等待上限（秒）',
        '正数，实时入口等待首份有效候选的超时。',
      ],
      [
        'modelTimeoutSeconds',
        '模型调用等待上限（秒）',
        '正数，每次图片分析或总结的最长等待时间。',
      ],
      [
        'terminationGraceSeconds',
        '模型进程退出等待（秒）',
        '正数，模型超时终止后等待退出的时间。',
      ],
      [
        'control.timeoutSeconds',
        '控制请求总预算（秒）',
        '正数，一次控制请求等待完成回执的总时间。',
      ],
      [
        'control.cancelGraceSeconds',
        '主动取消宽限（秒）',
        '正数，取消后给 KMH 启动器转发信号的时间。',
      ],
      [
        'control.pollSeconds',
        '控制状态检查间隔（秒）',
        '正数，检查取消事件、控制监听及进程回收的间隔。',
      ],
      [
        'scening.shutdownTimeoutSeconds',
        '采集线程退出等待（秒）',
        '正数，同时受控制请求总预算约束。',
      ],
    ],
  },
  {
    title: '任务时间线',
    description: '任务整理频率与时间估算依据。',
    fields: [
      ['taskTimeline.minOrganizeIntervalSeconds', '整理最短间隔', '秒'],
      ['taskTimeline.maxActivitiesPerBatch', '每批活动上限', '条'],
      ['taskTimeline.maxInputChars', '输入文字上限', '字符'],
      ['taskTimeline.retryIntervalSeconds', '失败重试间隔', '秒'],
      ['taskTimeline.maxAttemptsPerRevision', '同批尝试上限', '次'],
      ['taskTimeline.maxContinuityGapSeconds', '连续采样最大间隔', '秒'],
    ],
  },
] satisfies {
  title: string;
  description: string;
  fields: [string, string, string][];
}[];

export const settingFields = settingGroups.flatMap((group) => group.fields);

/** 已校验快照转为可编辑文字，保留清空数字等中间输入。 */
export function settingsDraft(config: EditableConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) => {
      if (key === 'taskTypes') return [];
      if (value !== null && typeof value === 'object')
        return Object.entries(value).map(([child, entry]) => [
          `${key}.${child}`,
          Array.isArray(entry) ? entry.join('\n') : String(entry),
        ]);
      return [[key, String(value)]];
    }),
  );
}

/** 按快照中的叶字段类型还原数值、时间、布尔和列表；完整边界校验由生成契约和 Python 承担。 */
export function settingsValue(
  config: EditableConfig,
  draft: Record<string, string>,
  taskTypes: string[],
): unknown {
  const numeric = (key: string): number =>
    draft[key]?.trim() ? Number(draft[key]) : Number.NaN;
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (key === 'taskTypes') return [key, taskTypes];
      if (value !== null && typeof value === 'object')
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([child, entry]) => [
              child,
              typeof entry === 'number'
                ? numeric(`${key}.${child}`)
                : typeof entry === 'string'
                  ? (draft[`${key}.${child}`] ?? '')
                  : typeof entry === 'boolean'
                    ? draft[`${key}.${child}`] === 'true'
                    : Array.isArray(entry)
                      ? (draft[`${key}.${child}`] ?? '')
                          .split(/\r?\n/)
                          .map((line) => line.trim())
                          .filter(Boolean)
                      : entry,
            ]),
          ),
        ];
      return [
        key,
        value === null
          ? null
          : typeof value === 'number'
            ? numeric(key)
            : (draft[key] ?? ''),
      ];
    }),
  );
}

export function settingLabel(key: string): string {
  return key === 'taskTypes'
    ? '任务类型'
    : (settingFields.find(([field]) => field === key)?.[1] ?? key);
}
