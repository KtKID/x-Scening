import path from 'node:path';

/** 当前平台的固定发布入口；内部暂存与上一份产物统一收在.cache。 */
export function localClientPaths(
  root: string,
  output = path.join(root, 'desktop/release'),
) {
  const mac = process.platform === 'darwin';
  const folder = mac
    ? process.arch === 'arm64'
      ? 'mac-arm64'
      : 'mac'
    : process.platform === 'win32'
      ? process.arch === 'x64'
        ? 'win-unpacked'
        : `win-${process.arch}-unpacked`
      : process.arch === 'x64'
        ? 'linux-unpacked'
        : `linux-${process.arch}-unpacked`;
  const app = path.join(output, folder, mac ? 'x-scening.app' : '');
  const resources = path.join(app, mac ? 'Contents/Resources' : 'resources');
  return {
    app,
    payload: mac ? path.join(app, 'Contents') : app,
    executable: path.join(
      app,
      mac
        ? 'Contents/MacOS/Observer'
        : process.platform === 'win32'
          ? 'Observer.exe'
          : 'Observer',
    ),
    archive: path.join(resources, 'app.asar'),
    info: path.join(resources, 'local-client-build.json'),
  };
}
