import type { z } from 'zod';
import { DailyArchiveSchema } from './protocol';
import type { DailyArchive, Snapshot } from './protocol';
import type {
  DailyReviewSchema,
  TimelineReadReplySchema,
} from './scening.generated';
import { capturedApplicationNames } from './presentation';

/** 固定生成触发时的全日统计；多标签各计一次，未知应用单列于原记录。 */
export function buildDailyArchive(
  review: z.infer<typeof DailyReviewSchema>,
  snapshot: Snapshot,
  tasks: z.infer<typeof TimelineReadReplySchema> | null,
  capturedAt = new Date().toISOString(),
): DailyArchive {
  if (review.day !== snapshot.day) throw new Error('回顾与统计日期不一致');
  const counts = new Map<string, number>();
  for (const activity of snapshot.activities) {
    const labels = [...new Set(activity.observation?.task_types ?? [])];
    for (const label of labels.length ? labels : ['待分类'])
      counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const validTasks =
    snapshot.source === 'local' &&
    tasks?.day === snapshot.day &&
    tasks.sourceRevision === snapshot.sourceRevision &&
    tasks.view?.day === snapshot.day;
  const ids = new Set(snapshot.activities.map((activity) => activity.id));
  const segments = validTasks
    ? tasks.view?.segments.filter((segment) =>
        segment.activityIds.some((id) => ids.has(id)),
      )
    : undefined;
  return DailyArchiveSchema.parse({
    source: snapshot.source,
    review,
    statistics: {
      capturedAt,
      activityCount: snapshot.activities.length,
      appCount: new Set(
        snapshot.activities
          .flatMap(capturedApplicationNames)
          .filter((name) => name !== '未知应用'),
      ).size,
      taskCount: segments
        ? new Set(
            segments.flatMap((segment) =>
              segment.taskId ? [segment.taskId] : [],
            ),
          ).size
        : null,
      pendingTasks:
        !segments ||
        tasks?.needsOrganization ||
        segments.some((segment) => segment.taskId === null),
      categories: [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      issues: snapshot.issues,
    },
  });
}

const accents = ['#c9963e', '#65758a', '#8b9367', '#a27d8f', '#a18c67'];
export const ARCHIVE_IMAGE_WIDTH = 1080;
/** 同一份组件用于阅读和静态图片，response以原字符串输出并保留所有换行。 */
export function ArchiveDocument({
  archive,
  titleId = 'daily-review-title',
}: {
  archive: DailyArchive;
  titleId?: string;
}) {
  const { review, statistics, source } = archive;
  const total = statistics.categories.reduce(
    (sum, item) => sum + item.count,
    0,
  );
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(
    new Date(`${review.day}T12:00:00`),
  );
  return (
    <article className="archive-document" data-archive-day={review.day}>
      <header className="archive-heading">
        <h2 id={titleId}>当日档案</h2>
        <p>
          {review.day.replaceAll('-', ' / ')} <span>·</span> {weekday}
        </p>
      </header>
      {source === 'demo' && <p className="archive-demo">【测试数据】</p>}
      <div className="archive-metrics" aria-label="当日档案统计">
        <span>
          <strong>{statistics.activityCount}</strong> 条活动记录
        </span>
        <span>
          <strong>{statistics.appCount}</strong> 个应用
        </span>
        <span>
          {statistics.taskCount === null ? (
            '关联任务待整理'
          ) : (
            <>
              <strong>{statistics.taskCount}</strong> 项关联任务
              {statistics.pendingTasks && ' · 部分待关联'}
            </>
          )}
        </span>
      </div>
      {total > 0 && (
        <div className="archive-categories">
          <div className="archive-category-bar" aria-hidden="true">
            {statistics.categories.map((category, index) => (
              <span
                key={category.name}
                style={{
                  flexGrow: category.count,
                  backgroundColor: accents[index % accents.length],
                }}
              />
            ))}
          </div>
          <ul aria-label="活动类型统计">
            {statistics.categories.map((category, index) => (
              <li key={category.name}>
                <i
                  style={{ backgroundColor: accents[index % accents.length] }}
                />
                <span>
                  {category.name} {category.count}次 ·{' '}
                  {Math.round((category.count / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
          <span className="archive-count-note">按分类次数 · 多选分别计入</span>
        </div>
      )}
      {statistics.issues.length > 0 && (
        <p className="archive-coverage">
          统计依据可读取的活动；{statistics.issues.length}{' '}
          项读取问题请在时间线查看。
        </p>
      )}
      <div className="review-prose">{review.response}</div>
      <footer className="archive-footnote">
        <p>
          {source === 'demo'
            ? '【测试数据】'
            : review.sourceActivityCount !== null
              ? `依据 ${review.sourceActivityCount ?? 0} 条已保存分析${review.sourceCount > 0 ? `和 ${review.sourceCount} 份周期总结` : ''}`
              : `依据 ${review.sourceCount} 份周期总结`}{' '}
          · 回顾生成于 {review.generatedAt.slice(0, 10)}{' '}
          {review.generatedAt.slice(11, 16)}
          <br />
          统计快照{' '}
          {new Date(statistics.capturedAt).toLocaleString('zh-CN', {
            hour12: false,
          })}
        </p>
        <span className="archive-stamp" aria-hidden="true">
          {review.day.replaceAll('-', '.')}
        </span>
      </footer>
    </article>
  );
}

/** 档案阅读与导出共用样式；单张长图高度随正文自然增长。 */
export const ARCHIVE_CSS = `
.archive-document{box-sizing:border-box;color:#3d3b32;background:#fffcf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:30px 34px 24px;border:1px solid #e5ddcc;border-radius:6px;overflow-wrap:anywhere;background-image:radial-gradient(ellipse at top left,#eedfbd25,transparent 70%)}
.archive-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 20px;margin:0 32px 13px 0}
.archive-heading h2{font-family:'Songti SC','STSong',serif;font-size:25px;line-height:1.4;letter-spacing:1px;font-weight:600;margin:0}
.archive-heading p{font-size:12px;line-height:1.6;color:#918977;margin:0}
.archive-heading p span{padding:0 7px}
.archive-metrics{display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12px;line-height:1.7;color:#756d5e}
.archive-metrics strong{font-weight:500;color:#3d3b32;font-variant-numeric:tabular-nums}
.archive-demo,.archive-coverage{font-size:12px;color:#8b6b38;line-height:1.6;margin:0 0 10px}
.archive-categories{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:12px 0 0}
.archive-category-bar{display:flex;overflow:hidden;border-radius:4px;width:100px;height:5px;flex-shrink:0}
.archive-category-bar span{flex-basis:0;min-width:1px}
.archive-categories ul{display:flex;flex-wrap:wrap;gap:5px 12px;list-style:none;padding:0;margin:0}
.archive-categories li{display:flex;align-items:center;gap:5px;font-size:10px;color:#918977}
.archive-categories i{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.archive-count-note{font-size:10px;color:#918977}
.archive-document .review-prose{border-top:1px solid #ded4bd;margin-top:18px;padding-top:20px;font-size:16px;line-height:1.95;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:400}
.archive-footnote{border-top:1px solid #ded4bd;margin-top:24px;padding-top:13px;display:flex;gap:12px;align-items:center;justify-content:space-between;color:#918977;font-size:10px;line-height:1.7}
.archive-footnote p{margin:0}
.archive-stamp{display:inline-block;color:#ad745c;border:1px solid #b9856f;padding:2px 7px;transform:rotate(-6deg);white-space:nowrap;font-size:10px}
.archive-image{box-sizing:border-box;margin:0;background:#f5eedc;padding:28px;width:${ARCHIVE_IMAGE_WIDTH}px}
.archive-image .archive-document{padding:38px 48px 30px;box-shadow:0 3px 14px #6d573315}
.archive-image .archive-heading h2{font-size:32px}
.archive-image .archive-heading p,.archive-image .archive-metrics{font-size:17px}
.archive-image .archive-categories{margin-top:16px}
.archive-image .archive-category-bar{height:7px;width:140px}
.archive-image .archive-categories li,.archive-image .archive-count-note{font-size:13px}
.archive-image .review-prose{font-size:24px;line-height:1.95;margin-top:22px;padding-top:26px}
.archive-image .archive-footnote{font-size:13px;margin-top:30px}
.archive-image .archive-stamp{font-size:13px}
@media(max-width:600px){.archive-document{padding:22px 22px 18px}.archive-heading{gap:6px 10px}.archive-heading h2{font-size:23px}.archive-document .review-prose{font-size:15px}.archive-footnote{align-items:flex-end}.archive-image .archive-document{padding:38px 48px 30px}}
`;
