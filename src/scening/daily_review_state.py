"""每日总结的逐日状态、有限尝试和只读视图；Python独占正式提交。"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Literal, Optional
from uuid import uuid4
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from scening.daily_review_report import DailyReview, validate_review_day
from scening.observer_config import DailyReviewConfig

class DailyReviewDiagnostic(BaseModel):
    model_config=ConfigDict(extra='forbid')
    source: str
    occurredAt: AwareDatetime
    message: str = Field(min_length=1)
    details: str
    code: Optional[str]=None
    exitCode: Optional[int]=None
    signal: Optional[str]=None

class DailyReviewState(BaseModel):
    model_config=ConfigDict(extra='forbid')
    schemaVersion: Literal[1]=1
    day: str
    phase: Literal['scheduled','running','waiting_retry','succeeded','empty','failed']='scheduled'
    attemptId: Optional[str]=None
    trigger: Optional[Literal['automatic','manual']]=None
    startedAt: Optional[AwareDatetime]=None
    finishedAt: Optional[AwareDatetime]=None
    autoAttempts: int=Field(default=0,ge=0)
    autoExhausted: bool=False
    nextAttemptAt: Optional[AwareDatetime]=None
    lastError: Optional[DailyReviewDiagnostic]=None
    presentedOn: Optional[str]=None
    @model_validator(mode='after')
    def coherent(self):
        """状态边界保持真实日期和必要的调用/错误依据。"""
        validate_review_day(self.day)
        if self.presentedOn is not None:validate_review_day(self.presentedOn)
        if self.phase=='running' and not self.attemptId:raise ValueError('运行状态缺少调用身份')
        if self.phase=='waiting_retry' and self.nextAttemptAt is None:raise ValueError('等待重试缺少下次时间')
        if self.phase=='failed' and self.lastError is None:raise ValueError('失败状态缺少真实原因')
        return self

class DailyReviewView(DailyReviewState):
    homeId: str
    revision: str
    dueAt: AwareDatetime
    maxAutoAttempts: int
    report: Optional[DailyReview]=None
    canSummarize: bool
    needsRecovery: bool=False
    persistenceError: Optional[DailyReviewDiagnostic]=None

class DailyReviewCandidates(BaseModel):
    model_config=ConfigDict(extra='forbid')
    homeId: str
    days: list[str]
    nextCheckAt: Optional[AwareDatetime]=None
    policy: DailyReviewConfig

class DailyReviewPresented(BaseModel):
    model_config=ConfigDict(extra='forbid')
    day: str
    revision: str
    homeId: str

def _now(value=None): return value() if callable(value) else value or datetime.now().astimezone()
def home_id(config): return hashlib.sha256(str(config.home.resolve()).encode()).hexdigest()
def _folder(config): return config.home/'daily-review-status'
def _path(config,day):return _folder(config)/f'{validate_review_day(day)}.json'
def _load(config,day):
    p=_path(config,day)
    value=DailyReviewState.model_validate_json(p.read_text()) if p.exists() else DailyReviewState(day=day)
    if value.day!=day:raise ValueError('每日状态日期与文件不符')
    return value

def _atomic(path,value):
    """同目录完整写入、fsync后原子替换；错误保留原文件并清理临时文件。"""
    path.parent.mkdir(parents=True,exist_ok=True);temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,delete=False) as f:
            temporary=Path(f.name);f.write(value.model_dump_json(indent=2)+'\n');f.flush();os.fsync(f.fileno())
        os.replace(temporary,path)
    finally:
        if temporary is not None:temporary.unlink(missing_ok=True)

@contextmanager
def _lock(config,day,kind,blocking=False):
    folder=_folder(config);folder.mkdir(parents=True,exist_ok=True)
    with (folder/f'.{validate_review_day(day)}.{kind}.lock').open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX|(0 if blocking else fcntl.LOCK_NB))
        yield

def _save(config,state):
    with _lock(config,state.day,'state',True):
        current=_load(config,state.day)
        state=state.model_copy(update={'presentedOn':current.presentedOn or state.presentedOn})
        _atomic(_path(config,state.day),DailyReviewState.model_validate(state.model_dump()))
    return state

def _running(config,day):
    p=_folder(config)/f'.{day}.generate.lock'
    if not p.exists():return False
    with p.open('r') as f:
        try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return True
        return False

def _diagnostic(error,source,now):
    return DailyReviewDiagnostic(source=source,occurredAt=now,message=str(error) or type(error).__name__,details=getattr(error,'details',None) or str(error) or type(error).__name__,code=getattr(error,'code',None),exitCode=getattr(error,'exit_code',None),signal=getattr(error,'signal_name',None))

def due_at(config,day,now=None):
    """按本地日历下一天构造计划时刻，跨月跨年保持报告日含义。"""
    current=_now(now);target=date.fromisoformat(validate_review_day(day))+timedelta(days=1)
    naive=datetime.combine(target,time.fromisoformat(config.dailyReview.scheduledTime))
    if getattr(current.tzinfo,'key',None):return datetime.fromtimestamp(naive.replace(tzinfo=current.tzinfo).timestamp(),current.tzinfo)
    if current.utcoffset()==datetime.now().astimezone().utcoffset():return naive.astimezone()
    return naive.replace(tzinfo=current.tzinfo)

def _report(config,day):
    p=config.home/'daily-reviews'/f'{day}.json'
    if not p.exists():return None
    result=DailyReview.model_validate_json(p.read_text())
    if result.day!=day:raise ValueError('报告日期与文件不符')
    return result

def _generation_pair(config,day):
    """报告读取前后复核状态版本，返回同一稳定状态下的已提交正文。"""
    while True:
        before=_load(config,day)
        report=_report(config,day)
        after=_load(config,day)
        if before==after:return after,report

def inspect_day(config,day,*,now=None):
    """纯读取按日视图，零模型调用；真实读取错误保持完整并显示在同日。"""
    from scening.daily_review_input import build_day_input
    day=validate_review_day(day);current=_now(now);report=None;recovery=False;has_input=False
    state=DailyReviewState(day=day)
    try:
        state,report=_generation_pair(config,day)
        if state.phase=='running' and not _running(config,day):
            recovery=True
            if report and report.generationId==state.attemptId:state=state.model_copy(update={'phase':'succeeded','lastError':None,'nextAttemptAt':None})
            else:state=state.model_copy(update={'phase':'failed','lastError':_diagnostic(RuntimeError('上次每日总结进程已结束，本次报告尚未提交。'),'interrupted',current)})
        if state.phase=='scheduled' and report:state=state.model_copy(update={'phase':'succeeded'})
        data=build_day_input(config,day);has_input=bool(data['activities'] or data['periods'])
    except (OSError,ValueError) as error:
        state=state.model_copy(update={'phase':'failed','nextAttemptAt':None,'lastError':_diagnostic(error,'input',current)})
        try:
            if report is None:report=_report(config,day)
        except (OSError,ValueError):pass
        try:
            data=build_day_input(config,day);has_input=bool(data['activities'] or data['periods'])
        except (OSError,ValueError):pass
    due=due_at(config,day,current)
    data=state.model_dump(mode='json')
    revision=hashlib.sha256(json.dumps([data,report.model_dump(mode='json') if report else None],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return DailyReviewView(**state.model_dump(),homeId=home_id(config),revision=revision,dueAt=due,maxAutoAttempts=config.dailyReview.maxAutoAttempts,report=report,canSummarize=current.timestamp()>=due.timestamp() and date.fromisoformat(day)<current.date() and has_input and report is None,needsRecovery=recovery)

def list_due_days(config,*,now=None):
    """枚举有分析的已结束日期，昨日优先；只读候选，模型由显式生成操作负责。"""
    current=_now(now);yesterday=current.date()-timedelta(days=1);days={yesterday.isoformat()}
    for folder in ('records','summaries'):
        for p in (config.home/folder).glob('*.json'):
            try:
                candidate=date.fromisoformat(p.stem)
                if candidate<current.date():days.add(candidate.isoformat())
                if folder=='summaries' and candidate<=current.date():days.add((candidate-timedelta(days=1)).isoformat())
            except ValueError:continue
    eligible=[];next_check=None
    for day in sorted(days,reverse=True):
        view=inspect_day(config,day,now=current)
        if current.timestamp()<view.dueAt.timestamp() or view.report or view.autoExhausted:continue
        if view.phase=='failed' and not _path(config,day).exists():
            eligible.append(day);continue
        if view.needsRecovery or view.phase in ('waiting_retry','running') or (view.phase in ('scheduled','empty') and view.canSummarize):
            if view.phase=='waiting_retry' and view.nextAttemptAt.timestamp()>current.timestamp():
                if next_check is None or view.nextAttemptAt.timestamp()<next_check.timestamp():next_check=view.nextAttemptAt
                continue
            eligible.append(day)
    return DailyReviewCandidates(homeId=home_id(config),days=eligible,nextCheckAt=next_check,policy=config.dailyReview)

def generate_day(config,day,*,trigger='manual',interpreter=None,now=None,raise_errors=False,expected_home_id=None):
    """锁定一个报告日，持久计数后独立生成；失败完整保存，自动预算跨重启保留。

    manual每次一次；automatic核对自然日、时间与剩余预算。报告先提交再写成功状态；
    若报告已提交后中断，按generationId恢复。异常可由旧公开入口选择继续上抛。
    """
    from scening.daily_review_input import build_day_input
    from scening.daily_review_report import generate_report
    current=_now(now);day=validate_review_day(day)
    if expected_home_id and expected_home_id!=home_id(config):raise ValueError('每日总结来源已变化，请重新读取当前设置。')
    try:
        with _lock(config,day,'generate'):
            state=_load(config,day);view=inspect_day(config,day,now=current)
            if state.phase=='running':
                if view.report and view.report.generationId==state.attemptId:
                    _save(config,state.model_copy(update={'phase':'succeeded','lastError':None,'nextAttemptAt':None,'finishedAt':current}))
                    return inspect_day(config,day,now=current)
                if trigger=='automatic':
                    remaining=state.trigger=='automatic' and state.autoAttempts<config.dailyReview.maxAutoAttempts
                    _save(config,state.model_copy(update={'phase':'waiting_retry' if remaining else 'failed','lastError':view.lastError or _diagnostic(RuntimeError('上次每日总结进程已结束，本次报告尚未提交。'),'interrupted',current),'nextAttemptAt':datetime.fromtimestamp(current.timestamp()+config.dailyReview.retryIntervalSeconds,current.tzinfo) if remaining else None,'autoExhausted':not remaining}))
                    return inspect_day(config,day,now=current)
            if trigger=='automatic' and view.phase=='failed' and view.report is None and (config.home/'daily-reviews'/f'{day}.json').exists():
                _save(config,state.model_copy(update={'phase':'failed','lastError':view.lastError,'autoExhausted':True,'nextAttemptAt':None}))
                return inspect_day(config,day,now=current)
            if trigger=='automatic':
                if current.timestamp()<view.dueAt.timestamp() or date.fromisoformat(day)>=current.date() or view.report or state.autoExhausted or state.phase in ('failed','succeeded'):return view
                if state.nextAttemptAt and current.timestamp()<state.nextAttemptAt.timestamp():return view
            try:
                inputs=build_day_input(config,day)
                if not inputs['activities'] and not inputs['periods']:
                    _save(config,state.model_copy(update={'phase':'empty','nextAttemptAt':None,'lastError':None}))
                    return inspect_day(config,day,now=current)
                state=state.model_copy(update={'phase':'running','attemptId':str(uuid4()),'trigger':trigger,'startedAt':current,'finishedAt':None,'nextAttemptAt':None,'autoAttempts':state.autoAttempts+(trigger=='automatic')})
                _save(config,state)
                result=generate_report(config,day,interpreter=interpreter,generation_id=state.attemptId,inputs=inputs)
                _save(config,state.model_copy(update={'phase':'succeeded','lastError':None,'nextAttemptAt':None,'finishedAt':_now(now)}))
            except Exception as error:
                finished=_now(now)
                retry=trigger=='automatic' and state.phase=='running' and state.autoAttempts<config.dailyReview.maxAutoAttempts and not isinstance(error,OSError)
                state=state.model_copy(update={'phase':'waiting_retry' if retry else 'failed','lastError':_diagnostic(error,'storage' if isinstance(error,OSError) else 'model' if state.phase=='running' else 'input',finished),'finishedAt':finished,'nextAttemptAt':datetime.fromtimestamp(finished.timestamp()+config.dailyReview.retryIntervalSeconds,finished.tzinfo) if retry else None,'autoExhausted':trigger=='automatic' and not retry})
                try:_save(config,state)
                except (OSError,ValueError) as save_error:
                    view=inspect_day(config,day,now=finished)
                    view=view.model_copy(update={'phase':'failed','lastError':state.lastError,'persistenceError':_diagnostic(save_error,'storage',finished)})
                    if raise_errors:raise error
                    return view
                if raise_errors:raise
            return inspect_day(config,day,now=_now(now))
    except BlockingIOError:
        if raise_errors:raise RuntimeError('每日总结正在生成，请稍后打开')
        return inspect_day(config,day,now=current)

def mark_presented(config,day,*,now=None,revision=None):
    """实际显示成功报告后保存阅读日；来源、日期和版本不符时保留原标记。"""
    current=_now(now);view=inspect_day(config,day,now=current)
    if view.report is None or view.phase!='succeeded' or date.fromisoformat(day)!=current.date()-timedelta(days=1) or (revision and revision!=view.revision):return view
    with _lock(config,day,'state',True):
        state=_load(config,day)
        if state.phase=='scheduled':state=state.model_copy(update={'phase':'succeeded'})
        _atomic(_path(config,day),state.model_copy(update={'presentedOn':current.date().isoformat()}))
    return inspect_day(config,day,now=current)
