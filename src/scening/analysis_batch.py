"""已保存候选的三帧拼图：只读原图，完整且排他提交派生JPEG。"""
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from scening.activity_memory import ActivityFrame
from scening.frame_store import PreparedImage, commit_exclusive, image_candidates

# 固定的图片呈现格式；业务数值由observer.yaml中的analysis块提供。
BACKGROUND = (20, 22, 26)
LABEL_BACKGROUND = (246, 241, 232)
LABEL_FOREGROUND = (36, 40, 46)
LABEL_MARGIN = 8


@dataclass(frozen=True)
class BatchFrame:
    """待分析证据组合；像素路径使用PreparedImage，元信息使用唯一Pydantic定义。"""
    image: PreparedImage
    evidence: ActivityFrame


def frame_metadata(frames):
    """按采集顺序生成模型可用元信息；间隔由可信时间推导，原图路径留在记录中。

    参数frames为有序BatchFrame列表；返回可JSON编码的字典列表。
    结果包含逐帧编号、时间、应用、屏幕和秒级间隔，首帧间隔为空。
    函数只读输入，没有文件写入与模型调用。
    """
    result=[]
    previous=None
    for index,frame in enumerate(frames,1):
        at=frame.evidence.capturedAt
        item=frame.evidence.model_dump(mode='json',exclude={'screenshot'})
        item.update(frame=index,gapSeconds=None if previous is None else (at-previous).total_seconds())
        result.append(item)
        previous=at
    return result


def compose_batch(frames, home, settings, *, allow_partial=False):
    """将满批原图等比缩小、加时间标签并纵向拼成一份已提交JPEG。

    frames默认达到settings.batchSize；历史补跑显式allow_partial时接受1至batchSize张。
    采集时间须同日有序，home决定派生目录。
    逐张解码并缩至配置上限，保持小图原尺寸。先写同目录临时文件，再排他发布；
    同秒冲突换名，任一解码/保存失败上抛并清理临时文件，原始JPEG保持。
    成功返回兼容PreparedImage，两个字段均指拼图；所有借用图片及时关闭。
    """
    if not (1<=len(frames)<=settings.batchSize if allow_partial else len(frames)==settings.batchSize):
        raise ValueError('拼图需要完整批次')
    times=[frame.evidence.capturedAt for frame in frames]
    if any(at.date()!=times[0].date() for at in times) or times!=sorted(times):
        raise ValueError('拼图采集时间应同日且有序')
    thumbnails=[]
    canvas=None
    try:
        for frame in frames:
            with Image.open(frame.image.original) as original:
                image=original.convert('RGB')
            thumbnails.append(image)
            image.thumbnail((settings.frameMaxWidth,settings.frameMaxHeight),Image.Resampling.LANCZOS)
        width=max(image.width for image in thumbnails)
        height=sum(image.height+settings.labelHeight for image in thumbnails)
        if width*height>settings.maxImagePixels:
            raise ValueError('拼图超出像素预算')
        canvas=Image.new('RGB',(width,height),BACKGROUND)
        draw=ImageDraw.Draw(canvas)
        font=ImageFont.load_default(size=settings.labelFontSize)
        y=0
        for item,image in zip(frame_metadata(frames),thumbnails):
            gap='start' if item['gapSeconds'] is None else f"+{item['gapSeconds']:g}s"
            screen='?' if item['screen'] is None else str(item['screen'])
            label=f"#{item['frame']}  {item['capturedAt']}  {gap}  Screen {screen}"
            draw.rectangle((0,y,width,y+settings.labelHeight),fill=LABEL_BACKGROUND)
            draw.text((LABEL_MARGIN,y+settings.labelHeight/2),label,font=font,fill=LABEL_FOREGROUND,anchor='lm')
            y+=settings.labelHeight
            canvas.paste(image,((width-image.width)//2,y))
            y+=image.height
        directory=Path(home)/'analysis'/times[0].date().isoformat()
        for path in image_candidates(directory,times[0],'batch'):
            try:
                commit_exclusive(path,lambda output:canvas.save(output,'JPEG',quality=settings.jpegQuality,optimize=True))
            except FileExistsError:
                continue
            return PreparedImage(path,path,canvas.size,canvas.size)
    finally:
        for image in thumbnails:
            image.close()
        if canvas is not None:
            canvas.close()
