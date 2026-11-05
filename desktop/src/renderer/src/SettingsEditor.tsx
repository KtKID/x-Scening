import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import {
  EditableConfigSchema,
  TaskTypePresetsSchema,
} from '../../shared/protocol';
import type { ObserverBridge, SettingsSnapshot } from '../../shared/protocol';
import {
  settingGroups,
  settingLabel,
  settingsDraft,
  settingsValue,
} from '../../shared/settings';
import { TaskTypePresets } from './TaskTypePresets';
import { ModelSettingsEditor } from './ModelSettingsEditor';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: SettingsSnapshot };
type SaveState =
  | { status: 'idle' | 'saving' | 'saved' }
  | { status: 'error'; message: string };

/** 独立表单草稿；统一提交配置，清除操作恢复最近已保存快照。 */
export function SettingsEditor({
  bridge,
  onSaved,
}: {
  bridge: ObserverBridge;
  onSaved: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [items, setItems] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    bridge.readSettings().then(
      (snapshot) => {
        if (!active) return;
        setLoad({ status: 'ready', snapshot });
        setDraft(settingsDraft(snapshot.config));
        setItems(snapshot.config.taskTypes);
        setName('');
        setSave({ status: 'idle' });
      },
      (error: unknown) => {
        if (active)
          setLoad({
            status: 'error',
            message: error instanceof Error ? error.message : '配置读取失败。',
          });
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, reload]);

  const saving = save.status === 'saving';
  const changed =
    load.status === 'ready' &&
    (Object.entries(settingsDraft(load.snapshot.config)).some(
      ([key, value]) => draft[key] !== value,
    ) ||
      JSON.stringify(items) !==
        JSON.stringify(load.snapshot.config.taskTypes) ||
      name.length > 0);
  const clear = (): void => {
    if (load.status !== 'ready') return;
    setDraft(settingsDraft(load.snapshot.config));
    setItems(load.snapshot.config.taskTypes);
    setName('');
    setSave({ status: 'idle' });
  };
  const add = (): void => {
    const parsed = TaskTypePresetsSchema.safeParse({
      taskTypes: [...items, name.trim()],
    });
    if (!parsed.success) {
      setSave({
        status: 'error',
        message: items.includes(name.trim())
          ? '这个类型已在预设中。'
          : '请输入非空的单行类型名称。',
      });
      return;
    }
    setItems(parsed.data.taskTypes);
    setName('');
    setSave({ status: 'idle' });
  };
  const persist = async (): Promise<void> => {
    if (load.status !== 'ready' || saving) return;
    // 保存同时承接尚在输入框中的新类型，避免用户遗漏“添加”。
    const taskTypes = name.length > 0 ? [...items, name.trim()] : items;
    const parsed = EditableConfigSchema.safeParse(
      settingsValue(load.snapshot.config, draft, taskTypes),
    );
    if (!parsed.success) {
      setSave({
        status: 'error',
        message: [
          ...new Set(
            parsed.error.issues.map((issue) =>
              settingLabel(
                issue.path
                  .map(String)
                  .join('.')
                  .replace(/\.\d+$/, ''),
              ),
            ),
          ),
        ]
          .map((label) => `请检查“${label}”的填写值及范围。`)
          .join(' '),
      });
      return;
    }
    setSave({ status: 'saving' });
    try {
      const snapshot = await bridge.saveSettings({
        config: parsed.data,
        revision: load.snapshot.revision,
      });
      setLoad({ status: 'ready', snapshot });
      setDraft(settingsDraft(snapshot.config));
      setItems(snapshot.config.taskTypes);
      setName('');
      setSave({ status: 'saved' });
      onSaved();
    } catch (error) {
      setSave({
        status: 'error',
        message:
          error instanceof Error ? error.message : '配置保存失败，请重试。',
      });
    }
  };

  return (
    <div className="settings-editor" aria-label="运行配置">
      <ModelSettingsEditor
        key={load.status === 'ready' ? load.snapshot.config.home : ''}
        bridge={bridge}
      />
      <div className="settings-toolbar">
        <div>
          <strong>运行配置</strong>
          <span className="muted">
            {changed ? '有待保存的修改' : '已与配置同步'}
          </span>
        </div>
        <div className="settings-actions">
          <button
            className="settings-clear"
            disabled={saving || !changed}
            onClick={clear}
          >
            <RotateCcw size={14} /> 清除修改
          </button>
          <button
            className="preset-save-button"
            disabled={saving || !changed}
            onClick={() => {
              persist().catch(console.error);
            }}
          >
            <Save size={14} />
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      <p className="muted settings-apply-note">
        保存后，采集参数在下次开始采集时读取；每日总结时间立即重新安排，篇幅在下次生成时读取。
      </p>
      {load.status === 'loading' && <p role="status">正在读取配置…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {save.status === 'error' && (
        <p className="settings-feedback" role="alert">
          {save.message}
        </p>
      )}
      {save.status === 'saved' && (
        <p className="settings-feedback" role="status">
          设置已保存。每日总结时间立即生效，采集参数下次开始时生效。
        </p>
      )}
      {(load.status === 'error' || save.status === 'error') && (
        <button
          className="settings-reload"
          onClick={() => setReload((value) => value + 1)}
          disabled={saving}
        >
          重新读取配置
        </button>
      )}
      {load.status === 'ready' && (
        <>
          {settingGroups
            .filter(
              (group) =>
                group.title !== '截图隐私' ||
                load.snapshot.config.privacy !== null,
            )
            .map((group, index) => (
              <details
                className="settings-group"
                key={group.title}
                open={index === 0 ? true : undefined}
              >
                <summary>
                  {group.title}
                  <span>{group.fields.length} 项</span>
                </summary>
                <p className="muted">{group.description}</p>
                <div className="settings-fields">
                  {group.fields.map(([key, label, help]) => (
                    <label className="settings-field" key={key}>
                      <span>{label}</span>
                      {[
                        'privacy.sensitiveApps',
                        'privacy.appKeywords',
                      ].includes(key) ? (
                        <textarea
                          aria-label={label}
                          aria-describedby={`hint-${key}`}
                          data-setting={key}
                          value={draft[key] ?? ''}
                          disabled={saving}
                          onChange={(event) => {
                            setDraft((previous) => ({
                              ...previous,
                              [key]: event.target.value,
                            }));
                            setSave({ status: 'idle' });
                          }}
                        />
                      ) : (
                        <input
                          aria-label={label}
                          aria-describedby={`hint-${key}`}
                          data-setting={key}
                          type={
                            key === 'dailyReview.scheduledTime'
                              ? 'time'
                              : [
                                    'privacy.enabled',
                                    'privacy.ocrEnabled',
                                    'privacy.cardCheck',
                                    'privacy.idCheck',
                                    'privacy.labelCheck',
                                  ].includes(key)
                                ? 'checkbox'
                                : [
                                      'home',
                                      'screenshotDir',
                                      'kmhLauncher',
                                      'kmhProfile',
                                    ].includes(key)
                                  ? 'text'
                                  : 'number'
                          }
                          step={
                            key === 'dailyReview.scheduledTime' ? 60 : 'any'
                          }
                          checked={draft[key] === 'true'}
                          value={draft[key] ?? ''}
                          disabled={saving}
                          onChange={(event) => {
                            setDraft((previous) => ({
                              ...previous,
                              [key]:
                                event.target.type === 'checkbox'
                                  ? String(event.target.checked)
                                  : event.target.value,
                            }));
                            setSave({ status: 'idle' });
                          }}
                        />
                      )}
                      <small id={`hint-${key}`}>{help}</small>
                    </label>
                  ))}
                </div>
              </details>
            ))}
          <TaskTypePresets
            items={items}
            name={name}
            disabled={saving}
            onName={(value) => {
              setName(value);
              setSave({ status: 'idle' });
            }}
            onAdd={add}
            onRemove={(item) => {
              setItems((previous) =>
                previous.filter((value) => value !== item),
              );
              setSave({ status: 'idle' });
            }}
          />
        </>
      )}
    </div>
  );
}
