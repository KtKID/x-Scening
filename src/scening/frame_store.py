"""事件 JPEG 与正式候选的唯一保存入口，保留原分辨率编码方式。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import itertools
import io
import os
from pathlib import Path
import shutil
import tempfile
from typing import BinaryIO, Callable, Iterator, Optional, Tuple

from PIL import Image

from scening.capture import Display, Frame

@dataclass(frozen=True)
class PreparedImage:
    """已保存 JPEG 的下游契约，两个历史路径与尺寸同指正式候选。"""
    original: Path
    mini: Path
    original_size: Tuple[int, int]
    mini_size: Tuple[int, int]


def image_candidates(directory: Path, timestamp: datetime, label: str) -> Iterator[Path]:
    """在显式截图目录生成秒级 JPEG 名称，同秒冲突时追加顺序号。

    参数 directory 为当前事件或正式截图目录，timestamp 为采集时间，label 为屏幕/用途。
    创建所选目录，已存在的文件名跳过；排他提交由调用者完成，原文件保持原值。
    返回候选路径迭代器；非法标记抛 ValueError，目录创建错误原样传播。
    """
    if not label or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in label):
        raise ValueError('图片标记无效')
    directory.mkdir(parents=True, exist_ok=True)
    stamp = timestamp.strftime('%Y-%m-%d_%H-%M-%S') + '_' + label
    for number in itertools.count():
        suffix = '' if number == 0 else '_{:03d}'.format(number)
        target = directory / (stamp + suffix + '.jpg')
        if not target.exists():
            yield target


def commit_exclusive(target: Path, write: Callable[[BinaryIO], None]) -> None:
    """完整写入同目录临时文件，再通过硬链接排他发布正式 JPEG。

    参数 target 为最终位置，write 向二进制流写入完整编码或原图字节。
    已有目标抛 FileExistsError，写入和发布失败原样传播；临时文件始终清理，历史文件保留。
    """
    temporary = tempfile.NamedTemporaryFile(
        dir=target.parent, prefix='.' + target.stem + '-', suffix='.tmp', delete=False)
    temporary_path = Path(temporary.name)
    try:
        with temporary:
            write(temporary)
        os.link(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)


@dataclass(frozen=True)
class SavedFrame:
    """已提交文件和采集元信息；应用身份与时间均来自帧采集时刻。"""
    path: Path
    at: datetime
    display: Display
    size: Tuple[int, int]
    app: Optional[str]
    bundle_id: Optional[str]

    def open_image(self):
        """只读打开正式或兼容文件，调用方通过上下文关闭Pillow图片。"""
        return Image.open(self.path)


@dataclass(frozen=True)
class BufferedFrame:
    """本轮独占的内存JPEG快照；采集身份与字节一同冻结，释放引用即回收。"""
    jpeg: bytes
    at: datetime
    display: Display
    size: Tuple[int, int]
    app: Optional[str]
    bundle_id: Optional[str]

    def open_image(self):
        """从压缩快照解码用于选图比较，调用方通过上下文关闭图片。"""
        return Image.open(io.BytesIO(self.jpeg))


@dataclass(frozen=True)
class Candidate:
    """向现有单图活动入口交付的候选，两个历史图片字段引用同一文件。"""
    saved: SavedFrame
    reason: str
    generation: int = 0
    sample_sequence: Optional[int] = None
    screenshot_dir: Optional[Path] = None

    @property
    def prepared(self):
        """适配原 PreparedImage 契约，正式 JPEG 保持采集像素尺寸。"""
        frame = self.saved
        return PreparedImage(frame.path, frame.path, frame.size, frame.size)


class FrameStore:
    """管理内存事件JPEG与正式图片提交，兼容显式文件工具入口。"""

    def __init__(self, screenshot_dir, quality):
        """使用显式截图目录建立独占事件目录，编码质量沿用启动快照。

        参数 screenshot_dir 来自配置，quality 为 JPEG 质量；目录创建失败时原样上抛。
        实时事件由stage暂存内存；兼容save入口独占临时目录，正式图按采集日期归档。
        """
        self.set_screenshot_directory(screenshot_dir)
        self._temporary = tempfile.TemporaryDirectory(prefix='.events-', dir=self.screenshot_dir)
        self.event_home = Path(self._temporary.name)
        self.quality = quality

    def set_screenshot_directory(self, screenshot_dir):
        """准备正式 JPEG 目录后采用新路径；目录创建失败时保留原有存储状态。

        screenshot_dir 为已解析的配置路径。已发布文件和本次运行的事件暂存保持原位置。
        """
        directory = Path(screenshot_dir).resolve()
        directory.mkdir(parents=True, exist_ok=True)
        self.screenshot_dir = directory

    def stage(self, frame: Frame) -> BufferedFrame:
        """将借用帧编码为独立的内存JPEG，供事件比较及隐私检查。

        参数frame为采集缓存帧；返回拥有压缩字节及采集元信息的BufferedFrame。
        编码沿用配置质量和原分辨率；源图片保持原值，编码失败原样上抛。
        本函数的副作用仅为内存分配；正式文件由检查通过后的promote提交。
        """
        image = frame.image.convert('RGB')
        try:
            with io.BytesIO() as output:
                image.save(output, 'JPEG', quality=self.quality, optimize=True)
                return BufferedFrame(output.getvalue(), frame.at, frame.display, image.size,
                                     frame.app, frame.bundle_id)
        finally:
            image.close()

    def save(self, frame: Frame, tag: str, *, temporary=True):
        """按采集时间排他保存 RGB JPEG，成功返回元信息，失败保留已有正式文件。

        参数 frame 为借用的缓存帧；tag 为固定程序标记；temporary 区分事件图和正式图。
        完整编码至同目录临时文件后排他提交；同秒重名重新选名；其他写入错误上抛。
        """
        image = frame.image.convert('RGB')
        try:
            directory = self.event_home if temporary else self.screenshot_dir / frame.at.date().isoformat()
            for path in image_candidates(directory, frame.at, f'm{frame.display.index}_{tag}'):
                try:
                    commit_exclusive(path, lambda output: image.save(output, 'JPEG', quality=self.quality, optimize=True))
                except FileExistsError:
                    continue
                return SavedFrame(path, frame.at, frame.display, image.size, frame.app, frame.bundle_id)
        finally:
            image.close()

    def promote(self, saved, reason):
        """把已通过隐私检查的快照排他提交为正式JPEG，成功返回SavedFrame。

        saved为内存BufferedFrame或兼容文件SavedFrame；reason用于文件名。
        完整字节提交后才返回，编码内容保持原值；写入失败传播并清理提交临时名。
        本函数负责文件提交，判定与停止检查由实时调用方先完成。
        """
        directory = self.screenshot_dir / saved.at.date().isoformat()
        for path in image_candidates(directory, saved.at, f'm{saved.display.index}_{reason}'):
            try:
                def copy(output):
                    if isinstance(saved, BufferedFrame):
                        output.write(saved.jpeg)
                    else:
                        with saved.path.open('rb') as source:
                            shutil.copyfileobj(source, output)
                commit_exclusive(path, copy)
            except FileExistsError:
                continue
            return SavedFrame(path, saved.at, saved.display, saved.size, saved.app, saved.bundle_id)

    def discard(self, saved):
        """清理兼容临时文件；内存帧由调用方释放引用，正式候选保持原值。"""
        if isinstance(saved, SavedFrame) and self.event_home in saved.path.resolve().parents:
            saved.path.unlink(missing_ok=True)

    def close(self):
        """退出时清理本次临时事件图，正式 JPEG 与历史 home 文件继续保留。"""
        self._temporary.cleanup()
