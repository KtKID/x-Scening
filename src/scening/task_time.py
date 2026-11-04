"""单一时间投影入口：互斥区间、任务片段及估算累计。"""
from datetime import datetime
from scening.task_models import DayTaskView,TimeSlice,Segment,TimePoint,Total
from scening.task_store import read_activities,read_tasks,digest
from scening.activity_evidence import EvidenceStore

def seconds(value):
    """将有时区的采集时点转换为比较数值。"""
    at=datetime.fromisoformat(value)
    if at.tzinfo is None:raise ValueError('时间缺少时区')
    return at.timestamp()
def project_day(config,day):
    """按当前文件构建整天视图；所有累计值均来自本次互斥时间块。

    config为已校验快照，day限定日期。坏关系/依据记录诊断并降级原活动；
    原观察顶层损坏向调用方传播。返回DayTaskView，无文件写入副作用。
    """
    rows,issues=read_activities(config.home,day);by_id={r['id']:r for r in rows}
    doc=None
    try:doc=read_tasks(config.home,day)
    except (ValueError,OSError) as error:issues.append(f'任务关系暂时不可用：{error}')
    # 任务文件读取后复核原文与帧范围；损坏关系整份降级，避免把剩余分支误当唯一任务。
    if doc:
        for assignment in doc.assignments:
            row=by_id.get(assignment.activityId)
            if row and assignment.sourceSignature==row['signature']:
                references=assignment.unassignedEvidence+[e for link in assignment.taskLinks for e in link.evidence]
                if any(not e.excerpt.strip() or e.excerpt not in row['analysis'] or any(i>len(row.get('frames') or []) for i in e.frameIndexes) for e in references):
                    issues.append('任务关系暂时不可用：原文或截图范围校验失败');doc=None;break
    links={a.activityId:a.taskLinks for a in doc.assignments if a.activityId in by_id and a.sourceSignature==by_id[a.activityId]['signature']} if doc else {}
    memberships={identity:{link.taskId for link in items} for identity,items in links.items()}
    unresolved={a.activityId:a.unassignedEvidence for a in doc.assignments} if doc else {}
    assignments={identity:next(iter(ids)) if len(ids)==1 and not unresolved.get(identity) else None for identity,ids in memberships.items()}
    tasks=[t for t in doc.tasks if any(t.taskId in ids for ids in memberships.values())] if doc else []
    # 完成范围只在只读投影中清空，历史日文件与原始进展证据继续保留。
    progress=[p.model_copy(update={'completionScope':None}) for p in doc.progress if p.taskId in {t.taskId for t in tasks} and all(e.activityId in by_id and by_id[e.activityId]['signature']==e.sourceSignature and any(link.taskId==p.taskId and (link.legacy or any(e.excerpt in own.excerpt for own in link.evidence)) for link in links.get(e.activityId,[])) and e.excerpt in by_id[e.activityId]['analysis'] and all(1<=i<=len(by_id[e.activityId].get('frames') or []) for i in e.frameIndexes) for e in p.evidence)] if doc else []
    result=DayTaskView(day=day,tasks=tasks,segments=[],progress=progress,slices=[],points=[],totals=[],issues=issues,start=None,end=None,coveredUntil=doc.coveredUntil if doc else None)
    if not rows:return result
    result.start=min(rows,key=lambda r:seconds(r['start']))['start'];result.end=max(rows,key=lambda r:seconds(r['end']))['end']
    lo=seconds(result.start);hi=seconds(result.end);strings={seconds(result.start):result.start,seconds(result.end):result.end}
    spans=[(seconds(r['start']),seconds(r['end']),r['id']) for r in rows]
    samples=[];breaks=[]
    try:
        evidence,evidence_issues=EvidenceStore(config.home).read_partial(day);issues.extend(evidence_issues);seen=set()
        for sample in evidence.samples:
            r=by_id.get(sample.activityId)
            at=seconds(sample.capturedAt)
            if r and sample.sourceSignature==r['signature'] and lo<=at<=hi and sample.sampleId not in seen:
                samples.append(sample);seen.add(sample.sampleId);strings[at]=sample.capturedAt
        breaks=evidence.breaks
    except (ValueError,OSError) as error:issues.append(f'采样依据暂时不可用：{error}')
    def owner_at(identity,at):
        """按原文明确帧号确定采样点归属；混合/未知范围保持无唯一计时任务。"""
        row=by_id.get(identity)
        if not row:return None
        indexes={i+1 for i,frame in enumerate(row.get('frames') or []) if seconds(frame['capturedAt'])==seconds(at)}
        unknown=unresolved.get(identity) or []
        if any(not e.frameIndexes or indexes.intersection(e.frameIndexes) for e in unknown):return None
        if assignments.get(identity) is not None:return assignments[identity]
        owners={link.taskId for link in links.get(identity,[]) if any(indexes.intersection(e.frameIndexes) for e in link.evidence)}
        return next(iter(owners)) if len(owners)==1 else None

    maximum=config.taskTimeline.maxContinuityGapSeconds
    estimates=[];unknown=[];pauses=[]
    for br in breaks:
        if br.kind=='range' and br.start and br.end:
            a,b=seconds(br.start),seconds(br.end)
            if lo<=a<b<=hi:pauses.append((a,b));strings[a]=br.start;strings[b]=br.end
    ordered=sorted(samples,key=lambda s:(s.runId,s.sampleSequence))
    for a,b in zip(ordered,ordered[1:]):
        x,y=seconds(a.capturedAt),seconds(b.capturedAt)
        if y<=x:continue
        ta,tb=owner_at(a.activityId,a.capturedAt),owner_at(b.activityId,b.capturedAt)
        blocked=any(r['id'] not in (a.activityId,b.activityId) and x<seconds(r['start'])<y and assignments.get(r['id'])!=ta for r in rows)
        blocked=blocked or any(x<seconds(f['capturedAt'])<y and owner_at(identity,f['capturedAt'])!=ta for identity in {a.activityId,b.activityId} for f in by_id[identity].get('frames') or [])
        interrupted=any(br.at and x<=seconds(br.at)<y for br in breaks if br.kind=='point')
        if a.runId==b.runId and a.continuityId==b.continuityId and b.sampleSequence==a.sampleSequence+1 and y-x<=maximum and ta is not None and ta==tb and not blocked and not interrupted:
            estimates.append((x,y,ta,{a.activityId,b.activityId}))
        elif a.runId==b.runId:
            unknown.append((x,y))
    endpoints={lo,hi}
    for x,y,_ in spans:endpoints.update((x,y))
    for x,y,_,_ in estimates:endpoints.update((x,y))
    for x,y in unknown+pauses:endpoints.update((x,y))
    def stamp(at):return strings.get(at) or datetime.fromtimestamp(at,datetime.fromisoformat(result.start).tzinfo).isoformat()
    values=sorted(x for x in endpoints if lo<=x<=hi)
    for x,y in zip(values,values[1:]):
        if y<=x:continue
        active=[e for e in estimates if e[0]<=x and e[1]>=y];ids={identity for _,_,_,identities in active for identity in identities}
        covering={identity for a,b,identity in spans if a<y and b>x};owners={e[2] for e in active}
        paused=any(a<y and b>x for a,b in pauses)
        conflicting=any(assignments.get(identity)!=next(iter(owners)) and not (identity in ids and next(iter(owners)) in memberships.get(identity,set())) for identity in covering) if len(owners)==1 else len(owners)>1
        if owners and not conflicting and not paused:
            kind='task';task=next(iter(owners));reason=None
        elif covering or active or any(a<y and b>x for a,b in unknown):
            kind='uncertain';task=None;reason='观察归属或连续时间待确认'
        else:kind='gap';task=None;reason='未记录'
        result.slices.append(TimeSlice(sliceId=digest([day,x,y,kind,task])[:24],start=stamp(x),end=stamp(y),kind=kind,taskId=task,activityIds=sorted(ids|covering),segmentId=None,reason=reason))
    # 有效投入相邻且同任务时形成一个片段；其余观察单独保留入口。
    def segment(task,start,end,ids,slices):
        first=by_id[ids[0]];sid=digest([day,task,ids[0],start])[:24]
        return Segment(segmentId=sid,taskId=task,activityIds=ids,start=start,end=end,action=first.get('observation',{}).get('visible_activity',first['analysis']) if first.get('observation') else first['analysis'],estimateSeconds=sum(seconds(s.end)-seconds(s.start) for s in slices),partial=False,sliceIds=[s.sliceId for s in slices],pointIds=[])
    covered=set()
    for block in result.slices:
        if block.kind!='task':continue
        if any(len(memberships.get(identity,set()))>1 for identity in block.activityIds):continue
        previous=result.segments[-1] if result.segments else None
        if previous and previous.taskId==block.taskId and seconds(previous.end)==seconds(block.start):
            previous.end=block.end;previous.activityIds=list(dict.fromkeys(previous.activityIds+block.activityIds));previous.sliceIds.append(block.sliceId);previous.estimateSeconds+=seconds(block.end)-seconds(block.start);item=previous
        else:
            item=segment(block.taskId,block.start,block.end,block.activityIds,[block]);result.segments.append(item)
        block.segmentId=item.segmentId;covered.update(item.activityIds)
    for row in rows:
        if row['id'] not in covered:
            for link in links.get(row['id']) or [None]:
                item=segment(link.taskId if link else None,row['start'],row['end'],[row['id']],[])
                if link and link.action:item.action=link.action
                owned=[s for s in result.slices if s.taskId==item.taskId and row['id'] in s.activityIds and s.segmentId is None]
                item.sliceIds=[s.sliceId for s in owned]
                item.estimateSeconds=sum(seconds(s.end)-seconds(s.start) for s in owned)
                for block in owned:block.segmentId=item.segmentId
                item.partial=True;result.segments.append(item)
    result.segments.sort(key=lambda s:seconds(s.start))
    for row in rows:
        points=[s.capturedAt for s in samples if s.activityId==row['id']] or [f['capturedAt'] for f in row.get('frames') or []] or [row['start']]
        for at in dict.fromkeys(points):
            point_owner=owner_at(row['id'],at)
            candidates=[s for s in result.segments if row['id'] in s.activityIds and seconds(s.start)<=seconds(at)<=seconds(s.end)]
            if not candidates:
                # 采样带微秒而原记录边界可按秒保存；时点保留原精度，仍回到同一记录最近的任务段。
                candidates=sorted([s for s in result.segments if row['id'] in s.activityIds],key=lambda s:min(abs(seconds(s.start)-seconds(at)),abs(seconds(s.end)-seconds(at))))
            target=next((s for s in candidates if s.taskId==point_owner),candidates[0] if candidates else None)
            if target is None:
                target=segment(assignments.get(row['id']),at,at,[row['id']],[]);target.partial=True;result.segments.append(target)
            pid=digest([row['id'],at])[:24];target.pointIds.append(pid)
            result.points.append(TimePoint(pointId=pid,at=at,activityId=row['id'],taskId=point_owner,segmentId=target.segmentId))
    result.segments.sort(key=lambda s:seconds(s.start))
    for task in tasks:
        own=[r for r in rows if task.taskId in memberships.get(r['id'],set())];first=min(seconds(r['start']) for r in own);last=max(seconds(r['end']) for r in own)
        uncertain=any(s.kind=='uncertain' and any(identity in s.activityIds for identity in (r['id'] for r in own)) for s in result.slices)
        total=sum(seconds(s.end)-seconds(s.start) for s in result.slices if s.taskId==task.taskId)
        result.totals.append(Total(taskId=task.taskId,estimatedSeconds=total,spanSeconds=last-first,hasUncertainCoverage=uncertain or total==0))
    result.issues=issues
    return result
