"""按日任务文件的校验与原子提交；原观察由原流程拥有。"""
from datetime import date,datetime
import hashlib,json,os,tempfile
from pathlib import Path
from scening.activity_memory import ActivityEvent
from scening.task_models import DayTasks

def digest(value):
    """对规范JSON做摘要，用于身份和来源失效检测。"""
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def day_key(day):
    """在构造路径前校验日历日期。"""
    if date.fromisoformat(day).isoformat()!=day:raise ValueError('日期无效')
    return day
def signature(row):
    """活动已知字段的内容签名；end延长沿用原关联。"""
    return digest({key:row.get(key) for key in ('start','app','bundleId','source','analysis','observation','screenshot','mini','frames')})
def read_activities(home,day):
    """逐行校验原活动并保留原序号；坏行记诊断，顶层损坏传播。"""
    target=Path(home)/'records'/f'{day_key(day)}.json'
    if not target.exists():return [],[]
    raw=json.loads(target.read_text());issues=[];records=[]
    if not isinstance(raw,list):raise ValueError('活动文件应为列表')
    for index,value in enumerate(raw):
        try:
            event=ActivityEvent.model_validate(value,context={'allow_absolute_images':True})
            if event.start.date().isoformat()!=day:raise ValueError('活动日期无效')
            row=event.model_dump(mode='json');row['start']=value['start'];row['end']=value['end']
            identity=hashlib.sha256(f'{day}:{index}:{value["start"]}'.encode()).hexdigest()[:24]
            row.update(id=identity,signature=signature(row));records.append((event.start,row))
        except (ValueError,TypeError) as error:issues.append(f'活动第{index+1}条无法读取：{error}')
    # 按已校验的实际时刻排序，保留原始时间字符串与物理行派生的活动身份。
    return [row for _,row in sorted(records,key=lambda item:item[0])],issues
def atomic_save(path,model):
    """完整写入同目录临时文件并刷新后替换；异常保留旧文件且清理临时文件。"""
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,delete=False) as stream:
            temporary=Path(stream.name);stream.write(model.model_dump_json(indent=2)+'\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if temporary:temporary.unlink(missing_ok=True)
def read_tasks(home,day):
    """返回关系完整的日文件；损坏文件向调用方报告并保留原件。"""
    target=Path(home)/'task-timeline'/f'{day_key(day)}.json'
    if not target.exists():return None
    doc=DayTasks.model_validate_json(target.read_text())
    ids=[t.taskId for t in doc.tasks];activities=[a.activityId for a in doc.assignments]
    if doc.day!=day or any(t.day!=day for t in doc.tasks) or len(ids)!=len(set(ids)) or len(activities)!=len(set(activities)):raise ValueError('任务日期或身份无效')
    if any(link.taskId not in ids for a in doc.assignments for link in a.taskLinks) or any(p.taskId not in ids for p in doc.progress):raise ValueError('任务引用无效')
    if any(len({link.taskId for link in a.taskLinks})!=len(a.taskLinks) for a in doc.assignments):raise ValueError('同记录任务关联重复')
    for assignment in doc.assignments:
        references=assignment.unassignedEvidence+[e for link in assignment.taskLinks for e in link.evidence]
        if any(e.activityId!=assignment.activityId or e.sourceSignature!=assignment.sourceSignature for e in references):
            raise ValueError('任务关联证据来源无效')
        if any(not link.legacy and not link.evidence for link in assignment.taskLinks):
            raise ValueError('任务关联缺少原文证据')
    if len({p.progressId for p in doc.progress})!=len(doc.progress):raise ValueError('进展身份重复')
    datetime.fromisoformat(doc.generatedAt)
    return doc


def save_tasks(path,doc):
    """任务v1首次升级前按原字节独占备份，再沿现有原子写入提交v2。

    path为同日任务文件，doc为已完成来源及引用校验的文档。
    备份使用原字节摘要命名，可重试且保持唯一；备份失败时保留原文件。
    原活动与截图由原所有者保存，本入口只写任务文件及其backups目录。
    """
    path=Path(path)
    if path.exists():
        raw=path.read_bytes()
        if json.loads(raw).get('schemaVersion',1)==1:
            folder=path.parent/'backups';folder.mkdir(exist_ok=True)
            backup=folder/f'{path.stem}.v1-{hashlib.sha256(raw).hexdigest()[:16]}.json'
            temporary=None
            try:
                with tempfile.NamedTemporaryFile(dir=folder,delete=False) as stream:
                    temporary=Path(stream.name);stream.write(raw);stream.flush();os.fsync(stream.fileno())
                try:os.link(temporary,backup)
                except FileExistsError:
                    if backup.read_bytes()!=raw:raise ValueError('旧任务备份内容不匹配')
            finally:
                if temporary:temporary.unlink(missing_ok=True)
    atomic_save(path,doc)
