"""严格读取已保存活动与周期总结，构造可分页的自然日日快照。"""
from datetime import date, datetime, timedelta
import hashlib
import json
from pydantic import TypeAdapter
from scening.activity_memory import ActivityEvent, ActivitySummary, captured_app_names

# 外部原生read的单行协议边界；保留缩进和键名空间。
READ_LINE_LIMIT = 2000
STRING_LINE_BUDGET = 1600

def _read(path, model):
    """缺文件返回空列表；原文件的IO、结构及逐行校验错误保持原文传播。"""
    if not path.exists(): return []
    return TypeAdapter(list[model]).validate_json(path.read_text(encoding='utf-8'),context={'allow_absolute_images':True})

def build_day_input(config, day):
    """读取指定自然日完整已保存资料；返回文字快照，原记录保持原值。

    参数config为已校验配置，day为真实日期；严格读取前一日、本日活动及
    本日、次日周期。活动不足24小时也可总结。跨日周期仅投影可定位事实；
    读取或校验错误向调用方传播，函数仅访问原文件。
    """
    target=date.fromisoformat(day)
    if target.isoformat()!=day: raise ValueError('日期无效')
    activities=[];periods=[];seen=set()
    def add(start,end,app,analysis):
        if start.date()!=target:return
        key=(start.isoformat(),end.isoformat(),app,analysis)
        if key in seen:return
        seen.add(key)
        activities.append(dict(id=hashlib.sha256(json.dumps(key,ensure_ascii=False).encode()).hexdigest(),start=key[0],end=key[1],app=app,analysis=analysis))
    for offset in (-1,0):
        source=target+timedelta(days=offset)
        for row in _read(config.home/'records'/f'{source}.json',ActivityEvent):
            if row.start.date()!=source:raise ValueError(f'活动日期与文件不符：{source}')
            add(row.start,row.end,'、'.join(captured_app_names(row.model_dump(mode='json'))),row.analysis)
    for offset in (0,1):
        source=target+timedelta(days=offset)
        for row in _read(config.home/'summaries'/f'{source}.json',ActivitySummary):
            if row.windowEnd.date()!=source:raise ValueError(f'周期总结日期与文件不符：{source}')
            if row.windowStart.date()==target and (row.windowEnd.date()==target or (row.windowEnd.date()==target+timedelta(days=1) and row.windowEnd.time()==datetime.min.time())):
                periods.append(row.model_dump(mode='json',include={'windowStart','windowEnd','gaps','summary','trigger'}))
            elif row.windowStart.date()<=target<=row.windowEnd.date():
                for item in row.timeline:add(item.start,item.end,item.app,item.analysis)
    activities.sort(key=lambda r:r['start']);periods.sort(key=lambda r:r['windowStart'])
    return dict(day=day,activities=activities,periods=periods,coverage='依据生成时已保存的分析；采样间隙与尚待分析部分保持未确认，后续新分析可重新生成纳入。')

def encode_input(value):
    """把过长文本无损拆成连续Parts，保证序列化后每行符合外部read边界。"""
    def parts(text):
        output=[]
        while text:
            left=1;right=min(len(text),STRING_LINE_BUDGET)
            while left<right:
                middle=(left+right+1)//2
                if len(json.dumps(text[:middle],ensure_ascii=False))<=STRING_LINE_BUDGET:left=middle
                else:right=middle-1
            output.append(text[:left]);text=text[left:]
        return output
    def split(item):
        if isinstance(item,dict):
            return {key+'Parts' if isinstance(v,str) and len(json.dumps(v,ensure_ascii=False))>STRING_LINE_BUDGET else key:parts(v) if isinstance(v,str) and len(json.dumps(v,ensure_ascii=False))>STRING_LINE_BUDGET else split(v) for key,v in item.items()}
        if isinstance(item,list):return [split(v) for v in item]
        return item
    text=json.dumps(split(value),ensure_ascii=False,sort_keys=True,indent=2)+'\n'
    if max(map(len,text.splitlines()),default=0)>READ_LINE_LIMIT:raise ValueError('每日输入仍超过原生读取行边界')
    return text
