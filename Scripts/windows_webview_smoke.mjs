// Connect only to the disposable installed application's loopback WebView2 debugger.
// No browser automation dependencies or test-only application commands are bundled.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [port, phase, output, expectedVersion] = process.argv.slice(2);
assert(['seed', 'verify'].includes(phase));
await mkdir(output, { recursive: true });
let target;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = pages.find(page => page.type === 'page' && /tauri\.localhost/.test(page.url));
    if (target) break;
  } catch { /* WebView2 may still be initializing. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert(target?.webSocketDebuggerUrl, 'Installed WebView2 page did not become available');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const invoke = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await evaluate('document.querySelector("#root")?.innerText.length > 100')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const text = await evaluate('document.querySelector("#root")?.innerText ?? ""');
  assert(text.length > 100 && /Nodal Studio/.test(text), 'Application UI did not render');
  const runtime = await invoke('get_runtime_info');
  assert.equal(runtime.kind, 'desktop');
  if (expectedVersion) assert.equal(runtime.version, expectedVersion, 'Installed application version mismatch');
  const diagnostics = await invoke('get_diagnostic_info');
  assert.equal(diagnostics.target, 'windows');
  const settings = await invoke('get_settings', { input: { sourceId: null } });
  const checks = ['installed WebView2 UI rendered', 'native IPC works', 'Windows runtime detected'];
  const receiptFile = join(output, 'smoke-source.json');
  if (phase === 'seed') {
    assert.deepEqual(await invoke('list_data_sources'), [], 'Smoke test requires an empty profile');
    assert.equal(typeof settings.app.general.theme, 'string', 'Theme setting contract changed');
    settings.app.general.theme = 'dark';
    await invoke('update_app_settings', { settings: settings.app });
    const saved = await invoke('get_settings', { input: { sourceId: null } });
    assert.equal(saved.app.general.theme, 'dark', 'Theme did not persist before restart');
    // Dummy endpoint: save only; never test/connect to this address.
    const profile = await invoke('save_data_source', { input: {
      id: null, displayName: 'Windows 持久化测试', host: '127.0.0.1', port: 1,
      database: 'smoke', username: 'smoke', password: 'Disposable-test-password-仅测试',
      databaseType: 'postgreSql', sslMode: 'require',
    } });
    await writeFile(receiptFile, JSON.stringify({ sourceId: profile.id }));
    const security = await invoke('get_security_status', { input: { sourceId: profile.id } });
    assert.equal(security.databaseCredentialConfigured, true);
    checks.push('SQLite settings and Unicode source saved', 'Credential Manager write visible');
  } else {
    const { sourceId } = JSON.parse(await readFile(receiptFile, 'utf8'));
    assert.equal(settings.app.general.theme, 'dark');
    const profiles = await invoke('list_data_sources');
    assert(profiles.some(profile => profile.id === sourceId && profile.displayName === 'Windows 持久化测试'));
    const security = await invoke('get_security_status', { input: { sourceId } });
    assert.equal(security.databaseCredentialConfigured, true);
    const update = await invoke('get_update_status');
    assert.equal(update.configured, false);
    assert.equal(update.canInstall, false);
    checks.push('settings/source survive restart', 'credential survives restart', 'automatic updates disabled');
    await invoke('delete_source_data', { input: {
      sourceId, selection: { connection: true, history: true, semantics: true }, removeDatabaseCredential: true,
    } });
    assert.deepEqual(await invoke('list_data_sources'), []);
    const cleared = await invoke('get_security_status', { input: { sourceId } });
    assert.equal(cleared.databaseCredentialConfigured, false);
    checks.push('source and disposable credential removed');
  }
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `windows-${phase}.png`), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(output, `webview-${phase}.json`), JSON.stringify({ status: 'passed', runtime, checks }, null, 2));
  console.log(`${phase}: ${checks.join('; ')}`);
} finally {
  socket.close();
}
