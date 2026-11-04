/**
 * 子进程或本地操作失败的真实原因，供界面与日志直接显示。
 *
 * 优先取 stderr 末两行（回溯的异常类型与消息），避免整段回溯刷屏；
 * 无 stderr 时退回 Error.message。统一截取尾部 300 字符，空字符串表示无可用原因。
 * 稳定句式由调用方作前缀，本助手只负责不丢失可定位信息。
 */
export function failureReason(error: unknown): string {
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? (error as { stderr?: unknown }).stderr
      : undefined;
  if (typeof stderr === 'string') {
    const lines = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length) return lines.slice(-2).join('；').slice(-300);
  }
  return error instanceof Error ? error.message.slice(-300) : '';
}

/** 稳定句式作前缀，真实原因以「：原因」追加；无原因时保持原句式。 */
export function withReason(message: string, error: unknown): string {
  const reason = failureReason(error);
  return reason ? `${message}：${reason}` : message;
}
