"""真实MSS→内存OCR→文件提交验证，并从阶段日志导出回放夹具。

运行：PYTHONPATH=src .venv/bin/python scripts/verify_memory_ocr_e2e.py
屏幕短暂展示受控测试页；取帧与Vision均执行真实代码。图片只含本脚本生成的
普通文本或合成密钥，采集/提交使用独占tmp；夹具输出至tests/fixtures。
"""
import argparse
from dataclasses import asdict
from datetime import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import platform
import tempfile
import time
from unittest.mock import patch

from scening.app_identity import application_for_pid
from scening.capture import NativeBackend
from scening.collector import SensingCollector
from scening.observer_config import load_config
from scening import sensitive_guard

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT/'tests/fixtures/memory_ocr_native'
REPORT = ROOT/'reports/memory-ocr-e2e-20261104/evidence'
CASES = [
    {'id': 'allowed', 'lines': ['Observer OCR E2E', 'Today is a quiet day.'],
     'expected': {'blocked': False, 'reason': 'clean', 'hits': [], 'beforeJpegs': 0,
                  'afterJpegs': 1, 'afterMetadata': 1, 'candidates': 1}},
    {'id': 'sensitive', 'lines': ['Observer OCR E2E', 'sk-proj-demo'],
     'expected': {'blocked': True, 'reason': 'content', 'hits': ['openai-key'], 'beforeJpegs': 0,
                  'afterJpegs': 0, 'afterMetadata': 0, 'candidates': 0}},
]


