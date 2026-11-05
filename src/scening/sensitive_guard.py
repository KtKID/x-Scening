"""截图敏感判定闸门：本地 Vision OCR + 形状容错规则，命中帧在发布前丢弃。

职责边界（三层闸门中的 L0 应用黑名单与 L2 内容判定；L1 窗口标题未实现）：
- L0：应用黑名单命中即拦截，不做 OCR；
- L2：macOS 系统 Vision OCR fast 识别全文后跑秘密格式规则；
- OCR 失败按"别泄露优先"阻断（fail-closed）；零行文本放行并留状态，
  因为 L2 只检文本形态的秘密，无文本即无可检目标。

规则与设计依据见 docs/design/screenshot-sensitive-rules-20261101.md；
全部可调数值在 observer.yaml 的 privacy 块维护，本模块只读启动快照。
判定结果只提供类别和数字定位信息，OCR 原文与命中字符保持在内存中。
"""
from bisect import bisect_right
import re
from dataclasses import dataclass, field
from itertools import accumulate
from pathlib import Path
from typing import Optional

import Quartz
import Vision
from Foundation import NSData
import objc

# 密钥前缀/短语：在原文与去空格文本各跑一遍。
# (?<![A-Za-z]) 只挡拉丁字母邻接：task-/risk- 不误伤，CJK 紧邻与标签后
# 碎片（OCR 会把 sk-proj 切碎）均可命中。
PREFIX_PATTERNS = [
    ("openai-key", re.compile(
        r"(?<![A-Za-z])s[\s_-]*k[\s_-]*-[\s_-]*"
        r"(?:p[\s_-]*r[\s_-]*o[\s_-]*j|a[\s_-]*n[\s_-]*t)")),
    ("openai-key", re.compile(r"(?<![A-Za-z])sk-[A-Za-z0-9_-]{10,}")),
    # gh[pouhsr]_ 覆盖经典 ghp/gho/ghu/ghs/ghr 与 2026-04 起 ghs_APPID_JWT；
    # github_pat_ 细粒度前缀与正文折行时前缀单独成规则
    ("github-token", re.compile(r"gh[pouhsr]_[A-Za-z0-9]{16,}|github_pat_")),
    # AKIA 长期密钥 ID 与 ASIA 临时凭证 ID
    ("aws-key", re.compile(r"A[KS]IA[0-9A-Z]{12,}")),
    # 私钥头：BEGIN 内部允许空白切碎，\s 含换行覆盖跨行，前导 ----- 不要求
    ("private-key", re.compile(r"B\s*E\s*G\s*I\s*N\s+[A-Z\s]*PRIVATE\s+KEY")),
]
# 凭证标签邻近：敏感标签 + 分隔符 + 形似凭证的值；值门槛挡文档示例与弱值。
CREDENTIAL_LABEL = re.compile(
    r"(?i)(?:password|passwd|pwd|secret|token|credential|api[_-]?key|"
    r"access[_-]?key|client[_-]?secret|private[_-]?key|"
    r"密钥|密码|口令|私钥|银行卡|卡号|身份证)\s*[:：=]\s*([^\s，。;；]{4,})")
# 身份证结构：区域6 + 世纪年份 + 月日 + 顺序3 + 校验1（末位可为 X/x）
ID_SHAPE = re.compile(r"[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])"
                      r"(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]")
# 卡种长度：13=Visa 旧制，15=Amex，16=Visa/MC/银联/Discover，19=Visa/银联
CARD_SIZES = (13, 15, 16, 19)
ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)


def luhn_ok(digits: str) -> bool:
    """Luhn 校验，digits 为含校验位的完整数字串；从右起第 2 位隔位加倍。"""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def id_ok(text: str) -> bool:
    """18 位身份证校验位验证，末位 X/x 以大写比较。"""
    if len(text) != 18 or not re.fullmatch(r"\d{17}[\dXx]", text):
        return False
    total = sum(int(c) * w for c, w in zip(text[:17], ID_WEIGHTS))
    return "10X98765432"[total % 11] == text[17].upper()


def _card_brand_ok(window: str) -> bool:
    """卡品牌前缀判定：Visa 4；Amex 34/37（15位）；万事达 51-55 与 2221-2720（16位）；
    银联 62（16/19位）；Discover 6011/65（16位）。收紧范围压随机数字流误报。"""
    size = len(window)
    if window[0] == "4":
        return size in (13, 16, 19)
    if window[:2] == "62":
        return size in (16, 19)
    if window[:2] in ("34", "37"):
        return size == 15
    if size == 16:
        if window[:2] in ("51", "52", "53", "54", "55"):
            return True
        if window[:4].isdigit() and 2221 <= int(window[:4]) <= 2720:
            return True
        return window[:4] == "6011" or window[:2] == "65"
    return False


