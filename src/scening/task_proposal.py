"""任务建议的纯数据编译：可信证据编号、多任务归属和进展合并。"""
import re
from typing import Union
from uuid import uuid4
from pydantic import TypeAdapter
from scening.task_models import (TaskProposal,MultiTaskProposal,Task,Assignment,TaskLink,Evidence,Progress)

class ProposalError(ValueError):
    """携带安全诊断码的建议边界错误；消息仅包含本地位置和校验类型。"""
    def __init__(self,code,message):
        self.code=code
        super().__init__(message)


PROPOSAL=TypeAdapter(Union[MultiTaskProposal,TaskProposal])


def evidence_options(batch):
    """按原记录及原行序分配本轮证据编号，原文与来源签名由本地填写。

    batch是已校验的当前批活动；返回可序列化候选列表。本轮编号只在此快照内有效。
    原文明确以单帧标记开头且只涉及该帧时保存1基帧号，其余保持整条记录范围。
    不读取或修改截图，帧号只能来自当前记录已保存的frames范围。
    """
    options=[]
    for row in batch:
        frames=row.get('frames') or []
        for line in row['analysis'].splitlines():
            if not line.strip():continue
            match=re.match(r'^\s*(?:第(\d+)帧|子图(\d+))\s*[：:]',line)
            indexes=[]
            if len(frames)==1:indexes=[1]
            elif match:
                index=int(match.group(1) or match.group(2))
                mentions=re.findall(r'(?:第(\d+)帧|子图(\d+))',line)
                if 1<=index<=len(frames) and len(mentions)==1:indexes=[index]
            options.append({'id':f'e{len(options)+1}','activityId':row['id'],
                            'sourceSignature':row['signature'],'excerpt':line,'frameIndexes':indexes})
    return options


