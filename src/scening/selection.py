"""相邻操作画面比较与末段选图，修复原分段的末项覆盖问题。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

from PIL import ImageChops, ImageStat

from scening.frame_store import BufferedFrame, SavedFrame


@dataclass
class Action:
    """一次完成的点击、滚动或连续键盘输入的首尾截图。"""
    before: Optional[Union[BufferedFrame, SavedFrame]]
    after: Optional[Union[BufferedFrame, SavedFrame]]
    kind: str


def image_difference(before, after, missing_difference):
    """返回 RGB 平方差总和/像素数。

    参数为两份内存或文件JPEG快照和配置的缺图分数；缺图、坏图或尺寸变化返回该分数。
    快照只读，Pillow 的逐通道平方和避免构造完整浮点数组。
    """
    if before is None or after is None:
        return missing_difference
    try:
        with before.open_image() as left, after.open_image() as right:
            if left.size != right.size:
                return missing_difference
            a, b = left.convert('RGB'), right.convert('RGB')
            try:
                with ImageChops.difference(a, b) as difference:
                    return sum(ImageStat.Stat(difference).sum2) / (a.width * a.height)
            finally:
                a.close()
                b.close()
    except (OSError, ValueError):
        return missing_difference


def segment_actions(actions, threshold, stable_comparisons, missing_difference):
    """按大差异衔接边界分段，返回片段、各衔接分数与稳定片段数。

    每个比较属于前后两条操作之间的边；切片在边后结束并显式追加尾段。
    参数分别为操作列表、分段阈值、稳定比较次数及缺图分数，数值均来自启动配置。
    所有操作恰好覆盖一次，单条操作单独成段。稳定标记需要连续至少配置次低差异。
    此函数只读JPEG快照；选图始终由末段末条 after 提供，持续变化也可以产生候选。
    """
    if not actions:
        return [], [], 0
    scores = [image_difference(left.after, right.before, missing_difference)
              for left, right in zip(actions, actions[1:])]
    segments = []
    stable_count = 0
    start = 0
    for index, score in enumerate(scores):
        if score > threshold:
            segments.append(actions[start:index + 1])
            if index - start >= stable_comparisons and all(value < threshold for value in scores[start:index]):
                stable_count += 1
            start = index + 1
    segments.append(actions[start:])
    if len(actions) - start - 1 >= stable_comparisons and all(value < threshold for value in scores[start:]):
        stable_count += 1
    return segments, scores, stable_count
