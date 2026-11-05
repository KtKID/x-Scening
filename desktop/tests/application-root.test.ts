import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApplicationRoot } from '../src/main/application-root';

await test('发布安装包采用应用自身资源，开发模式保留项目根', () => {
  const source = '/missing/build-machine/project';
  const resources = '/Applications/My Apps/x-scening.app/Contents/Resources';
  assert.equal(
    resolveApplicationRoot(source, resources, true, 'publish'),
    `${resources}/python-runtime`,
  );
  assert.equal(resolveApplicationRoot(source, resources, true, 'dev'), source);
  assert.equal(
    resolveApplicationRoot(source, resources, false, 'publish'),
    source,
  );
  assert.equal(resolveApplicationRoot(source, resources, false, 'dev'), source);
});
