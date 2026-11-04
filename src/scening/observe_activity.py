"""独立运行采集，串行消费候选并沿用 KMH、每日 JSON 与周期总结。

持续运行：PYTHONPATH=src .venv/bin/python -m scening.observe_activity
短试跑：PYTHONPATH=src .venv/bin/python -m scening.observe_activity --count 1 --summary-on-exit
短试跑提前总结写manual_exit标识，默认总结周期由observer.yaml提供。
"""
import argparse
from contextlib import nullcontext
from datetime import datetime, timedelta
import fcntl
import json
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
from uuid import uuid4
from PIL import Image, ImageChops, ImageStat
from scening import permissions
from scening import runtime_logging
from scening.activity_memory import ActivityFrame, ActivityMemory, ObservationResult, SummaryActivity, observation_text, captured_app_names
from scening.app_identity import frontmost_application
from scening.analysis_batch import BatchFrame, compose_batch, frame_metadata
from scening.kmh_interpreter import KMHInterpreter
from scening.observer_config import DEFAULT_CONFIG_PATH, load_config
from scening.collector import SensingCollector
from scening.activity_evidence import EvidenceStore
from scening.task_store import read_activities,digest
from scening.runtime_control import RuntimeControl, AnalysisCancelled
from scening.screenshot_index import rebuild_day
from scening.screenshot_queue import ScreenshotQueue, pending_images, analysis_lock
from scening.capture_metadata import save_capture

class LogUnavailableError(OSError):
    """日志入口失效时结束运行，和可恢复的数据文件故障分别处理。"""

def log_event(event):
    """追加项目日志，失败转换为运行结束信号，保留已提交图片与记录。"""
    try:
        runtime_logging.log_event(event)
    except OSError as error:
        raise LogUnavailableError(str(error)) from error

