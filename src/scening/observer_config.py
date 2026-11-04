"""运行配置的唯一校验入口；默认参数全部从项目 observer.yaml 读取。"""
import json
from pathlib import Path
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / 'observer.yaml'


class _UniqueKeySafeLoader(yaml.SafeLoader):
    """沿用安全YAML标量解析，在所有映射层级拒绝重复或非字符串字段。"""


def _unique_mapping(loader, node):
    """读取一层YAML映射，返回字段字典；重复/非法键抛含行号的解析错误。

    参数由PyYAML的安全加载器提供；只构造普通数据，文件保持只读。
    YAML合并键展开后同样按唯一字段规则检查，避免值被静默覆盖。
    """
    loader.flatten_mapping(node)
    values = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if not isinstance(key, str) or key in values:
            raise yaml.constructor.ConstructorError(
                '配置字段必须使用唯一字符串键', node.start_mark,
                f'重复或非法字段：{key}', key_node.start_mark)
        values[key] = loader.construct_object(value_node)
    return values


_UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def _unique_json_pairs(pairs):
    """兼容JSON时保留相同的重复键检查；参数为当前对象的有序键值对。"""
    values = {}
    for key, value in pairs:
        if key in values:
            raise ValueError(f'重复字段：{key}')
        values[key] = value
    return values


def _read_config_file(source):
    """只读解析配置并要求根映射；显式.json采用JSON语法，其余采用安全YAML。

    返回普通字典，语义与数值校验交由唯一Pydantic模型；解析失败上抛。
    文件、运行目录、采集与外部模型均保持原状态。
    """
    content = source.read_text(encoding='utf-8')
    values = (json.loads(content, object_pairs_hook=_unique_json_pairs)
              if source.suffix.lower() == '.json'
              else yaml.load(content, Loader=_UniqueKeySafeLoader))
    if not isinstance(values, dict):
        raise ValueError('配置根内容必须是字段映射')
    return values


class SceningConfig(BaseModel):
    """采集策略的启动快照；所有默认数值由项目 YAML 提供。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    captureFps: float = Field(strict=True, gt=0, allow_inf_nan=False)
    highResolutionFps: float = Field(strict=True, gt=0, allow_inf_nan=False)
    highResolutionWidth: int = Field(strict=True, gt=0)
    highResolutionHeight: int = Field(strict=True, gt=0)
    monitorRefreshSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    clickDebounceSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    keyboardIdleSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    scrollDebounceSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    scrollMinPointerDistance: float = Field(strict=True, ge=0, allow_inf_nan=False)
    scrollMaxEventsPerSecond: float = Field(strict=True, gt=0, allow_inf_nan=False)
    scrollResetSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    scrollAfterSeconds: float = Field(strict=True, ge=0, allow_inf_nan=False)
    missingImageDifference: float = Field(strict=True, gt=0, allow_inf_nan=False)
    actionIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    minRawEvents: int = Field(strict=True, gt=0)
    segmentDifferenceThreshold: float = Field(strict=True, gt=0, allow_inf_nan=False)
    stableComparisonCount: int = Field(strict=True, gt=0)
    observationIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    sensingIdleSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    recentActivityMultiplier: float = Field(strict=True, gt=0, allow_inf_nan=False)
    recentActivityPaddingSeconds: float = Field(strict=True, ge=0, allow_inf_nan=False)
    jpegQuality: int = Field(strict=True, ge=1, le=95)
    candidateQueueSize: int = Field(strict=True, gt=0)
    maxStoredActions: int = Field(strict=True, gt=1)
    shutdownTimeoutSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)


class AnalysisConfig(BaseModel):
    """成批分析与拼图启动配置；默认数值由YAML唯一提供。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    batchSize: int = Field(strict=True, ge=2, le=3)
    frameMaxWidth: int = Field(strict=True, gt=0)
    frameMaxHeight: int = Field(strict=True, gt=0)
    labelHeight: int = Field(strict=True, gt=0)
    labelFontSize: int = Field(strict=True, gt=0)
    jpegQuality: int = Field(strict=True, ge=1, le=95)
    maxImagePixels: int = Field(strict=True, gt=0)
    retryIntervalSeconds: float = Field(strict=True, gt=0)
    maxRetries: int = Field(strict=True, ge=0)

    @model_validator(mode='after')
    def bounded_geometry(self):
        """在启动前核对标签与最大拼图面积，拒绝注定超出图片预算的配置。"""
        if self.labelHeight < self.labelFontSize:
            raise ValueError('analysis.labelHeight应容纳labelFontSize')
        if self.frameMaxWidth * (self.frameMaxHeight + self.labelHeight) * self.batchSize > self.maxImagePixels:
            raise ValueError('analysis拼图尺寸超出maxImagePixels')
        return self