def _credential_value_ok(value: str) -> bool:
    """凭证标签后的值是否形似凭证：长值、含数字长值或字母数字混合值。"""
    if len(value) >= 16:
        return True
    if len(value) >= 8 and any(c.isdigit() for c in value):
        return True
    return (len(value) >= 6 and any(c.isalpha() for c in value)
            and any(c.isdigit() for c in value))


def _scan_cards(flat: str):
    """卡号：完整数字游程逐起点 × 卡种长度，品牌前缀 + Luhn 双验证。

    游程取完整段不切块，避免非重叠截断真实候选；空格、ASCII 连字符
    与破折号已在 flat 中移除。命中返回 flat 内的首个匹配区间。
    """
    for run_m in re.finditer(r"\d{13,}", flat):
        run = run_m.group()
        for start in range(len(run) - 12):
            for size in CARD_SIZES:
                window = run[start:start + size]
                if len(window) < size:
                    continue
                if _card_brand_ok(window) and luhn_ok(window):
                    offset = run_m.start() + start
                    return offset, offset + size
    return None


def _scan_ids(flat: str):
    """身份证：结构与校验位都通过时返回 flat 内的首个匹配区间。"""
    for run_m in re.finditer(r"[0-9Xx]{13,}", flat):
        run = run_m.group()
        for start in range(len(run) - 17):
            m = ID_SHAPE.match(run, start)
            if m and id_ok(m.group()):
                return run_m.start() + m.start(), run_m.start() + m.end()
    return None


def detect_text(text, *, long_token_min=20, split_min=12, split_joined_min=24,
                card_check=True, id_check=True, label_check=True, match_spans=None):
    """对 OCR 全文跑秘密格式匹配，返回命中类别列表。

    参数text为多行文本；阈值的默认值与observer.yaml保持一致，仅测试直接调用。
    前缀/短语在原文与去空格文本各跑一遍；长token/折行/标签只在原文跑；
    数字滑窗在去空白与分隔符的flat上跑。返回去重后的类别名列表。
    提供match_spans时，按类别填入首次匹配在原文中的区间和实际匹配长度。
    """
    lines = text.splitlines()
    compact = re.sub(r"\s+", "", text)
    hits = []
    offsets = {}

    def record(rule, start, end, *, retained=None, length=None):
        """记录规则及数字区间，把压缩文本的偏移还原到OCR原文。"""
        if rule in hits:
            return
        hits.append(rule)
        if match_spans is None:
            return
        length = end - start if length is None else length
        if retained is not None:
            if retained not in offsets:
                offsets[retained] = [m.start() for m in re.finditer(retained, text)]
            positions = offsets[retained]
            start, end = positions[start], positions[end - 1] + 1
        match_spans[rule] = start, end, length

    for name, pat in PREFIX_PATTERNS:
        match = pat.search(text)
        if match:
            record(name, *match.span())
        elif match := pat.search(compact):
            record(name, *match.span(), retained=r"[^\s]")
    for match in re.finditer(r"[A-Za-z0-9_-]{%d,}" % long_token_min, text):
        token = match.group()
        if (re.search(r"[A-Z]", token) and re.search(r"[a-z]", token)
                and re.search(r"\d", token)):
            record("long-token", *match.span())
            break
    if label_check:
        for label_match in CREDENTIAL_LABEL.finditer(text):
            if _credential_value_ok(label_match.group(1)):
                record("credential-label", *label_match.span(1))
                break
    flat = compact.replace("\u2014", "").replace("-", "")
    if card_check:
        hit = _scan_cards(flat)
        if hit:
            record("bank-card", *hit, retained=r"[^\s—-]")
    if id_check:
        hit = _scan_ids(flat)
        if hit:
            record("cn-id", *hit, retained=r"[^\s—-]")
    # 折行密钥体：相邻行行尾/行首长token拼接后满足混合字符条件
    tail_pat = re.compile(r"[A-Za-z0-9_-]{%d,}$" % split_min)
    head_pat = re.compile(r"[A-Za-z0-9_-]{%d,}" % split_min)
    for index, (current, following) in enumerate(zip(lines, lines[1:])):
        tail = tail_pat.search(current)
        head = head_pat.match(following)
        if not (tail and head):
            continue
        joined = tail.group() + head.group()
        if len(joined) < split_joined_min:
            continue
        if (re.search(r"[A-Z]", joined) and re.search(r"[a-z]", joined)
                and re.search(r"\d", joined)):
            source_lines = text.splitlines(keepends=True)
            offset = sum(len(line) for line in source_lines[:index])
            record("split-token", offset + tail.start(),
                   offset + len(source_lines[index]) + head.end(), length=len(joined))
            break
    return hits


class _OcrLine(str):
    """兼容原文本行接口，附带从图片左上角计算的归一化行矩形。"""

    def __new__(cls, text, bounds):
        line = super().__new__(cls, text)
        line.box = tuple(round(value, 3) for value in (
            bounds.origin.x, 1 - bounds.origin.y - bounds.size.height,
            bounds.size.width, bounds.size.height,
        ))
        return line


