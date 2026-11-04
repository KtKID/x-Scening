# 自动生成：外部 @kmh/scene-observer 的 ObservationResultSchema 为权威源。
# 更新/漂移检查：python scripts/sync_scening_contract.py [--check]。
from typing import Annotated, Literal, List
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

class ObservationResult(BaseModel):
    """接收已提交的观察结果；字符串按工具契约trim，模型字段由Zod生成。"""
    model_config = ConfigDict(extra='forbid', strict=True)
    visible_activity: Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]
    inferred_intent: Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]
    stage_and_evidence: Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]
    app_tags: List[Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]]
    task_types: List[Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]] = Field(default=[])
    schema_version: Literal[1]

    @field_validator('schema_version', mode='before')
    @classmethod
    def numeric_constants(cls, value):
        """保留JS数字常量语义，布尔输入按无效协议处理。"""
        if isinstance(value, bool):
            raise ValueError('观察结果版本应为数字')
        return value
