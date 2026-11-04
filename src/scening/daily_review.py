"""每日回顾查询入口与CLI，调用逐日状态核心和公开报告协议。"""
import argparse
from contextlib import redirect_stdout
from pathlib import Path
import sys
from scening.observer_config import load_config
from scening.kmh_interpreter import KMHInterpreter
from scening.runtime_logging import log_event
from scening.daily_review_report import (
    DailyReview, DailyReviewReady, DailyReviewEmpty, DailyReviewError,
    DailyReviewReply, validate_review_day, generate_report,
)


def review_day(config, day, *, refresh=False, cached_only=False, interpreter=None):
    """公开每日查询；缓存只读，显式生成复用逐日状态，失败保留报告并上抛。"""
    from scening.daily_review_state import generate_day
    day=validate_review_day(day)
    target=config.home/'daily-reviews'/f'{day}.json'
    if target.exists() and not refresh:
        review=DailyReview.model_validate_json(target.read_text())
        if review.day!=day:raise ValueError('回顾日期与日文件不符')
        return DailyReviewReady(review=review)
    if cached_only:return DailyReviewEmpty(message='这一天还没有每日总结。点击「生成总结」可汇总已保存分析。')
    view=generate_day(config,day,interpreter=interpreter,raise_errors=True)
    if view.report:return DailyReviewReady(review=view.report.model_dump())
    return DailyReviewEmpty(message='当日无记录。已保存分析可用后，可点击生成总结。')


def main():
    """独立CLI：只向stdout写协议JSON，诊断写项目日志；失败回复保留旧回顾。"""
    parser = argparse.ArgumentParser(description='汇总当天周期总结，生成温馨每日回顾')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--day')
    parser.add_argument('--action', choices=['inspect','candidates','generate','presented'])
    parser.add_argument('--trigger', choices=['automatic','manual'], default='manual')
    parser.add_argument('--expected-home-id')
    parser.add_argument('--revision')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--cached-only', action='store_true')
    args = parser.parse_args()
    try:
        with redirect_stdout(sys.stderr):
            config=load_config(args.config)
            import signal
            model=KMHInterpreter(config.home,config=config,full_diagnostics=True)
            signal.signal(signal.SIGTERM,lambda *_: model.cancelled.set())
            signal.signal(signal.SIGINT,lambda *_: model.cancelled.set())
            if args.action:
                from scening.daily_review_state import inspect_day,list_due_days,generate_day,mark_presented
                if args.action=='candidates':result=list_due_days(config)
                elif args.action=='inspect':result=inspect_day(config,args.day)
                elif args.action=='presented':
                    from scening.daily_review_state import home_id
                    if args.expected_home_id!=home_id(config):raise ValueError('每日总结来源已变化')
                    result=mark_presented(config,args.day,revision=args.revision)
                else:result=generate_day(config,args.day,trigger=args.trigger,expected_home_id=args.expected_home_id,interpreter=model)
            else:result = review_day(config, args.day, refresh=args.refresh, cached_only=args.cached_only,interpreter=model)
    except Exception as error:
        # 真实原因首行随日志落盘；回复正文已完整携带异常消息供界面显示。
        entry = {'stage': 'daily_review', 'result': 'failed', 'day': args.day, 'errorType': type(error).__name__,
                 'detail': (str(error).splitlines()[0][:300] if str(error) else '')}
        with redirect_stdout(sys.stderr):
            log_event(entry)
        # 配置和输入诊断保留本地定位；模型层已清理stderr凭据和授权链接。
        result = DailyReviewError(message=f'每日总结生成失败：{error}')
    print(result.model_dump_json() if args.action else DailyReviewReply(root=result).model_dump_json())


if __name__ == '__main__':
    main()