def _hit_details(lines, match_spans):
    """将匹配偏移投影到首末 OCR 行，仅返回规则名、长度、行号和矩形。"""
    starts = list(accumulate((len(line) + 1 for line in lines), initial=0))
    details = []
    for rule, (start, end, length) in match_spans.items():
        first = bisect_right(starts, start) - 1
        last = bisect_right(starts, end - 1) - 1
        regions = []
        for index in (first,) if first == last else (first, last):
            region = {'line': index + 1}
            if hasattr(lines[index], 'box'):
                region['box'] = lines[index].box
            regions.append(region)
        details.append({'rule': rule, 'length': length, 'regions': regions})
    return tuple(details)


def ocr_lines(image_source) -> list:
    """对内存JPEG字节或图片路径执行一次Vision OCR fast，返回Python文本行。

    只用fast档：accurate对小字号深色终端图恒返回0行（见设计文档§2）。
    实时参数为不可变JPEG字节，补分析参数为图片路径；两入口共用识别参数。
    NSData在本轮池内拥有输入副本，池退出时释放Vision请求及原生临时对象。
    输入保持只读，图片文件保持零新增；OCR失败上抛RuntimeError供调用方阻断。
    """
    with objc.autorelease_pool():
        if isinstance(image_source, bytes):
            data = NSData.dataWithBytes_length_(image_source, len(image_source))
            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
        else:
            path = Path(image_source)
            encoded = str(path).encode()
            url = Quartz.CFURLCreateFromFileSystemRepresentation(None, encoded, len(encoded), False)
            handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelFast)
        request.setRecognitionLanguages_(["zh-Hans", "en-US"])
        request.setUsesLanguageCorrection_(False)
        ok, error = handler.performRequests_error_([request], None)
        if not ok:
            raise RuntimeError(f"Vision OCR 失败: {error}")
        lines = []
        for obs in request.results() or []:
            candidates = obs.topCandidates_(1)
            if candidates:
                lines.append(_OcrLine(str(candidates[0].string()), obs.boundingBox()))
    return lines


@dataclass(frozen=True)
class GuardVerdict:
    """一次判定结果；hit_details携带首处匹配的数字定位信息。"""
    blocked: bool
    reason: str
    hits: tuple = field(default_factory=tuple)
    hit_details: tuple = field(default_factory=tuple)


class SensitiveGuard:
    """候选帧敏感判定器；配置为privacy启动快照，判定过程无副作用。"""

    def __init__(self, config):
        """参数config为PrivacyConfig；构造只读配置，不访问图片与模型。"""
        self.config = config

    def _app_blocked(self, app: Optional[str], bundle_id: Optional[str]) -> bool:
        """L0：黑名单按bundleId精确或前缀、应用名精确匹配；关键词大小写不敏感包含。"""
        for name in self.config.sensitiveApps:
            if bundle_id and (bundle_id == name or bundle_id.startswith(name + '.')):
                return True
            if app and app == name:
                return True
        for keyword in self.config.appKeywords:
            folded = keyword.casefold()
            if (app and folded in app.casefold()) or (
                    bundle_id and folded in bundle_id.casefold()):
                return True
        return False

    def evaluate(self, image_source, *, app=None, bundle_id=None) -> GuardVerdict:
        """判定一帧候选：命中即blocked，调用方负责丢弃图片并记日志。

        参数image_source为实时内存JPEG字节或补分析原图路径，判定在
        promote/拼图提交前完成；app与bundle_id为采集身份，可缺省。
        返回GuardVerdict：reason为 disabled/app/ocr-error/ocr-empty/content/clean。
        OCR异常按别泄露优先阻断；零行文本放行（L2只检文本秘密）。
        """
        if not self.config.enabled:
            return GuardVerdict(False, 'disabled')
        if self._app_blocked(app, bundle_id):
            return GuardVerdict(True, 'app', ('app-denylist',))
        if not self.config.ocrEnabled:
            return GuardVerdict(False, 'app-only')
        try:
            lines = ocr_lines(image_source)
        except (RuntimeError, OSError) as error:
            # fail-closed：OCR不可用时按敏感处理，由调用方丢弃并记录原因
            return GuardVerdict(True, 'ocr-error', ())
        if not lines:
            return GuardVerdict(False, 'ocr-empty')
        match_spans = {}
        hits = detect_text(
            "\n".join(lines),
            long_token_min=self.config.longTokenMin,
            split_min=self.config.splitTokenMin,
            split_joined_min=self.config.splitJoinedMin,
            card_check=self.config.cardCheck,
            id_check=self.config.idCheck,
            label_check=self.config.labelCheck,
            match_spans=match_spans)
        if hits:
            return GuardVerdict(True, 'content', tuple(hits), _hit_details(lines, match_spans))
        return GuardVerdict(False, 'clean')
