# 真实MSS/Vision录制夹具

来源：`scripts/verify_memory_ocr_e2e.py`在本机显示受控原生页面，实际MSS截屏、Vision OCR并经真实collector完成判定和文件提交。两张PNG是实际取屏后的原始像素，页面只包含本脚本生成的普通文字或合成密钥。右上角保留macOS取屏状态图标。

## 文件及用途

| 文件 | 内容 | 测试如何消费 |
|------|------|--------------|
| `allowed.png` | 真实普通页截图，2560×1440 | RecordedBackend返回其RGB像素，真实stage生成内存JPEG |
| `sensitive.png` | 真实合成密钥页截图，2560×1440 | 同上；此图由用户授权的测试夹具录制流程在检查后单独保存 |
| `recording.json` | 配置快照、图片哈希、采集时间/身份、实际OCR行、预期与实际结果 | 固定取帧/时钟/应用/OCR边界，生产敏感规则、提交、metadata、索引继续实际执行 |
| `events.jsonl` | 随夹具保存的真实阶段日志 | 独立测试从该日志重新导出，核对导出结果与固定夹具完全一致 |

阶段日志：`reports/memory-ocr-e2e-20261104/evidence/native-events.jsonl`。导出器逐case读取`case_plan`、`capture`、`ocr_enter`、`ocr_return`及`after_publish`，生成`recording.json`。路径转为隔离截图目录内相对路径，随机runId留在临时metadata中；夹具只保留受控测试OCR行。

真实敏感页展示`sk-proj-demo`，本次Vision返回`sk-pro j-demo`。夹具保留真实OCR分词，回放验证既有容错规则。合成内容用于固定测试，预期由Spec场景10及`test_memory_ocr_replay.py`中的`EXPECTED`手写；`observed`作为取证结果单独核对。

## 从实录到mock

1. 取帧边界读取PNG，时钟与应用身份取录制元信息，系统状态固定为可采集，回放选中屏幕的一轮定时观察。
2. OCR边界返回`ocrLines`；进入该边界先核对JPEG SHA256及截图目录JPEG数量为零。
3. 调用真实敏感判定与文件发布，允许后检查实际JPEG/metadata/候选各1，敏感后各0。
4. 允许分支再次读取实际保存文件并核对JPEG哈希。额外用例把允许样本OCR改成合成密钥，确认原始允许预期会触发断言。

```sh
PYTHONPATH=src:tests .venv/bin/python -m unittest -v test_memory_ocr_replay
```

运行真实录制会短暂显示受控页面，结束后恢复前台应用，采集输出写独占`tmp`并自动清理。重新录制或从已有日志重新导出：

```sh
PYTHONPATH=src .venv/bin/python scripts/verify_memory_ocr_e2e.py
PYTHONPATH=src .venv/bin/python scripts/verify_memory_ocr_e2e.py --export-only
```

正式生产日志继续只记录原因/类别；本夹具来自明确授权的受控边界录制。JPEG质量、规则配置和输入哈希随夹具固定，改变这些输入后按新的真实录制更新夹具及对应证据。
