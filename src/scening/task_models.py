"""任务时间线的唯一协议；桌面契约由本模块生成。"""
from typing import Literal,Optional,Union,Annotated
from pydantic import BaseModel,ConfigDict,Field,model_validator,AliasChoices

# 用户确认的新任务命名字段上限；已保存Task保留历史长名称兼容。
TASK_TITLE_MAX_CHARS = 10

class Protocol(BaseModel):
    model_config=ConfigDict(extra='forbid')
class Task(Protocol):
    taskId:str=Field(min_length=1)
    day:str
    title:str=Field(min_length=1)
    object:str=Field(min_length=1)
    goal:str=Field(min_length=1)
class Evidence(Protocol):
    activityId:str
    sourceSignature:str
    excerpt:str=Field(min_length=1)
    frameIndexes:list[Annotated[int,Field(strict=True,ge=1)]]=Field(default_factory=list,description='原分析明确给出的1基帧号；空列表表示整条记录范围。')
class TaskLink(Protocol):
    taskId:str=Field(min_length=1)
    action:str=''
    evidence:list[Evidence]=Field(default=[])
    legacy:bool=False
class Assignment(Protocol):
    activityId:str
    sourceSignature:str
    taskLinks:list[TaskLink]=Field(default=[])
    relationVersion:Union[Literal[1],Literal[2]]=2
    unassignedEvidence:list[Evidence]=Field(default=[])

    @model_validator(mode='before')
    @classmethod
    def read_legacy(cls,value):
        """把v1单任务规范化为列表；原文件及历史证据保持原样。"""
        if isinstance(value,dict) and 'taskId' in value and 'taskLinks' not in value:
            result=dict(value);task=result.pop('taskId')
            result.update(taskLinks=[{'taskId':task,'legacy':True}] if task else [],relationVersion=1)
            return result
        return value

    @property
    def taskId(self):
        """旧Python调用方只在唯一任务时取得编号，多任务由taskLinks表达。"""
        return self.taskLinks[0].taskId if len(self.taskLinks)==1 else None
class Progress(Protocol):
    progressId:str
    taskId:str
    text:str=Field(min_length=1)
    kind:Literal['observed','ai_reported','inferred','unknown']
    completionScope:Optional[str]=None  # 历史兼容字段；新进展固定停用。
    evidence:list[Evidence]=Field(min_length=1)
class DayTasks(Protocol):
    schemaVersion:Union[Literal[1],Literal[2]]=2
    day:str
    generatedAt:str
    coveredUntil:Optional[str]
    semanticRevision:str
    tasks:list[Task]
    assignments:list[Assignment]
    progress:list[Progress]
class ProposedTask(Protocol):
    key:str=Field(min_length=1)
    title:str=Field(min_length=1,max_length=TASK_TITLE_MAX_CHARS,description='新任务名采用“动作＋具体对象＋事项”，例如“修复拾绪的登录”；具体对象取自活动原文。已有任务沿用原任务名称与标识。')
    object:str=Field(min_length=1)
    goal:str=Field(min_length=1)
class ProposedAssignment(Protocol):
    activityId:str
    taskKey:Optional[str]
class ProposedProgress(Protocol):
    taskKey:str
    text:str=Field(min_length=1)
    kind:Literal['observed','ai_reported','inferred','unknown']
    evidence:list[Evidence]=Field(min_length=1)
    progressId:Optional[str]=None

    @model_validator(mode='before')
    @classmethod
    def ignore_legacy_completion(cls,value):
        """接收旧模型回复时忽略已停用字段，任务关联和活动证据继续校验。

        value为未校验建议，返回新字典以保留输入原值；其余未知字段沿严格协议报错。
        完成判断由本轮用户明确停用，模型回复结构与新保存进展均保持该边界。
        """
        return {key:item for key,item in value.items() if key!='completionScope'} if isinstance(value,dict) else value
class TaskProposal(Protocol):
    tasks:list[ProposedTask]
    assignments:list[ProposedAssignment]
    progress:list[ProposedProgress]
class ProposedBranchProgress(Protocol):
    text:str=Field(min_length=1)
    kind:Literal['observed','ai_reported','inferred','unknown']
    evidenceIds:list[str]=Field(min_length=1)
class ProposedTaskLink(Protocol):
    taskKey:str=Field(min_length=1)
    action:str=Field(min_length=1)
    evidenceIds:list[str]=Field(min_length=1)
    progress:list[ProposedBranchProgress]=Field(default=[])
class ProposedMultiAssignment(Protocol):
    activityId:str
    taskLinks:list[ProposedTaskLink]
    unassignedEvidenceIds:list[str]=Field(default=[])
class MultiTaskProposal(Protocol):
    schemaVersion:Literal[2]
    newTasks:list[ProposedTask]=Field(validation_alias=AliasChoices('newTasks','tasks'),description='仅声明本轮新建任务，临时key须与已有任务ID不同；复用已有任务时直接在taskLinks.taskKey填写其taskId。旧tasks回复仅作兼容读取。')
    assignments:list[ProposedMultiAssignment]
class Sample(Protocol):
    sampleId:str
    activityId:str
    sourceSignature:str
    capturedAt:str
    runId:str
    continuityId:str
    sampleSequence:int=Field(ge=0)
    app:Optional[str]
    bundleId:Optional[str]
    screen:Optional[int]
class Break(Protocol):
    kind:Literal['point','range']
    at:Optional[str]=None
    start:Optional[str]=None
    end:Optional[str]=None
    runId:str
    reason:str
class TimeEvidence(Protocol):
    schemaVersion:Literal[1]=1
    day:str
    samples:list[Sample]
    breaks:list[Break]
class Segment(Protocol):
    segmentId:str
    taskId:Optional[str]
    activityIds:list[str]
    start:str
    end:str
    action:str
    estimateSeconds:float
    partial:bool
    sliceIds:list[str]
    pointIds:list[str]
class TimeSlice(Protocol):
    sliceId:str
    start:str
    end:str
    kind:Literal['task','gap','uncertain']
    taskId:Optional[str]
    activityIds:list[str]
    segmentId:Optional[str]
    reason:Optional[str]
class TimePoint(Protocol):
    pointId:str
    at:str
    activityId:str
    taskId:Optional[str]
    segmentId:str
class Total(Protocol):
    taskId:str
    estimatedSeconds:float
    spanSeconds:float
    hasUncertainCoverage:bool
class DayTaskView(Protocol):
    day:str
    tasks:list[Task]
    segments:list[Segment]
    progress:list[Progress]
    slices:list[TimeSlice]
    points:list[TimePoint]
    totals:list[Total]
    issues:list[str]
    start:Optional[str]
    end:Optional[str]
    coveredUntil:Optional[str]
class TimelineReadReply(Protocol):
    day:str
    sourceRevision:str
    semanticRevision:str=''
    needsOrganization:bool=False
    pendingCount:int=0
    evidenceRevision:str
    taskRevision:str
    organizing:Literal['idle','running','failed','disabled']
    coveredUntil:Optional[str]
    view:Optional[DayTaskView]
    issues:list[str]