class ActivityPipeline:
    """持有最近成功记录基准，串行协调模型和Memory提交。"""
    def __init__(self,home,interpreter=None,config=None,*,control=None,epoch=None):
        """解析home并持有启动配置，创建公开协作者；重启从新片段分析。

        config为Pydantic校验快照，省略时读取项目配置；interpreter用于替换模型边界。
        差异阈值和总结周期从快照读取，运行途中编辑文件在下次启动生效。
        构造只初始化内存与协作者；实际文件提交由process/summarize触发。
        """
        self.home=Path(home).resolve()
        self.config=(config or load_config()).with_overrides(home=self.home)
        self.interpreter=interpreter or KMHInterpreter(self.home,config=self.config)
        self.memory=ActivityMemory(self.home, screenshot_dir=self.config.screenshotDir)
        self.anchor=None
        self.baseline_mini=None
        self.closed_window=0
        self.gaps=[]
        self.pending=[]
        self.control=control
        self.epoch=epoch
        self.time_evidence=EvidenceStore(self.home)
        self.sample_metadata={}

    def commit(self):
        """取得当前段的短提交边界；离线/独立测试保持既有调用兼容。"""
        return self.control.commit(self.epoch) if self.control is not None else nullcontext()

    def check_active(self):
        """每个新模型入口与结果提交前检查代次，关闭后的旧任务按取消结束。"""
        with self.commit():
            pass

    def discard_pending(self,reason):
        """结束未满批：记录数量、证据与原因后释放内存引用，原始JPEG保持。"""
        if self.pending:
            log_event({'stage':'analysis_batch','result':'incomplete','pendingCount':len(self.pending),
                       'batchSize':self.config.analysis.batchSize,'message':reason,
                       'frames':frame_metadata(self.pending)})
            self.pending=[]

    def report_pending(self,count,at,*,reason=None):
        """公开队列等待/中断进度，沿用既有终端事件结构并保留真实数量。"""
        log_event({'stage':'analysis_batch','result':'incomplete' if reason else 'pending',
                   'pendingCount':count,'batchSize':self.config.analysis.batchSize,
                   'capturedAt':at,'message':reason or '等待实时满批'})

    def reset(self,reason):
        """中断后重新建立批次与成功基准，日志保留未满批的实际采集信息。"""
        self.anchor=self.baseline_mini=None
        self.discard_pending(reason)
        self.sample_metadata.clear()
        try:self.time_evidence.mark_break(reason,datetime.now().astimezone().isoformat())
        except (ValueError,OSError):log_event({"stage":"time_evidence","result":"failed","message":"中断依据保存失败"})

    def _same_as_anchor(self,frame):
        """核对一帧与成功基准；跨日、未知应用、尺寸变化直接要求分析。"""
        evidence=frame.evidence
        if not self.anchor or not evidence.bundleId or self.anchor['bundleId']!=evidence.bundleId or self.anchor['start'][:10]!=evidence.capturedAt.date().isoformat():
            return False
        with Image.open(frame.image.mini) as current,Image.open(self.baseline_mini) as previous:
            if current.size!=previous.size:
                return False
            with current.convert('RGB') as left,previous.convert('RGB') as right:
                with ImageChops.difference(left,right) as difference:
                    mean=ImageStat.Stat(difference).mean
                    return sum(mean)/(len(mean)*255)<self.config.differenceThreshold

    def process(self,prepared,at,app,bundle_id,*,screen=None,sample_sequence=None,continuity=None):
        """接收一帧已保存候选，凑满配置数量后拼图并调用一次KMH。

        at、应用与screen均来自采集。返回pending、analyzed或extended。
        同日按顺序积累；跨日或时间倒退重建待凑批。满批每帧均与成功基准相同才延长end，
        其他批次先完整提交拼图，再分析与追加每日JSON，最后更新成功基准。
        模型、拼图或记录失败保留原图/已提交拼图，清除基准并传播异常；后续从新批继续。
        """
        self.check_active()
        if self.pending and (at.date()!=self.pending[0].evidence.capturedAt.date() or at<self.pending[-1].evidence.capturedAt):
            self.reset('跨日或采集时间倒退，重新凑图')
        evidence=ActivityFrame.model_validate({'capturedAt':at,'screenshot':self.memory.image_reference(prepared.original),
                                             'app':app,'bundleId':bundle_id,'screen':screen},context=self.memory.validation_context)
        if sample_sequence is not None:
            self.sample_metadata[str(prepared.original)]={"sampleId":digest([str(prepared.original),at.isoformat()]),"capturedAt":at.isoformat(),"runId":self.time_evidence.run_id,"continuityId":f"{continuity}:{self.epoch}:{self.time_evidence.generation}","sampleSequence":sample_sequence,"app":app,"bundleId":bundle_id,"screen":screen}
        self.pending.append(BatchFrame(prepared,evidence))
        if len(self.pending)<self.config.analysis.batchSize:
            log_event({'stage':'analysis_batch','result':'pending','pendingCount':len(self.pending),
                       'batchSize':self.config.analysis.batchSize,'capturedAt':at.isoformat(timespec='seconds')})
            return 'pending'
        batch,self.pending=self.pending,[]
        return self.process_batch(batch)

    def process_batch(self,batch,*,force=False,allow_partial=False,samples=None):
        """分析已按时间排序的同日原图批，供实时队列与原候选入口共用。

        force用于开启时积压，allow_partial只为积压尾批；samples为采集端连续性依据。
        调用者持同日处理锁，当前方法继续拥有取消代次、模型与正式Memory提交。
        外部补分析已追加时清除旧合并基准，保留原行；报告→采样→派生索引顺序保持。
        """
        if not batch or len(batch)>self.config.analysis.batchSize or (not allow_partial and len(batch)!=self.config.analysis.batchSize):
            raise ValueError('分析批数量无效')
        self.sample_metadata.update(samples or {})
        self.check_active()
        if self.anchor and not self.memory.tail_matches(self.anchor):
            self.anchor=self.baseline_mini=None
        first,last=batch[0].evidence,batch[-1].evidence
        try:
            if not force and all(self._same_as_anchor(frame) for frame in batch):
                with self.commit():
                    self.memory.extend(self.anchor,last.capturedAt)
                self.save_time_evidence(batch)
                self.refresh_screenshot_index(first.capturedAt.date().isoformat())
                log_event({'stage':'activity','result':'extended','end':last.capturedAt.isoformat(timespec='seconds'),'mini':str(batch[-1].image.mini),'modelCalls':0})
                return 'extended'
            collage=compose_batch(batch,self.home,self.config.analysis,allow_partial=allow_partial)
            log_event({'stage':'analysis_batch','result':'saved','screenshot':str(collage.original),'size':collage.original_size,'frameCount':len(batch)})
            log_event({'stage':'analysis','result':'started','mini':str(collage.mini),'frameCount':len(batch)})
            self.check_active()
            result=self.interpreter.analyze(collage.mini,frames=frame_metadata(batch))
            observation=result if isinstance(result,ObservationResult) else None
            analysis=observation_text(observation) if observation is not None else result
            same_app=all((frame.evidence.app,frame.evidence.bundleId)==(first.app,first.bundleId) for frame in batch)
            record={'start':first.capturedAt.isoformat(timespec='seconds'),'end':last.capturedAt.isoformat(timespec='seconds'),
                    'app':'、'.join(captured_app_names({'frames':[frame.evidence.model_dump(mode='json') for frame in batch]})),
                    'bundleId':first.bundleId if same_app else None,
                    'analysis':analysis,'source':'screen','screenshot':self.memory.image_reference(collage.original),
                    'mini':self.memory.image_reference(collage.mini),'frames':[frame.evidence.model_dump(mode='json') for frame in batch]}
            if observation is not None:
                record['observation']=observation.model_dump(mode='json')
            with self.commit():
                self.anchor=self.memory.append(record)
                self.baseline_mini=batch[-1].image.mini
            self.save_time_evidence(batch)
            self.refresh_screenshot_index(first.capturedAt.date().isoformat())
            log_event({'stage':'activity','result':'appended','app':record['app'],'mini':str(collage.mini),'records':str(self.home/'records'/f'{first.capturedAt.date().isoformat()}.json'),'modelCalls':1})
            return 'analyzed'
        except Exception as error:
            self.anchor=None
            self.baseline_mini=None
            self.gaps.append({'start':first.capturedAt.isoformat(),'end':last.capturedAt.isoformat(),'reason':str(error)})
            raise

    def refresh_screenshot_index(self,day):
        """成功活动保存后刷新派生索引，刷新失败保留报告与分析成功基准。

        day 为本批采集日期；真正分析状态由已保存报告的 frames 决定。
        索引和诊断日志错误以 stderr 兜底，原活动成功事实保持成立。
        """
        try:
            rebuild_day(self.config,day)
        except (OSError,ValueError) as error:
            try:
                log_event({'stage':'screenshot_index','result':'failed','message':str(error)})
            except LogUnavailableError:
                print('截图索引刷新失败：'+str(error),file=sys.stderr)

    def save_time_evidence(self,batch):
        """原活动成功提交后补存批次依据；失败保留原活动并切断后续连续性。

        batch为已成功分析或延长的原帧；从日文件重新取得稳定行身份与签名，
        所有样本一次原子提交；错误记日志，由下一完整批从新代次继续。
        """
        samples=[self.sample_metadata.pop(str(frame.image.original),None) for frame in batch]
        samples=[sample for sample in samples if sample is not None]
        if not samples:return
        try:
            records,_=read_activities(self.home,batch[0].evidence.capturedAt.date().isoformat())
            record=next(r for r in reversed(records) if r['start']==self.anchor['start'])
            self.time_evidence.append_batch(record,samples)
        except (ValueError,OSError,StopIteration):
            self.time_evidence.generation+=1
            log_event({'stage':'time_evidence','result':'failed','message':'采样依据未提交，后续从新连续段开始'})

    def summarize(self,start,end,trigger='periodic'):
        """从已保存活动构建窗口快照，通过KMH总结后追加总结JSON。

        start/end保持调度窗口边界；提前短试跑通过manual_exit明确标识。
        无活动只记空状态；模型或保存失败向调用者传播，原活动与已有总结保持。
        快照每次由文件重建并在成功或失败后清理；输出正文保留完整模型文本。
        时间表只投影start/end/app/analysis；图片证据继续归原活动记录所有。
        """
        self.check_active()
        timeline,gaps=self.memory.window(start,end)
        for gap in self.gaps:
            if datetime.fromisoformat(gap['start'])<end and datetime.fromisoformat(gap['end'])>start:
                copy=dict(gap)
                copy['start']=max(start,datetime.fromisoformat(gap['start'])).isoformat(timespec='seconds')
                copy['end']=min(end,datetime.fromisoformat(gap['end'])).isoformat(timespec='seconds')
                gaps.append(copy)
        if not timeline:
            log_event({'stage':'summary','result':'empty','windowStart':start.isoformat(),'windowEnd':end.isoformat(),'gaps':gaps})
            return 'empty'
        timeline=[SummaryActivity.model_validate({**row,'app':'、'.join(captured_app_names(row))}).model_dump(mode='json') for row in timeline]
        folder=self.home/'kmh'
        folder.mkdir(parents=True,exist_ok=True)
        snapshot=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=folder,prefix='summary-',suffix='.json',delete=False) as stream:
                snapshot=Path(stream.name)
                json.dump({'windowStart':start.isoformat(timespec='seconds'),'windowEnd':end.isoformat(timespec='seconds'),'timeline':timeline,'gaps':gaps,'coverage':'事件与定时屏幕采样；批次首末跨度取实际采集时间，仅逐帧时点可确认，采样间隙与gaps保持未确认。'},stream,ensure_ascii=False,indent=2)
                stream.write('\n')
            log_event({'stage':'summary','result':'started','windowStart':start.isoformat(timespec='seconds'),'windowEnd':end.isoformat(timespec='seconds')})
            self.check_active()
            text=self.interpreter.summarize(snapshot)
            with self.commit():
                path=self.memory.save_summary({'windowStart':start.isoformat(timespec='seconds'),'windowEnd':end.isoformat(timespec='seconds'),'generatedAt':datetime.now(start.tzinfo).isoformat(timespec='seconds'),'timeline':timeline,'gaps':gaps,'summary':text,'trigger':trigger})
            log_event({'stage':'summary','result':'saved','summary':str(path),'trigger':trigger,'windowStart':start.isoformat(),'windowEnd':end.isoformat()})
            return 'saved'
        finally:
            if snapshot is not None:
                snapshot.unlink(missing_ok=True)

    def summary_tick(self,elapsed,started):
        """按启动配置的周期处理最近已关闭窗口，同一窗口只处理一次。

        elapsed取单调时钟，生成耗时保持原窗口边界；跨过多个周期时记录跳过数量。
        提前标记处理窗口，使失败也由后续周期继续，历史补算由后续能力承接。
        """
        interval=self.config.summaryIntervalSeconds
        index=int(elapsed//interval)
        if index<=self.closed_window:
            return
        if index>self.closed_window+1:
            log_event({'stage':'summary','result':'missed_windows','count':index-self.closed_window-1})
        self.closed_window=index
        start=started+timedelta(seconds=(index-1)*interval)
        self.summarize(start,start+timedelta(seconds=interval))

def run_activity(home=None,interval=None,count=None,summary_on_exit=False,model_timeout=None,*,config=None,capture_only=False):
    """运行单个持锁采集进程，分析开关在本进程内生效。

    控制线程只切换意图、取消模型并通知停止；本线程独占批次、基准与正式JSON提交。
    关闭后旧代次结果结束，原图保留；新段先补当天积压，再消费实时新图并重新计总结周期。
    返回0为正常完成（含用户取消），失败记日志并返回1；全部退出路径清理控制socket。
    """
    runtime_logging.initialize_logging()
    settings=(config or load_config()).with_overrides(home=home,sampleIntervalSeconds=interval,captureCount=count,modelTimeoutSeconds=model_timeout)
    if capture_only and summary_on_exit:
        raise ValueError('仅采集模式与退出总结分别运行')
    home,interval,count=settings.home,settings.sampleIntervalSeconds,settings.captureCount
    home.mkdir(parents=True,exist_ok=True)
    stop=threading.Event()
    source=engine=control=queue=None
    capture_run_id=str(uuid4())

    def stop_production():
        """只通知生产结束，供信号和本地控制共用，短提交仍由主线程收口。"""
        stop.set()
        if source is not None:
            source.request_stop()

    def cancel_model(model):
        """信号处理器把有等待的模型清理交给独立线程，错误进入日志。"""
        try:
            model.cancel(timeout=settings.control.timeoutSeconds)
        except RuntimeError as error:
            log_event({'stage':'control','result':'failed','message':str(error)})

    def request_stop(signum,frame):
        """系统停止信号关闭入口并异步取消在途模型，避免信号重入Popen锁。"""
        stop_production()
        if control is not None:
            control.request_stop()
            model=control.interpreter
            if callable(getattr(model,'cancel',None)):
                threading.Thread(target=cancel_model,args=(model,),daemon=True).start()

    previous={number:signal.signal(number,request_stop) for number in (signal.SIGINT,signal.SIGTERM)}
    try:
        with (home/'observer.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with RuntimeControl(home,not capture_only,settings.control,stop_production) as control:
                if not stop.is_set() and not permissions.screen_capture_allowed():
                    log_event({'stage':'permission','result':'requesting'})
                    permissions.request_screen_capture_access()
                started=datetime.now().astimezone().replace(microsecond=0)
                initial_day=started.date().isoformat()
                try:
                    initial_pending=pending_images(settings,initial_day) if not capture_only else []
                except (OSError,ValueError) as error:
                    initial_pending=None
                    log_event({'stage':'analysis_queue','result':'failed','day':initial_day,
                               'message':'积压核对失败，采集继续：'+str(error)})
                monotonic_start=time.monotonic()
                log_event({'stage':'activity_observer','result':'started','home':str(home),'scope':'多屏缓存、交互选屏、原分辨率JPEG候选','intervalSeconds':interval,'summaryIntervalSeconds':settings.summaryIntervalSeconds,'profile':settings.kmhProfile,'effectiveConfig':settings.model_dump(mode='json')})
                attempts=failures=0
                last_generation=None
                segment_epoch=None
                with SensingCollector(settings,app_provider=frontmost_application) as source:
                    while not stop.is_set() and (count==0 or attempts<count):
                        loop_start=time.monotonic()
                        control.changed.clear()
                        enabled,epoch,since,cancelled=control.snapshot()
                        if segment_epoch!=epoch:
                            if engine is not None:
                                if queue is not None:
                                    queue.finish(engine,'分析开关变化，未满批原图保留')
                                engine.discard_pending('分析开关变化，原图保留')
                            engine=None
                            queue=None
                            if segment_epoch is not None:
                                started=datetime.now().astimezone().replace(microsecond=0)
                                monotonic_start=time.monotonic()
                            segment_epoch=epoch
                            if enabled:
                                interpreter=KMHInterpreter(home,config=settings,cancel_event=cancelled)
                                try:
                                    control.set_interpreter(interpreter,epoch)
                                except AnalysisCancelled:
                                    continue
                                except RuntimeError as error:
                                    # 原任务仍由控制器持有，收口失败时保持可重试并继续接收停止。
                                    segment_epoch=None
                                    failures+=1
                                    log_event({'stage':'control','result':'failed','message':str(error)})
                                    control.changed.wait(settings.control.pollSeconds)
                                    continue
                                engine=ActivityPipeline(home,interpreter,config=settings,control=control,epoch=epoch)
                                queue_day=datetime.now().astimezone().date().isoformat()
                                queue=ScreenshotQueue(settings,queue_day,
                                    backlog=initial_pending if epoch==0 and queue_day==initial_day else None)
                                log_event({'stage':'analysis_queue','result':'started','day':queue_day,
                                           'backlogCount':len(queue.backlog),'message':'按最早未分析截图先补积压'})
                        try:
                            candidate=source.next_candidate(timeout=min(1/settings.scening.captureFps,settings.control.pollSeconds))
                        except Exception as error:
                            failures+=1
                            log_event({'stage':'scening','result':'failed','message':str(error)})
                            break
                        for event in source.drain_status():
                            log_event(event)
                            if event.get('result')=='queue_dropped' and queue is not None:
                                try:
                                    queue.rescan_backlog()
                                except (OSError,ValueError) as error:
                                    log_event({'stage':'analysis_queue','result':'failed','message':str(error)})
                            if event.get('discontinuity') and engine is not None:
                                engine.reset(event['message'])
                                end=event['at']
                                engine.gaps.append({'start':event.get('droppedAt',end),'end':end,'reason':event['message']})
                            if event['result'] in ('capture_failed','round_failed'):
                                failures+=1
                        if candidate is not None:
                            generation=getattr(candidate,'generation',0)
                            if engine is not None and last_generation is not None and generation!=last_generation:
                                engine.reset('采集中断代次变化')
                            last_generation=generation
                            saved=candidate.saved
                            at=saved.at.replace(microsecond=0)
                            prepared=candidate.prepared
                            try:
                                save_capture(settings,candidate,capture_run_id)
                            except (OSError,ValueError) as error:
                                log_event({'stage':'capture_metadata','result':'failed','message':str(error)})
                            log_event({'stage':'candidate','result':'started','round':attempts+1,'capturedAt':saved.at.isoformat()})
                            try:
                                log_event({'stage':'image_prepare','result':'saved','mode':'scening_candidate','screenshot':str(prepared.original),'mini':str(prepared.mini),'originalSize':prepared.original_size,'miniSize':prepared.mini_size,'display':saved.display.index,'reason':candidate.reason})
                                if engine is not None and not stop.is_set() and (epoch==0 or saved.at>=since):
                                    # 兼容显式交付的历史候选；当前日期统一由持久原图队列选择。
                                    if at.date().isoformat()!=queue.day and at.date()!=datetime.now().astimezone().date():
                                        with analysis_lock(settings,at.date().isoformat(),cancel_event=cancelled,wait=True):
                                            engine.process(prepared,at,saved.app,saved.bundle_id,screen=saved.display.index,sample_sequence=candidate.sample_sequence,continuity=candidate.generation)
                            except AnalysisCancelled:
                                if engine is not None:
                                    engine.reset('用户取消分析，原图保留')
                                log_event({'stage':'analysis','result':'cancelled','message':'用户取消当前分析，原图和拼图保留'})
                            except LogUnavailableError:
                                raise
                            except Exception as error:
                                failures+=1
                                if engine is not None:
                                    engine.reset('候选处理失败')
                                    end=datetime.now(started.tzinfo).replace(microsecond=0)
                                    engine.gaps.append({'start':at.isoformat(),'end':end.isoformat(),'reason':str(error)})
                                log_event({'stage':'activity_pipeline','result':'failed','message':str(error)})
                            attempts+=1
                        try:
                            if engine is not None and not stop.is_set():
                                current_day=datetime.now().astimezone().date().isoformat()
                                if queue.day!=current_day and not queue.backlog:
                                    queue.finish(engine,'跨日，前日未满批原图保留')
                                    queue=ScreenshotQueue(settings,current_day,backlog=[])
                                    engine.reset('跨日，实时新图重新满批')
                                try:
                                    queue_result=queue.step(engine,cancel_event=cancelled)
                                    if queue_result not in ('waiting','busy','blocked','waiting_retry'):
                                        log_event({'stage':'analysis_queue','result':queue_result,'day':queue.day,
                                                   'backlogCount':len(queue.backlog)})
                                except AnalysisCancelled:
                                    raise
                                except (OSError,ValueError,RuntimeError) as error:
                                    failures+=1
                                    engine.reset('分析队列失败，保留待分析原图')
                                    log_event({'stage':'analysis_queue','result':'failed','message':str(error),
                                               'day':queue.day,'retry':queue.retry_hint()})
                                engine.check_active()
                                engine.summary_tick(time.monotonic()-monotonic_start,started)
                        except AnalysisCancelled:
                            log_event({'stage':'analysis','result':'cancelled','message':'分析队列已取消，未提交原图保留'})
                        except LogUnavailableError:
                            raise
                        except Exception as error:
                            failures+=1
                            log_event({'stage':'summary','result':'failed','message':str(error)})
                        if candidate is not None and not stop.is_set() and not (count and attempts>=count):
                            control.changed.wait(max(0,interval-(time.monotonic()-loop_start)))
                if engine is not None:
                    if queue is not None:
                        queue.finish(engine,'运行结束，未满批原图保留')
                    engine.discard_pending('运行结束，未满批原图保留')
                if summary_on_exit and engine is not None and not stop.is_set():
                    end=datetime.now(started.tzinfo).replace(microsecond=0)
                    start=started+timedelta(seconds=engine.closed_window*settings.summaryIntervalSeconds)
                    if end>start:
                        try:
                            engine.summarize(start,end,'manual_exit')
                        except AnalysisCancelled:
                            pass
                        except LogUnavailableError:
                            raise
                        except Exception as error:
                            failures+=1
                            log_event({'stage':'summary','result':'failed','message':str(error),'trigger':'manual_exit'})
                log_event({'stage':'activity_observer','result':'stopped','attempts':attempts,'failures':failures})
                control.finish()
                return 1 if failures else 0
    finally:
        try:
            if engine is not None:
                engine.discard_pending('运行退出，未满批原图保留')
        finally:
            for number,handler in previous.items():
                signal.signal(number,handler)

def main(argv=None):
    """解析手动运行参数，完整链路通过项目.venv中的Python启动。

    --count限制尝试轮数，--summary-on-exit标记短试跑的提前总结。
    默认参数从observer.yaml读取，--config选择完整配置；CLI显式参数临时覆盖。
    返回运行退出码，配置错误在采集前记录并返回2，日志失败以stderr兜底。
    """
    parser=argparse.ArgumentParser(description='多屏感知、JPEG候选、KMH理解与每日JSON活动记忆')
    parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG_PATH,help='完整配置YAML文件（兼容显式JSON）')
    parser.add_argument('--home',type=Path,help='临时覆盖活动数据根目录')
    parser.add_argument('--screenshot-dir',type=Path,help='临时覆盖截图根目录，正式图片保存在采集日期子目录')
    parser.add_argument('--interval',type=float,help='临时覆盖候选消费的最小开始间隔，秒')
    parser.add_argument('--summary-interval',type=float,help='临时覆盖总结周期，秒')
    parser.add_argument('--count',type=int,help='临时覆盖消费候选的轮数，0表示持续运行')
    parser.add_argument('--difference-threshold',type=float,help='临时覆盖画面变化阈值')
    parser.add_argument('--capture-timeout',type=float,help='临时覆盖首份有效候选等待超时，秒')
    parser.add_argument('--model-timeout',type=float,help='临时覆盖模型超时，秒')
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument('--summary-on-exit',action='store_true',help='短试跑结束后生成明确标记的提前总结')
    modes.add_argument('--capture-only',action='store_true',help='仅采集选图并保存JPEG；常规模式提供分析、记录和总结')
    try:
        runtime_logging.initialize_logging()
        try:
            args=parser.parse_args(argv)
        except SystemExit as error:
            if error.code:
                log_event({'stage':'arguments','result':'failed','message':'活动观察参数解析失败'})
            return int(error.code or 0)
        try:
            settings=load_config(args.config,home=args.home,screenshotDir=args.screenshot_dir,sampleIntervalSeconds=args.interval,summaryIntervalSeconds=args.summary_interval,captureCount=args.count,differenceThreshold=args.difference_threshold,captureTimeoutSeconds=args.capture_timeout,modelTimeoutSeconds=args.model_timeout)
        except ValueError as error:
            log_event({'stage':'configuration','result':'failed','message':str(error)})
            print(str(error),file=sys.stderr)
            return 2
        return run_activity(config=settings,summary_on_exit=args.summary_on_exit,capture_only=args.capture_only)
    except (OSError,ValueError,RuntimeError) as error:
        try:
            log_event({'stage':'activity_observer','result':'failed','message':str(error)})
        except LogUnavailableError:
            pass
        print('活动观察结束：'+str(error),file=sys.stderr)
        return 1

if __name__=='__main__':
    raise SystemExit(main())