def write_json(path, value):
    """把受控测试数据写入明确位置，保留中文与真实层次结构。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def files(root):
    """枚举隔离截图目录实际文件，路径统一为目录内相对路径。"""
    return sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file())


def export_fixture(log_path, output):
    """从实录JSONL组装fixture，预期取运行前声明，实际结果独立保留。

    日志中的配置、采集身份、OCR行与图片哈希作为回放输入；expected来自case_plan，
    测试继续按独立手写契约校验。输入图片由真实采集步骤完成安全检查后保存。
    """
    events = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]
    session = next(e for e in events if e['event'] == 'session')
    cases = []
    for plan in (e for e in events if e['event'] == 'case_plan'):
        case_id = plan['case']
        selected = [e for e in events if e.get('case') == case_id]
        capture = next(e for e in selected if e['event'] == 'capture')
        ocr = next(e for e in selected if e['event'] == 'ocr_return')
        enter = next(e for e in selected if e['event'] == 'ocr_enter')
        saved = next(e for e in selected if e['event'] == 'after_publish')
        cases.append({'id': case_id, 'input': capture['input'], 'ocrLines': ocr['lines'],
                      'jpegSha256': enter['jpegSha256'], 'expected': plan['expected'],
                      'observed': saved['observed']})
    assert len(cases) == 2 and {c['id'] for c in cases} == {'allowed', 'sensitive'}
    output.parent.mkdir(parents=True, exist_ok=True)
    (output.parent/'events.jsonl').write_text(log_path.read_text())
    write_json(output, {'schemaVersion': 1, 'source': session['source'],
                        'config': session['config'], 'cases': cases})


def native_ui():
    """创建覆盖所有显示器的受控原生页，返回更新与恢复函数。

    显示器内容只含本脚本固定文本；结束后关闭自有窗口并恢复此前前台应用。
    """
    import AppKit as A
    import Foundation as F
    import Quartz

    app = A.NSApplication.sharedApplication()
    prior = A.NSWorkspace.sharedWorkspace().frontmostApplication()
    app.setActivationPolicy_(A.NSApplicationActivationPolicyRegular)

    class OCRFixtureView(A.NSView):
        def drawRect_(self, rect):
            A.NSColor.colorWithSRGBRed_green_blue_alpha_(246/255, 243/255, 237/255, 1).setFill()
            A.NSBezierPath.fillRect_(self.bounds())
            attributes = {A.NSFontAttributeName: A.NSFont.monospacedSystemFontOfSize_weight_(42, A.NSFontWeightRegular),
                          A.NSForegroundColorAttributeName: A.NSColor.blackColor()}
            for index, line in enumerate(getattr(self, 'lines', [])):
                F.NSString.stringWithString_(line).drawAtPoint_withAttributes_(
                    (80, self.bounds().size.height/2-index*80), attributes)

    windows, views = [], []
    for screen in A.NSScreen.screens():
        window = A.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            screen.frame(), A.NSWindowStyleMaskBorderless, A.NSBackingStoreBuffered, False)
        window.setReleasedWhenClosed_(False)
        window.setLevel_(Quartz.CGWindowLevelForKey(Quartz.kCGScreenSaverWindowLevelKey))
        window.setCollectionBehavior_(A.NSWindowCollectionBehaviorCanJoinAllSpaces | A.NSWindowCollectionBehaviorFullScreenAuxiliary)
        view = OCRFixtureView.alloc().initWithFrame_(((0, 0), screen.frame().size))
        window.setContentView_(view)
        windows.append(window)
        views.append(view)

    def show(lines):
        for window, view in zip(windows, views):
            view.lines = lines
            view.setNeedsDisplay_(True)
            window.orderFrontRegardless()
            window.displayIfNeeded()
        app.activateIgnoringOtherApps_(True)
        until = time.monotonic()+.5
        while time.monotonic() < until:
            event = app.nextEventMatchingMask_untilDate_inMode_dequeue_(
                A.NSEventMaskAny, F.NSDate.dateWithTimeIntervalSinceNow_(.02), F.NSDefaultRunLoopMode, True)
            if event is not None:
                app.sendEvent_(event)
            app.updateWindows()

    def close():
        for window in windows:
            window.orderOut_(None)
            window.close()
        if prior is not None:
            prior.activateWithOptions_(A.NSApplicationActivateIgnoringOtherApps)

    return show, close


def verify_background(image):
    """核对截图四角由受控页覆盖，异常时只报类别并保留图片于内存。"""
    expected = (246, 243, 237)
    # macOS在右上角显示系统取屏状态图标，检查点内缩以覆盖受控页背景。
    points = [(64, 64), (image.width-65, 64), (64, image.height-65), (image.width-65, image.height-65)]
    assert all(max(abs(a-b) for a,b in zip(image.getpixel(p), expected)) <= 20 for p in points), '受控页覆盖检查失败'


def run():
    """记录两条真实采集链，逐阶段核对文件状态，最后从日志导出回放输入。"""
    REPORT.mkdir(parents=True, exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    log_path = REPORT/'native-events.jsonl'
    show, close = native_ui()
    events = []

    def emit(event, **fields):
        row = {'event': event, **fields}
        events.append(row)
        log_path.write_text(''.join(json.dumps(item, ensure_ascii=False)+'\n' for item in events))

    config = load_config()
    state_probe = NativeBackend(config.scening.shutdownTimeoutSeconds)
    actual_idle = state_probe.idle_seconds()
    settings = config.scening.model_dump()
    # 单轮受控验证把真实空闲值纳入阈值，确保观察分支可执行；生产配置文件保持原值。
    settings['sensingIdleSeconds'] = max(settings['sensingIdleSeconds'], actual_idle+settings['observationIntervalSeconds'])
    settings['recentActivityPaddingSeconds'] = max(settings['recentActivityPaddingSeconds'], actual_idle)
    config = config.with_overrides(scening=settings)
    paths = ['src/scening/capture.py', 'src/scening/collector.py', 'src/scening/frame_store.py', 'src/scening/sensitive_guard.py']
    emit('session', source={'kind': 'native-mss-real-vision-controlled-page', 'recordedAt': datetime.now().astimezone().isoformat(),
                            'platform': platform.platform(), 'sourceSha256': {p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths},
                            'scope': 'periodic collector tick, real native pixels and OCR; test process OS application identity'},
         config={'privacy': config.privacy.model_dump(), 'scening': settings})
    try:
        for plan in CASES:
            show(plan['lines'])
            emit('case_plan', case=plan['id'], expected=plan['expected'])
            with tempfile.TemporaryDirectory(prefix='native-ocr-e2e-', dir=ROOT/'tmp') as temporary:
                case_config = config.with_overrides(home=Path(temporary)/'home', screenshotDir=Path(temporary)/'shots')
                backend = NativeBackend(config.scening.shutdownTimeoutSeconds)
                identity = application_for_pid(os.getpid())
                collector = SensingCollector(case_config, backend=backend, app_provider=lambda *_: identity)
                verdicts, ocr_results = [], []
                real_ocr = sensitive_guard.ocr_lines
                real_evaluate = collector.guard.evaluate
                real_grab = backend.grab
                jpeg_inputs = []

                def observe_grab(display):
                    image = real_grab(display)
                    try:
                        verify_background(image)
                    except BaseException:
                        image.close()
                        raise
                    emit('native_grab', case=plan['id'], screen=display.index, width=image.width, height=image.height,
                         beforeJpegs=len(list(case_config.screenshotDir.rglob('*.jpg'))))
                    return image

                def observe_ocr(source):
                    assert isinstance(source, bytes)
                    assert not list(case_config.screenshotDir.rglob('*.jpg'))
                    jpeg_inputs.append(source)
                    emit('ocr_enter', case=plan['id'], beforeJpegs=0, inputType='bytes',
                         jpegSha256=hashlib.sha256(source).hexdigest())
                    lines = real_ocr(source)
                    normalize = lambda value: ''.join(value.casefold().split())
                    assert len(lines) == len(plan['lines']) and all(
                        max(difflib.SequenceMatcher(None, normalize(line), normalize(known)).ratio()
                            for known in plan['lines']) > .8 for line in lines), 'OCR返回超出受控测试文本范围'
                    ocr_results.append(lines)
                    emit('ocr_return', case=plan['id'], lines=lines)
                    return lines

                def observe_verdict(*args, **kwargs):
                    verdict = real_evaluate(*args, **kwargs)
                    verdicts.append(verdict)
                    emit('verdict', case=plan['id'], blocked=verdict.blocked, reason=verdict.reason, hits=list(verdict.hits))
                    return verdict

                try:
                    now = time.monotonic()
                    collector._refresh(now)
                    collector._last_monitor = collector._displays[0].index
                    with patch('scening.sensitive_guard.ocr_lines', side_effect=observe_ocr), \
                         patch.object(collector.guard, 'evaluate', side_effect=observe_verdict), \
                         patch.object(backend, 'grab', side_effect=observe_grab):
                        collector.tick(now)
                    assert len(verdicts) == len(ocr_results) == 1, '真实OCR调用数量异常'
                    selected = collector._frames[collector._last_monitor]
                    verify_background(selected.image)
                    verdict = verdicts[0]
                    observed = {'blocked': verdict.blocked, 'reason': verdict.reason, 'hits': list(verdict.hits),
                                'beforeJpegs': 0, 'afterJpegs': len(list(case_config.screenshotDir.rglob('*.jpg'))),
                                'afterMetadata': len(list(case_config.screenshotDir.rglob('*.metadata.json'))),
                                'candidates': collector.candidates.qsize()}
                    assert observed == plan['expected'], f"{plan['id']}原定预期与实际结果不符"
                    if observed['afterJpegs']:
                        saved = next(case_config.screenshotDir.rglob('*.jpg'))
                        assert saved.read_bytes() == jpeg_inputs[0]
                    emit('after_publish', case=plan['id'], observed=observed, files=files(case_config.screenshotDir))
                    # 受控内容及结果核对成功后，把真实原始像素保存为lossless回放输入。
                    path = FIXTURES/(plan['id']+'.png')
                    selected.image.save(path, 'PNG')
                    emit('capture', case=plan['id'], input={'image': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                         'capturedAt': selected.at.isoformat(), 'display': asdict(selected.display),
                         'app': selected.app, 'bundleId': selected.bundle_id})
                finally:
                    collector.close()
        export_fixture(log_path, FIXTURES/'recording.json')
        emit('completed', cases=2, fixture='tests/fixtures/memory_ocr_native/recording.json')
    finally:
        close()
    print(json.dumps({'passed': 2, 'log': log_path.relative_to(ROOT).as_posix(),
                      'fixture': 'tests/fixtures/memory_ocr_native/recording.json'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export-only', action='store_true')
    arguments = parser.parse_args()
    if arguments.export_only:
        export_fixture(REPORT/'native-events.jsonl', FIXTURES/'recording.json')
    else:
        run()
