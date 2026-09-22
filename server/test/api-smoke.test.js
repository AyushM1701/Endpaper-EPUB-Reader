'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(__dirname, '..');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the test server');
}

test('authenticated API enforces roles, exposes stats, and deduplicates writes', { timeout: 40_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'endpaper-api-'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    ENDPAPER_DATA_DIR: dataDir,
    PORT: String(port),
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  };
  let child;

  try {
    await execFileAsync(process.execPath, ['src/lib/passphrase.js', '--set', 'correct horse battery', 'admin'], {
      cwd: serverRoot,
      env,
      timeout: 20_000,
    });

    child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childError = '';
    child.stderr.on('data', chunk => { childError += chunk.toString(); });
    await waitForHealth(baseUrl, child);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ADMIN', passphrase: 'correct horse battery' }),
    });
    assert.equal(login.status, 200, childError);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /endpaper_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';', 1)[0];

    const invalidRole = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ username: 'reader', passphrase: 'another secure phrase', is_admin: 'true' }),
    });
    assert.equal(invalidRole.status, 400);

    const operationId = randomUUID();
    const create = () => fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': operationId },
      body: JSON.stringify({ username: 'reader', passphrase: 'another secure phrase', is_admin: false }),
    });
    const firstCreate = await create();
    assert.equal(firstCreate.status, 201);
    const firstUser = await firstCreate.json();
    const replayCreate = await create();
    assert.equal(replayCreate.status, 200);
    assert.deepEqual(await replayCreate.json(), firstUser);

    const stats = await fetch(`${baseUrl}/api/stats?tz=Asia%2FKolkata`, { headers: { Cookie: cookie } });
    assert.equal(stats.status, 200);
    const payload = await stats.json();
    assert.ok(Array.isArray(payload.daily));
    assert.ok(Array.isArray(payload.monthly));
    assert.equal(payload.reading_bytes_per_minute, null);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3_000)),
      ]);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
