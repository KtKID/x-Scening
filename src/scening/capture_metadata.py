"""正式截图的采集事实旁文件；分析成功状态继续由报告frames拥有。"""
from pathlib import Path
from typing import Optional
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from scening.task_store import atomic_save


class CaptureMetadata(BaseModel):
    """采集端唯一元信息契约，仅由Python消费，完整保留原时区与系统应用。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    file: str
    capturedAt: AwareDatetime
    screen: int = Field(gt=0)
    app: Optional[str]
    bundleId: Optional[str]
    runId: str = Field(min_length=1)
    generation: int = Field(ge=0)
    sampleSequence: Optional[int] = Field(default=None, ge=1)


def metadata_path(image):
    """返回JPEG同目录的明确旁文件名，原图名称和像素保持原值。"""
    image = Path(image)
    return image.with_name(image.name + '.metadata.json')


def save_capture(config, candidate, run_id):
    """原图完整保存后、候选入队前原子保存采集事实。

    参数为启动配置、Candidate和采集运行ID；只写同名metadata.json，已有旁文件保留。
    路径越界、契约或IO失败传播，由采集线程记录；正式原图始终保留。
    """
    saved = candidate.saved
    image = saved.path.resolve()
    root = config.screenshotDir.resolve()
    relative = image.relative_to(root).as_posix()
    path = metadata_path(image)
    if path.exists():
        return
    doc = CaptureMetadata(file=relative, capturedAt=saved.at, screen=saved.display.index,
                          app=saved.app, bundleId=saved.bundle_id, runId=run_id,
                          generation=candidate.generation, sampleSequence=candidate.sample_sequence)
    atomic_save(path, doc)


def read_capture(config, image):
    """只读校验采集旁文件；旧图缺项或坏文件返回None，原件保持。

    核对原图与旁文件均位于截图根、文件引用和采集日期/秒与文件名一致；
    调用方另行核对屏幕编号。返回CaptureMetadata或None，不推断系统应用。
    """
    root = config.screenshotDir.resolve()
    image = Path(image).resolve()
    path = metadata_path(image)
    try:
        if not image.is_relative_to(root) or not path.resolve().is_relative_to(root):
            return None
        doc = CaptureMetadata.model_validate_json(path.read_text())
        stamp = doc.capturedAt.strftime('%Y-%m-%d_%H-%M-%S')
        if doc.file != image.relative_to(root).as_posix() or not image.name.startswith(stamp + '_m' + str(doc.screen) + '_'):
            return None
        return doc
    except (OSError, ValueError):
        return None
