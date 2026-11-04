import { Plus, X } from 'lucide-react';

/** 任务类型是设置草稿的一部分，随设置页统一保存或清除。 */
export function TaskTypePresets({
  items,
  name,
  disabled,
  onName,
  onAdd,
  onRemove,
}: {
  items: string[];
  name: string;
  disabled: boolean;
  onName: (name: string) => void;
  onAdd: () => void;
  onRemove: (name: string) => void;
}) {
  return (
    <section className="type-presets" aria-labelledby="preset-title">
      <h3 id="preset-title">预设</h3>
      <h4>任务类型</h4>
      <p className="muted">
        用来标识活动的类型，每条活动支持多个类型，至少保留一项。
      </p>
      <ul className="type-preset-list" aria-label="任务类型预设">
        {items.map((item) => (
          <li key={item}>
            <span>{item}</span>
            <button
              type="button"
              aria-label={`删除类型：${item}`}
              disabled={disabled}
              onClick={() => onRemove(item)}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="type-preset-add"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <label className="sr-only" htmlFor="task-type-name">
          新任务类型
        </label>
        <input
          id="task-type-name"
          placeholder="输入新的类型名称"
          value={name}
          disabled={disabled}
          onChange={(event) => onName(event.target.value)}
        />
        <button type="submit" disabled={disabled || !name.trim()}>
          <Plus size={15} /> 添加
        </button>
      </form>
      {items.length === 0 && <p role="alert">请至少保留一个任务类型。</p>}
    </section>
  );
}
