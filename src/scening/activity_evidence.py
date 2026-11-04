"""保存成功观察的连续采样依据，文件由采集进程独占写入。"""
from datetime import datetime
import json
from pathlib import Path
from uuid import uuid4
from scening.task_models import Sample,Break,TimeEvidence
from scening.task_store import atomic_save,day_key
class EvidenceStore:
    def __init__(self,home):
        """初始化运行身份；构造阶段保持只读。"""
        self.home=Path(home);self.run_id=str(uuid4());self.generation=0
    def read(self,day):
        """读取并校验已有依据，损坏文件保持原件并传播异常。"""
        path=self.home/'activity-evidence'/f'{day_key(day)}.json'
        return TimeEvidence.model_validate_json(path.read_text()) if path.exists() else TimeEvidence(day=day,samples=[],breaks=[])
    def read_partial(self,day):
        """展示入口逐条读依据；坏条记问题，保留其余样本，写入入口继续严格读取。"""
        path=self.home/'activity-evidence'/f'{day_key(day)}.json'
        if not path.exists():return TimeEvidence(day=day,samples=[],breaks=[]),[]
        raw=json.loads(path.read_text());meta=TimeEvidence.model_validate({**raw,'samples':[],'breaks':[]})
        if meta.day!=day:raise ValueError('采样依据日期不符')
        issues=[]
        for value in raw.get('samples',[]):
            try:
                sample=Sample.model_validate(value);at=datetime.fromisoformat(sample.capturedAt)
                if at.tzinfo is None or at.date().isoformat()!=day:raise ValueError('采样日期或时区无效')
                meta.samples.append(sample)
            except (ValueError,TypeError):issues.append('部分采样依据无法读取，对应时间待确认')
        for value in raw.get('breaks',[]):
            try:
                br=Break.model_validate(value)
                times=[br.at] if br.kind=='point' else [br.start,br.end]
                if not all(t and datetime.fromisoformat(t).tzinfo is not None for t in times):raise ValueError('中断时间无效')
                if br.kind=='range' and datetime.fromisoformat(br.end)<=datetime.fromisoformat(br.start):raise ValueError('中断区间无效')
                meta.breaks.append(br)
            except (ValueError,TypeError):issues.append('部分中断依据无法读取，对应时间待确认')
        return meta,issues

    def mark_break(self,reason,at):
        """按实际中断时点切断后续连续性；写失败仍递增内存代次。"""
        self.generation+=1;day=datetime.fromisoformat(at).date().isoformat();doc=self.read(day)
        doc.breaks.append(Break(kind='point',at=at,runId=self.run_id,reason=reason))
        atomic_save(self.home/'activity-evidence'/f'{day}.json',doc)
    def append_batch(self,activity_ref,samples):
        """原活动成功后保存当前批样本；引用/时间校验后一次原子替换。

        activity_ref来自原活动重新读取的ID与签名，samples沿用候选端序号。
        失败传播给采集侧用于切断连续性，原活动文件保持已提交内容。
        """
        day=activity_ref['start'][:10];doc=self.read(day);known={s.sampleId for s in doc.samples}
        for point in samples:
            sample=Sample.model_validate({**point,'activityId':activity_ref['id'],'sourceSignature':activity_ref['signature']})
            at=datetime.fromisoformat(sample.capturedAt)
            if at.tzinfo is None or at.date().isoformat()!=day:raise ValueError('采样日期或时区无效')
            if sample.sampleId not in known:doc.samples.append(sample);known.add(sample.sampleId)
        atomic_save(self.home/'activity-evidence'/f'{day}.json',doc)
