"""活动与总结的结构定义、每日JSON校验和原子保存。"""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
from typing import List, Literal, Optional
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, ValidationInfo, field_validator, model_validator
from scening.observation_generated import ObservationResult

def observation_text(result: ObservationResult):
    """将专用工具结果投影为现有卡片正文；完整对象与正文由Memory同次保存。"""
    return (f'可见事实：{result.visible_activity}\n推测：{result.inferred_intent}'
            f'\n观察到的变化：{result.stage_and_evidence}')


def captured_app_names(record):
    """从已校验活动取得系统应用名称，逐帧优先并按出现顺序去重。

    record来自ActivityEvent或Memory.window校验后的JSON对象；frames存在时以逐帧采集为准，
    旧单图记录沿用app。缺失或空白身份显示未知应用；模型observation.app_tags保持原始保存。
    返回非空名称列表，仅用于应用展示/统计/总结投影，原活动与图片保持原值。
    """
    frames = record.get('frames')
    values = [frame.get('app') for frame in frames] if frames else [record.get('app')]
    return list(dict.fromkeys(value.strip() if value and value.strip() else '未知应用' for value in values))

def validate_image_reference(value, info):
    """统一校验顶层与逐帧图片引用；绝对路径由Memory上下文显式允许。"""
    path=PurePosixPath(value)
    absolute_allowed=(info.context or {}).get('allow_absolute_images', False)
    if (path.is_absolute() and not absolute_allowed) or '..' in path.parts or not value.strip():
        raise ValueError('图片路径应为允许的相对或绝对引用，且保持在指定目录内')
    return value


class ActivityFrame(BaseModel):
    """一份批分析证据；图片、采集时间、应用和屏幕均由采集端确定。"""
    model_config = ConfigDict(extra='forbid')
    capturedAt: AwareDatetime
    screenshot: str
    app: Optional[str] = None
    bundleId: Optional[str] = None
    screen: Optional[int] = Field(default=None, strict=True, gt=0)

    @field_validator('screenshot')
    @classmethod
    def relative_image(cls, value, info: ValidationInfo):
        """逐帧引用使用与活动图片相同的路径边界。"""
        return validate_image_reference(value, info)


class ActivityEvent(BaseModel):
    """活动的唯一结构；时间和文件来自采集，analysis来自模型。"""
    model_config = ConfigDict(extra='allow')
    start: AwareDatetime
    end: AwareDatetime
    app: Optional[str] = None
    bundleId: Optional[str] = None
    analysis: str = Field(min_length=1)
    observation: Optional[ObservationResult] = None
    source: Literal['screen'] = 'screen'
    screenshot: str
    mini: str
    frames: Optional[List[ActivityFrame]] = Field(default=None, min_length=1)

    @field_validator('analysis')
    @classmethod
    def nonempty_analysis(cls, value):
        """拒绝纯空白正文，保留有效模型原文。"""
        if not value.strip():
            raise ValueError('analysis为空')
        return value

    @field_validator('screenshot', 'mini')
    @classmethod
    def relative_image(cls, value, info: ValidationInfo):
        """校验图片引用语法；独立截图目录由Memory显式上下文允许绝对引用。

        普通调用继续使用home内相对路径；所有路径均拒绝空值及..穿越。
        新绝对引用的实际写入根由ActivityMemory.image_reference统一核对。
        """
        return validate_image_reference(value, info)

    @model_validator(mode='after')
    def valid_interval(self):
        """活动起止有序且处于截图同一天。"""
        if self.end < self.start or self.end.date()!=self.start.date():
            raise ValueError('活动区间应有序且属于同一天')
        return self

class SummaryActivity(BaseModel):
    """周期总结的文字时间表；旧活动证据字段在读取时兼容忽略。"""
    model_config = ConfigDict(extra='ignore')
    start: AwareDatetime
    end: AwareDatetime
    app: Optional[str] = None
    analysis: str = Field(min_length=1)

    @field_validator('analysis')
    @classmethod
    def nonempty_analysis(cls, value):
        """沿用活动正文约束，保留每次已保存分析的完整文字。"""
        return ActivityEvent.nonempty_analysis(value)

    @model_validator(mode='after')
    def valid_interval(self):
        """总结时间表保持每条活动的有序同日区间。"""
        if self.end < self.start or self.end.date() != self.start.date():
            raise ValueError('总结活动区间应有序且属于同一天')
        return self


