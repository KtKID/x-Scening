import { useEffect, useState } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { Check, ChevronDown, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { ObserverBridge } from '../../shared/protocol';
import type { ModelSettings, SaveProvider } from '../../shared/models';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: ModelSettings };
type Feedback =
  { status: 'idle' | 'busy' } | { status: 'saved' | 'error'; message: string };
const fresh = (
  value: ModelSettings,
  provider = value.catalog[0]?.id ?? '',
): SaveProvider => {
  const entry = value.catalog.find((item) => item.id === provider);
  return {
    provider,
    kind: 'catalog',
    apiKey: '',
    baseURL: '',
    api: '',
    model: entry?.models.find((model) => model.image)?.id ?? '',
    reasoningEffort: '',
  };
};

/** 共用原生下拉框；装饰图标沿用表单的尺寸、颜色及右侧对齐线。 */
function ModelSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="model-select">
      <select {...props} />
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

/** 已保存供应商、当前模型及供应商编辑器；目录和能力由KMH提供。 */
export function ModelSettingsEditor({ bridge }: { bridge: ObserverBridge }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [feedback, setFeedback] = useState<Feedback>({ status: 'idle' });
  const [draft, setDraft] = useState<SaveProvider | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    bridge.readModelSettings().then(
      (value) => {
        if (active) {
          setState({ status: 'ready', value });
          setDraft(fresh(value));
        }
      },
      (error: unknown) => {
        if (active)
          setState({
            status: 'error',
            message:
              error instanceof Error ? error.message : '模型设置读取失败。',
          });
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, reload]);

  const busy = feedback.status === 'busy';
  const perform = async (
    operation: () => Promise<ModelSettings>,
    message: string,
    reset = false,
  ): Promise<void> => {
    setFeedback({ status: 'busy' });
    try {
      const value = await operation();
      setState({ status: 'ready', value });
      if (reset) {
        setDraft(fresh(value));
        setEditing(null);
        setVisible(false);
      }
      setFeedback({ status: 'saved', message });
    } catch (error: unknown) {
      setFeedback({
        status: 'error',
        message: error instanceof Error ? error.message : '保存失败，请重试。',
      });
    }
  };
  const update = (changes: Partial<SaveProvider>): void => {
    setDraft((previous) => (previous ? { ...previous, ...changes } : previous));
    setFeedback({ status: 'idle' });
  };

  if (state.status !== 'ready' || !draft)
    return (
      <section className="model-settings" aria-label="模型设置">
        <h3>模型</h3>
        {state.status === 'loading' ? (
          <p role="status">正在读取供应商与模型…</p>
        ) : state.status === 'error' ? (
          <>
            <p role="alert">{state.message}</p>
            <button onClick={() => setReload((value) => value + 1)}>
              重新读取模型
            </button>
          </>
        ) : null}
      </section>
    );
  const { value } = state;
  const provider = value.catalog.find((entry) => entry.id === draft.provider);
  const providerModels = provider?.models ?? [];
  const model = providerModels.find((entry) => entry.id === draft.model);
  const savedDraft = value.saved.find(
    (entry) => entry.provider === draft.provider,
  );
  const currentProvider = value.saved.find(
    (entry) => entry.provider === value.selected?.provider,
  );
  const currentModel = currentProvider?.models.find(
    (entry) => entry.id === value.selected?.model,
  );
  const edit = (name: string): void => {
    const saved = value.saved.find((entry) => entry.provider === name);
    if (!saved) return;
    const selected = value.selected?.provider === name ? value.selected : null;
    setDraft({
      provider: name,
      kind: saved.kind,
      apiKey: '',
      baseURL: saved.baseURL,
      api: saved.api,
      model:
        selected?.model ?? saved.models.find((entry) => entry.image)?.id ?? '',
      reasoningEffort: selected?.reasoningEffort ?? '',
    });
    setEditing(name);
    setVisible(false);
    setFeedback({ status: 'idle' });
  };
  return (
    <section className="model-settings" aria-label="模型设置">
      <div className="model-heading">
        <h3>模型</h3>
        <span className="muted">用于截图分析与总结</span>
      </div>
      <div className="model-provider-list">
        {value.saved.map((entry) => (
          <div className="model-provider-card" key={entry.provider}>
            <div className="model-provider-name">
              <strong>{entry.provider}</strong>
              <span
                className={`model-key-dot ${entry.credential === 'missing' ? 'missing' : ''}`}
                aria-label={
                  entry.credential === 'missing' ? '待填写密钥' : '凭据已配置'
                }
              />
              {value.selected?.provider === entry.provider && (
                <small className="model-active">
                  <Check size={12} /> 当前使用
                </small>
              )}
            </div>
            <div className="model-card-actions">
              <button
                disabled={busy}
                aria-label={`编辑供应商 ${entry.provider}`}
                onClick={() => edit(entry.provider)}
              >
                <Pencil size={13} />
                编辑
              </button>
              <button
                className="model-delete"
                disabled={busy}
                aria-label={`删除供应商 ${entry.provider}`}
                onClick={() => {
                  perform(
                    () => bridge.removeModelProvider(entry.provider),
                    '供应商已删除。',
                    editing === entry.provider,
                  ).catch(console.error);
                }}
              >
                <Trash2 size={13} />
                删除
              </button>
            </div>
          </div>
        ))}
        {value.saved.length === 0 && (
          <p className="model-empty">
            添加一个供应商，选择用于观察屏幕的模型。
          </p>
        )}
      </div>
      {value.saved.length > 0 && (
        <div className="model-current">
          <label>
            当前模型
            <ModelSelect
              aria-label="当前模型"
              disabled={busy}
              value={
                currentModel && currentProvider
                  ? JSON.stringify([currentProvider.provider, currentModel.id])
                  : ''
              }
              onChange={(event) => {
                const found = value.saved
                  .flatMap((entry) =>
                    entry.models.map((item) => ({
                      provider: entry.provider,
                      model: item.id,
                      key: JSON.stringify([entry.provider, item.id]),
                    })),
                  )
                  .find((item) => item.key === event.target.value);
                if (found)
                  perform(
                    () =>
                      bridge.selectModel({
                        provider: found.provider,
                        model: found.model,
                      }),
                    '当前模型已更新，下次调用生效。',
                  ).catch(console.error);
              }}
            >
              <option value="" disabled>
                选择模型
              </option>
              {value.saved.map((entry) => (
                <optgroup label={entry.provider} key={entry.provider}>
                  {entry.models.map((item) => (
                    <option
                      key={item.id}
                      value={JSON.stringify([entry.provider, item.id])}
                      disabled={!item.image || entry.credential === 'missing'}
                    >
                      {item.name}
                      {item.image ? '' : ' · 仅文字'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </ModelSelect>
          </label>
          <label>
            思考等级
            <ModelSelect
              aria-label="当前模型思考等级"
              disabled={busy || !currentModel?.efforts.length}
              value={value.selected?.reasoningEffort ?? ''}
              onChange={(event) => {
                if (value.selected) {
                  const selected = {
                    ...value.selected,
                    reasoningEffort: event.target.value,
                  };
                  perform(
                    () => bridge.selectModel(selected),
                    '思考等级已更新。',
                  ).catch(console.error);
                }
              }}
            >
              <option value="">供应商默认</option>
              {currentModel?.efforts.map((effort) => (
                <option key={effort}>{effort}</option>
              ))}
            </ModelSelect>
          </label>
        </div>
      )}
      <form
        className="model-provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          perform(
            () => bridge.saveModelProvider(draft),
            '供应商已保存，后续分析与总结使用所选模型。',
            true,
          ).catch(console.error);
        }}
      >
        <div className="model-tabs" role="tablist" aria-label="供应商类型">
          <button
            type="button"
            role="tab"
            aria-selected={draft.kind === 'catalog'}
            disabled={busy || editing !== null}
            onClick={() => {
              setDraft(fresh(value));
              setVisible(false);
            }}
          >
            第三方模型提供商
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={draft.kind === 'custom'}
            disabled={busy || editing !== null}
            onClick={() => {
              setDraft({
                ...fresh(value),
                provider: '',
                kind: 'custom',
                model: '',
                api: value.protocols[0] ?? '',
              });
              setVisible(false);
            }}
          >
            自定义模型 API
          </button>
        </div>
        <p className="muted model-form-hint">
          {editing
            ? `编辑 ${editing}，留空密钥沿用已保存凭据。`
            : draft.kind === 'catalog'
              ? '从内置目录选择提供商，填写 API 密钥即可使用。'
              : '连接自己的 API，填写支持图片输入与工具调用的模型。'}
        </p>
        <label>
          提供商
          {draft.kind === 'catalog' ? (
            <ModelSelect
              aria-label="提供商"
              value={draft.provider}
              disabled={busy || editing !== null}
              onChange={(event) => {
                setDraft(fresh(value, event.target.value));
                setVisible(false);
                setFeedback({ status: 'idle' });
              }}
            >
              {value.catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </ModelSelect>
          ) : (
            <input
              aria-label="自定义提供商名称"
              value={draft.provider}
              disabled={busy || editing !== null}
              required
              placeholder="填写名称"
              onChange={(event) => update({ provider: event.target.value })}
            />
          )}
        </label>
        <label>
          API 密钥
          <div className="model-key-input">
            <input
              aria-label="API 密钥"
              type={visible ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              disabled={busy}
              placeholder={
                savedDraft?.credential === 'saved'
                  ? '已保存，留空沿用'
                  : provider?.env.length
                    ? `留空使用环境认证（${provider.env[0]}）`
                    : '填写 API 密钥'
              }
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <button
              type="button"
              aria-label={visible ? '隐藏密钥' : '显示密钥'}
              onClick={() => setVisible((previous) => !previous)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        {draft.kind === 'custom' && (
          <div className="model-form-grid">
            <label>
              API 地址
              <input
                aria-label="自定义 API 地址"
                type="url"
                required
                value={draft.baseURL}
                disabled={busy}
                placeholder="https://…"
                onChange={(event) => update({ baseURL: event.target.value })}
              />
            </label>
            <label>
              API 协议
              <ModelSelect
                aria-label="API 协议"
                value={draft.api}
                disabled={busy}
                onChange={(event) => update({ api: event.target.value })}
              >
                {value.protocols.map((api) => (
                  <option key={api}>{api}</option>
                ))}
              </ModelSelect>
            </label>
          </div>
        )}
        <div className="model-form-grid">
          <label>
            模型
            {draft.kind === 'catalog' ? (
              <ModelSelect
                aria-label="供应商模型"
                value={draft.model}
                disabled={busy}
                required
                onChange={(event) =>
                  update({ model: event.target.value, reasoningEffort: '' })
                }
              >
                <option value="" disabled>
                  选择支持图片的模型
                </option>
                {providerModels.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.image}>
                    {item.name}
                    {item.image ? '' : ' · 仅文字'}
                  </option>
                ))}
              </ModelSelect>
            ) : (
              <input
                aria-label="自定义模型名称"
                value={draft.model}
                disabled={busy}
                required
                onChange={(event) => update({ model: event.target.value })}
              />
            )}
          </label>
          <label>
            思考等级
            <ModelSelect
              aria-label="供应商思考等级"
              value={draft.reasoningEffort}
              disabled={busy || !model?.efforts.length}
              onChange={(event) =>
                update({ reasoningEffort: event.target.value })
              }
            >
              <option value="">供应商默认</option>
              {model?.efforts.map((effort) => (
                <option key={effort}>{effort}</option>
              ))}
            </ModelSelect>
          </label>
        </div>
        {draft.kind === 'catalog' && (
          <details className="model-custom-settings">
            <summary>自定义设置</summary>
            <label>
              API 地址
              <input
                aria-label="供应商 API 地址"
                type="url"
                placeholder={provider?.baseURL || '使用供应商环境配置'}
                value={draft.baseURL}
                disabled={busy}
                onChange={(event) => update({ baseURL: event.target.value })}
              />
            </label>
          </details>
        )}
        {feedback.status === 'error' && (
          <p role="alert" className="model-feedback">
            {feedback.message}
          </p>
        )}
        <div className="model-form-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(fresh(value));
              setEditing(null);
              setVisible(false);
              setFeedback({ status: 'idle' });
            }}
          >
            取消
          </button>
          <button
            type="submit"
            aria-label="保存供应商"
            className="model-save"
            disabled={busy || !draft.model}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
      {feedback.status === 'saved' && (
        <p role="status" className="model-feedback">
          {feedback.message}
        </p>
      )}
      <small className="muted model-source">
        供应商与模型目录来自 KMH · {value.catalog.length} 个提供商
      </small>
    </section>
  );
}