class DailyReviewConfig(BaseModel):
    """每日温馨回顾的篇幅要求；默认值由项目YAML提供。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    maxChars: int = Field(strict=True, gt=0)
    scheduledTime: str = Field(strict=True, pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    maxAutoAttempts: int = Field(strict=True, gt=0)
    retryIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    checkIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)

    @model_validator(mode='before')
    @classmethod
    def legacy_daily_review(cls, value):
        """旧版仅含maxChars时从权威YAML补齐；新配置保持完整严格校验。"""
        if isinstance(value, dict) and set(value) == {'maxChars'}:
            defaults = _read_config_file(DEFAULT_CONFIG_PATH)['dailyReview']
            return {**defaults, **value}
        return value


class DesktopConfig(BaseModel):
    """桌面自动更新配置；默认数值由项目YAML统一提供。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    refreshIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)


class ControlConfig(BaseModel):
    """本地开关与取消的预算，默认数值统一来自YAML。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    timeoutSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    cancelGraceSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    pollSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)


class TaskTimelineConfig(BaseModel):
    """任务整理与时间估算参数；默认值统一在YAML。"""
    model_config = ConfigDict(extra='forbid', frozen=True)
    minOrganizeIntervalSeconds: float = Field(gt=0, allow_inf_nan=False)
    maxActivitiesPerBatch: int = Field(strict=True, gt=0)
    maxInputChars: int = Field(strict=True, gt=0)
    retryIntervalSeconds: float = Field(gt=0, allow_inf_nan=False)
    maxAttemptsPerRevision: int = Field(strict=True, gt=0)
    maxContinuityGapSeconds: float = Field(gt=0, allow_inf_nan=False)


class PrivacyConfig(BaseModel):
    """截图敏感闸门配置；判定在候选发布与补分析提交前执行，命中帧丢弃。

    默认数值由YAML唯一提供；旧配置缺少privacy块时闸门整体关闭，行为不变。
    """
    model_config = ConfigDict(extra='forbid', frozen=True)
    enabled: bool = Field(strict=True)
    sensitiveApps: list[Annotated[str, StringConstraints(strict=True, min_length=1)]] = Field(
        strict=True, json_schema_extra={'uniqueItems': True})
    appKeywords: list[Annotated[str, StringConstraints(strict=True, min_length=1)]] = Field(
        strict=True, json_schema_extra={'uniqueItems': True})
    ocrEnabled: bool = Field(strict=True)
    longTokenMin: int = Field(strict=True, ge=6)
    splitTokenMin: int = Field(strict=True, ge=6)
    splitJoinedMin: int = Field(strict=True, ge=12)
    cardCheck: bool = Field(strict=True)
    idCheck: bool = Field(strict=True)
    labelCheck: bool = Field(strict=True)

    @field_validator('sensitiveApps', 'appKeywords')
    @classmethod
    def unique_entries(cls, value):
        """名单去重校验，原顺序保留。"""
        if len(value) != len(set(value)):
            raise ValueError('privacy名单条目应唯一')
        return value

    @model_validator(mode='after')
    def split_bounds(self):
        """折行拼接下限应不小于单侧下限的两倍，保证规则语义成立。"""
        if self.splitJoinedMin < self.splitTokenMin * 2:
            raise ValueError('privacy.splitJoinedMin应不小于splitTokenMin的2倍')
        return self


class ObserverConfig(BaseModel):
    """一次运行的只读配置快照；字段名、单位和含义与配置文件保持一致。"""
    model_config = ConfigDict(extra='forbid', frozen=True)

    # 显式旧JSON的_comments兼容元数据；当前YAML使用原生中文注释。
    comments: dict[str, str] = Field(default_factory=dict, alias='_comments', exclude=True)
    home: Path
    taskTimeline: Optional[TaskTimelineConfig] = None
    privacy: Optional[PrivacyConfig] = None
    desktop: Optional[DesktopConfig] = None
    taskTypes: list[Annotated[str, StringConstraints(strict=True, min_length=1, pattern=r'^\S(?:[^\r\n]*\S)?$')]] = Field(
        strict=True, min_length=1, json_schema_extra={'uniqueItems': True})
    screenshotDir: Path
    sampleIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    summaryIntervalSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    captureCount: int = Field(strict=True, ge=0)
    differenceThreshold: float = Field(strict=True, gt=0, le=1, allow_inf_nan=False)
    captureTimeoutSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    modelTimeoutSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    terminationGraceSeconds: float = Field(strict=True, gt=0, allow_inf_nan=False)
    control: ControlConfig
    analysisMaxChars: int = Field(strict=True, gt=0)
    summaryMaxChars: int = Field(strict=True, gt=0)
    dailyReview: DailyReviewConfig
    kmhLauncher: Path
    kmhProfile: str = Field(pattern=r'^[A-Za-z0-9_-]+$')
    scening: SceningConfig
    analysis: AnalysisConfig

    @field_validator('taskTypes')
    @classmethod
    def unique_task_types(cls, value):
        """校验任务类型唯一；原顺序保留，重复输入由配置入口报告。"""
        if len(value) != len(set(value)):
            raise ValueError('任务类型名称应唯一')
        return value

    @field_validator('home', 'screenshotDir', 'kmhLauncher', mode='before')
    @classmethod
    def require_path(cls, value):
        """路径必须有内容，防止空字符串被解释成工作目录。"""
        if isinstance(value, str) and not value.strip():
            raise ValueError('路径必须有内容')
        return value

    def with_overrides(self, **overrides) -> 'ObserverConfig':
        """返回通过完整校验的新快照，原快照与文件保持原值。

        参数：键使用配置字段名；None 表示沿用已有值，适用于未提供的CLI选项。
        路径先展开用户主目录，再按调用时工作目录解析；其余类型、有限数和值域交给本模型校验。
        返回：不可变的ObserverConfig；校验错误抛ValueError，无文件写入副作用。
        """
        values = self.model_dump()
        for key, value in overrides.items():
            if value is not None:
                if key in ('home', 'screenshotDir', 'kmhLauncher') and isinstance(value, (str, Path)):
                    if isinstance(value, str) and not value.strip():
                        raise ValueError(f'{key} 路径必须有内容')
                    value = Path(value).expanduser().resolve()
                values[key] = value
        return ObserverConfig.model_validate(values)


def load_config(path: Optional[Path] = None, **overrides) -> ObserverConfig:
    """只读加载完整配置，解析相对路径并叠加显式覆盖，返回启动快照。

    参数：path省略时使用项目根observer.yaml；配置需包含全部字段。
    YAML原生注释由解析器处理，显式旧JSON的_comments校验后排除。
    路径先展开~用户目录，文件内相对路径基于配置所在目录；CLI覆盖基于当前工作目录。
    返回：通过Pydantic校验的ObserverConfig，默认值始终由所选配置文件提供。
    异常：文件缺失、格式/重复键错误、未知字段或非法值抛带文件定位的ValueError。
    副作用：只读配置；创建图片、运行目录或启动子进程均由校验后的消费者完成。
    """
    source = Path(path if path is not None else DEFAULT_CONFIG_PATH).expanduser().resolve()
    try:
        values = _read_config_file(source)
        if any(block not in values for block in ('scening', 'analysis', 'control', 'dailyReview', 'taskTypes', 'taskTimeline')):
            defaults = _read_config_file(DEFAULT_CONFIG_PATH)
            for block in ('scening', 'analysis', 'control', 'dailyReview', 'taskTypes', 'taskTimeline'):
                if block not in values:
                    if block not in defaults:
                        raise ValueError(f'项目默认配置缺少 {block} 策略块')
                    values[block] = defaults[block]
        settings = ObserverConfig.model_validate(values)
        values = settings.model_dump()
        for key in ('home', 'screenshotDir', 'kmhLauncher'):
            values[key] = (source.parent / values[key].expanduser()).resolve()
        return ObserverConfig.model_validate(values).with_overrides(**overrides)
    except (OSError, ValueError, yaml.YAMLError) as error:
        raise ValueError(f'配置错误：{source}：{error}') from error