class CoverageGap(BaseModel):
    """已知失败区间，仅表达实际观察覆盖缺口。"""
    start: AwareDatetime
    end: AwareDatetime
    reason: str

class ActivitySummary(BaseModel):
    """一个总结窗口的持久化结构，区分周期和提前试跑。"""
    model_config=ConfigDict(extra='allow')
    windowStart: AwareDatetime
    windowEnd: AwareDatetime
    generatedAt: AwareDatetime
    timeline: List[SummaryActivity]
    gaps: List[CoverageGap]
    summary: str = Field(min_length=1)
    trigger: Literal['periodic','manual_exit']='periodic'

    @model_validator(mode='after')
    def valid_window(self):
        """窗口必须有正长度且总结正文有效。"""
        if self.windowEnd<=self.windowStart or not self.summary.strip():
            raise ValueError('总结窗口或正文无效')
        return self

EVENT_LIST=TypeAdapter(List[ActivityEvent])
SUMMARY_LIST=TypeAdapter(List[ActivitySummary])

class ActivityMemory:
    """持有home并独占JSON提交入口，保留已存在对象的扩展字段。"""
    def __init__(self, home, *, screenshot_dir=None):
        """解析记录与截图目录；显式独立目录允许读取历史绝对图片引用。

        参数home为活动根，screenshot_dir为当前允许新增图片引用的根。
        目录在实际保存时创建；构造仅保存路径和Pydantic校验上下文。
        """
        self.home=Path(home).resolve()
        self.screenshot_dir=Path(screenshot_dir).resolve() if screenshot_dir is not None else None
        self.validation_context={'allow_absolute_images': self.screenshot_dir is not None}

    def image_reference(self, path):
        """生成唯一图片引用；home内返回相对路径，独立截图根内返回绝对路径。

        参数为已保存图片的路径；解析符号链接后核对当前允许的根。
        越界抛ValueError；返回字符串，图片和JSON文件保持只读。
        历史引用在读取时保留原值，截图目录切换后仍能读取旧记录。
        """
        resolved=Path(path).resolve()
        if resolved.is_relative_to(self.home):
            return str(resolved.relative_to(self.home))
        if self.screenshot_dir is not None and resolved.is_relative_to(self.screenshot_dir):
            return str(resolved)
        raise ValueError('图片路径超出home或配置截图目录：'+str(resolved))

    def _read(self, path, adapter):
        """读取列表并验证结构，返回保留扩展字段的原始对象。

        仅文件缺失时返回空列表；已有文件的读取、JSON和结构错误直接传播。
        活动文件另核对截图日期与文件名，调用者据此决定追加或结束本次写入。
        """
        if not path.exists():
            return []
        data=json.loads(path.read_text(encoding='utf-8'))
        adapter.validate_python(data, context=self.validation_context)
        if adapter is EVENT_LIST:
            for item in data:
                if datetime.fromisoformat(item['start']).date().isoformat()!=path.stem:
                    raise ValueError('记录日期与文件名不符')
        return data

    def _write(self, path, data):
        """完整编码到同目录临时文件，关闭后原子替换目标。

        参数为目标路径及已校验列表；编码或替换失败时已有目标保持原值。
        成功后返回None，最终清理临时名称，调用者在提交成功后更新内存基准。
        """
        path.parent.mkdir(parents=True,exist_ok=True)
        temporary=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,suffix='.tmp',delete=False) as stream:
                temporary=Path(stream.name)
                json.dump(data,stream,ensure_ascii=False,indent=2,allow_nan=False)
                stream.write('\n')
            os.replace(temporary,path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def append(self, record):
        """按截图日期追加一条活动，成功后返回提交的原始对象。

        先用ActivityEvent验证边界，再读取并验证当日旧列表；扩展字段和值保留。
        异常传播给调度器，旧文件保持；时间和图片引用由调用方采集信息构造。
        """
        item=ActivityEvent.model_validate(record, context=self.validation_context)
        # 新增引用必须属于当前允许根；历史已保存绝对引用保持可读。
        references=[item.screenshot, item.mini]
        references.extend(frame.screenshot for frame in item.frames or [])
        for reference in references:
            if Path(reference).is_absolute():
                self.image_reference(reference)
        path=self.home/'records'/f'{item.start.date().isoformat()}.json'
        data=self._read(path,EVENT_LIST)
        data.append(dict(record))
        self._write(path,data)
        return dict(record)

    def tail_matches(self, anchor):
        """核对最近记录仍为本入口的成功基准；其他协调作业追加后改走新分析。"""
        day=datetime.fromisoformat(anchor['start']).date()
        data=self._read(self.home/'records'/f'{day.isoformat()}.json',EVENT_LIST)
        return bool(data) and all(data[-1].get(key)==anchor.get(key) for key in ('start','screenshot','app','bundleId'))

    def extend(self, anchor, end):
        """核对末条身份后只更新end，保持条数、原文、图片和扩展字段。

        anchor取最近成功追加的活动，end取本次截图时间；跨日和倒退直接失败。
        仅末条start与screenshot匹配时允许提交，防止更新被其他记录替换的活动。
        读取、校验及提交异常由调度器记录，并清除可合并基准。
        """
        day=datetime.fromisoformat(anchor['start']).date()
        path=self.home/'records'/f'{day.isoformat()}.json'
        data=self._read(path,EVENT_LIST)
        if not data or any(data[-1].get(key)!=anchor.get(key) for key in ('start','screenshot','app','bundleId')):
            raise ValueError('末条活动与当前合并基准不符')
        previous_end=datetime.fromisoformat(data[-1]['end'])
        data[-1]['end']=end.isoformat(timespec='seconds')
        ActivityEvent.model_validate(data[-1], context=self.validation_context)
        if end<previous_end:
            raise ValueError('end应保持时间顺序')
        self._write(path,data)

    def window(self, start, end):
        """读取半开时间窗内活动，返回裁剪副本及真实读取失败缺口。

        跨日逐文件读取，保存文件保持原值；单点活动按start落入窗口判断。
        某日无法读取时记录该日窗口内缺口，其他日期的有效记录继续供总结使用。
        """
        timeline=[]
        gaps=[]
        day=start.date()
        while day<=end.date():
            path=self.home/'records'/f'{day.isoformat()}.json'
            try:
                rows=self._read(path,EVENT_LIST)
            except (OSError,ValueError) as error:
                left=max(start,datetime.combine(day,datetime.min.time(),tzinfo=start.tzinfo))
                right=min(end,left.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1))
                if right>left:
                    gaps.append({'start':left.isoformat(timespec='seconds'),'end':right.isoformat(timespec='seconds'),'reason':'活动文件读取失败：'+path.name})
                rows=[]
            for row in rows:
                left=datetime.fromisoformat(row['start'])
                right=datetime.fromisoformat(row['end'])
                include=(start<=left<end) if left==right else (left<end and right>start)
                if include:
                    copy=dict(row)
                    copy['start']=max(start,left).isoformat(timespec='seconds')
                    copy['end']=min(end,right).isoformat(timespec='seconds')
                    timeline.append(copy)
            day+=timedelta(days=1)
        return sorted(timeline,key=lambda item:item['start']),gaps

    def save_summary(self, summary):
        """按窗口结束日追加总结，返回实际提交的文件路径。

        summary先通过唯一结构校验，再读取旧列表并追加；窗口日期由程序提供。
        新时间表按SummaryActivity保存四项文字字段，旧列表内容保持原值。
        原子提交失败直接传播，已有活动与历史总结保持原值。
        """
        value=ActivitySummary.model_validate(summary, context=self.validation_context)
        path=self.home/'summaries'/f'{value.windowEnd.date().isoformat()}.json'
        data=self._read(path,SUMMARY_LIST)
        item=dict(summary)
        item['timeline']=[row.model_dump(mode='json') for row in value.timeline]
        data.append(item)
        self._write(path,data)
        return path