def compile_proposal(text,batch,doc,day,rows):
    """校验建议并编译为任务目录、每记录关联与独立进展，保持全部输入只读。

    text是模型完整JSON，batch/rows来自同日已固定活动，doc为旧任务文档或None。
    新格式的进展从父任务分支继承归属；旧格式只接受原先有效的一对一建议。
    所有编号、原文、来源及当前批边界验证后返回新集合；异常由调用方保留旧文件。
    本函数仅分配新任务/进展ID，文件提交、取消和日锁归调用方负责。
    """
    proposal=PROPOSAL.validate_json(text)
    by_id={r['id']:r for r in rows};expected={r['id'] for r in batch}
    if {a.activityId for a in proposal.assignments}!=expected or len(proposal.assignments)!=len(expected):
        raise ValueError('本批活动关联缺失或重复')
    tasks=list(doc.tasks) if doc else [];keys={t.taskId:t.taskId for t in tasks}
    new_tasks=proposal.newTasks if isinstance(proposal,MultiTaskProposal) else proposal.tasks
    for task in new_tasks:
        if task.key in keys or not all(v.strip() for v in (task.key,task.title,task.object,task.goal)):
            raise ProposalError('TASK_ORGANIZER_TASK_DECLARATION','新建任务声明包含重复编号或空描述；已有任务应直接引用其ID')
        identity=str(uuid4());keys[task.key]=identity
        tasks.append(Task(taskId=identity,day=day,title=task.title,object=task.object,goal=task.goal))
    options={o['id']:o for o in evidence_options(batch)}
    saved={a.activityId:a for a in doc.assignments} if doc else {}
    pending_progress=[]

    def resolve(ids,activity):
        """只从当前活动的候选中取回证据，模型无法覆盖原文和来源。"""
        result=[]
        for identity in dict.fromkeys(ids):
            option=options.get(identity)
            if option is None or option['activityId']!=activity:
                raise ProposalError('TASK_ORGANIZER_EVIDENCE_REFERENCE',f'证据编号无效或属于其他记录（记录{activity[:8]}）')
            result.append(Evidence(**{k:v for k,v in option.items() if k!='id'}))
        return result

    if isinstance(proposal,MultiTaskProposal):
        used=set()
        for assignment in proposal.assignments:
            links=[];seen=set()
            for link in assignment.taskLinks:
                if link.taskKey not in keys:raise ValueError('任务引用越界')
                if not link.action.strip():raise ProposalError('TASK_ORGANIZER_EMPTY_ACTION','任务分支的活动描述为空')
                tid=keys[link.taskKey]
                if tid in seen:raise ValueError('同记录任务关联重复')
                seen.add(tid);used.add(link.taskKey)
                references=list(link.evidenceIds)
                for progress in link.progress:
                    if not progress.text.strip():raise ValueError('进展文字为空')
                    evidence=resolve(progress.evidenceIds,assignment.activityId)
                    references.extend(progress.evidenceIds)
                    pending_progress.append((tid,progress.text,progress.kind,evidence,None))
                links.append(TaskLink(taskId=tid,action=link.action,
                                      evidence=resolve(references,assignment.activityId)))
            saved[assignment.activityId]=Assignment(activityId=assignment.activityId,
                sourceSignature=by_id[assignment.activityId]['signature'],taskLinks=links,
                unassignedEvidence=resolve(assignment.unassignedEvidenceIds,assignment.activityId))
        if any(task.key not in used for task in new_tasks):raise ValueError('新任务缺少有效关联')
    else:
        for assignment in proposal.assignments:
            if assignment.taskKey is not None and assignment.taskKey not in keys:raise ValueError('任务引用越界')
            row=by_id[assignment.activityId];tid=keys.get(assignment.taskKey)
            links=[TaskLink(taskId=tid,legacy=True,evidence=[Evidence(activityId=row['id'],sourceSignature=row['signature'],excerpt=row['analysis'])])] if tid else []
            saved[assignment.activityId]=Assignment(activityId=row['id'],sourceSignature=row['signature'],taskLinks=links)
        for progress in proposal.progress:
            if progress.taskKey not in keys or not progress.text.strip():raise ValueError('进展任务引用无效')
            tid=keys[progress.taskKey]
            for evidence in progress.evidence:
                row=by_id.get(evidence.activityId)
                if (evidence.activityId not in expected or not row or evidence.sourceSignature!=row['signature']
                    or evidence.excerpt not in row['analysis'] or not evidence.excerpt.strip()
                    or any(index>len(row.get('frames') or []) for index in evidence.frameIndexes)
                    or tid not in {link.taskId for link in saved[evidence.activityId].taskLinks}):
                    raise ValueError('进展缺少有效原文证据')
            pending_progress.append((tid,progress.text,progress.kind,progress.evidence,progress.progressId))

    def valid(evidence,task):
        """旧进展只保留仍匹配当前来源与当前任务关联的证据。"""
        row=by_id.get(evidence.activityId);assignment=saved.get(evidence.activityId)
        return (row and assignment and row['signature']==evidence.sourceSignature
                and assignment.sourceSignature==row['signature'] and evidence.excerpt in row['analysis']
                and any(link.taskId==task and (link.legacy or any(evidence.excerpt in own.excerpt for own in link.evidence)) for link in assignment.taskLinks)
                and all(index<=len(row.get('frames') or []) for index in evidence.frameIndexes))
    progress=[]
    for old in doc.progress if doc else []:
        evidence=[e for e in old.evidence if valid(e,old.taskId)]
        if evidence:progress.append(old.model_copy(update={'evidence':evidence,'completionScope':None}))
    for tid,text,kind,evidence,identity in pending_progress:
        old=next((p for p in progress if p.taskId==tid and (p.progressId==identity or (p.text==text and p.kind==kind))),None)
        if identity and (old is None or old.progressId!=identity):raise ValueError('进展编号越界')
        merged={(e.activityId,e.sourceSignature,e.excerpt,tuple(e.frameIndexes)):e
                for e in ((old.evidence if old else [])+evidence)}
        item=Progress(progressId=old.progressId if old else str(uuid4()),taskId=tid,text=text,kind=kind,
                      completionScope=None,evidence=list(merged.values()))
        progress=[p for p in progress if p.progressId!=item.progressId]+[item]
    return tasks,list(saved.values()),progress
