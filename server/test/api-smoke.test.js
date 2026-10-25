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
    METRICS_TOKEN: 'test-metrics-token',
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
    assert.equal(payload.reading_words_per_minute, null);

    const epub = await fs.readFile(path.join(__dirname, 'fixtures/three-chapters.epub'));
    const uploadBody = new FormData();
    uploadBody.append('file', new Blob([epub], { type: 'application/epub+zip' }), 'pace.epub');
    const upload = await fetch(`${baseUrl}/api/books`, { method: 'POST', headers: { Cookie: cookie }, body: uploadBody });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    const Database = require('better-sqlite3');
    const database = new Database(path.join(dataDir, 'endpaper.db'));
    try {
      // The small fixture represents a longer book so one session can meet
      // the minimum sample size without slowing down the test.
      database.prepare('UPDATE books SET word_count = 20000 WHERE id = ?').run(uploaded.id);
      const jsonPost = async (url, body) => fetch(`${baseUrl}${url}`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const patchProgress = async progress => fetch(`${baseUrl}/api/books/${uploaded.id}`, {
        method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ progress_percent: progress }),
      });
      const firstSession = await jsonPost('/api/sessions/start', { book_id: uploaded.id });
      assert.equal(firstSession.status, 201);
      const first = await firstSession.json();
      database.prepare('UPDATE reading_sessions SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 60000).toISOString(), first.id);
      assert.equal((await patchProgress(20)).status, 200);
      assert.equal((await jsonPost(`/api/sessions/${first.id}/end`, {})).status, 200);
      const measured = await (await fetch(`${baseUrl}/api/stats`, { headers: { Cookie: cookie } })).json();
      assert.ok(measured.reading_words_per_minute >= 120 && measured.reading_words_per_minute <= 140);

      const jumpSession = await jsonPost('/api/sessions/start', { book_id: uploaded.id });
      assert.equal(jumpSession.status, 201);
      const jump = await jumpSession.json();
      database.prepare('UPDATE reading_sessions SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 60000).toISOString(), jump.id);
      assert.equal((await patchProgress(90)).status, 200);
      assert.equal((await jsonPost(`/api/sessions/${jump.id}/end`, {})).status, 200);
      const afterJump = await (await fetch(`${baseUrl}/api/stats`, { headers: { Cookie: cookie } })).json();
      assert.equal(afterJump.reading_words_per_minute, measured.reading_words_per_minute);

      // Repeated query parameters are tolerated rather than crashing the route.
      const repeated = await fetch(`${baseUrl}/api/books?search=a&search=b&filter=all&filter=unread`, { headers: { Cookie: cookie } });
      assert.equal(repeated.status, 200);

      // Settings keep their JSON types across a round trip.
      const putSettings = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'test-string': '42', 'test-flag': 'true', 'test-number': 7 }),
      });
      assert.equal(putSettings.status, 200);
      const storedSettings = await (await fetch(`${baseUrl}/api/settings`, { headers: { Cookie: cookie } })).json();
      assert.equal(storedSettings['test-string'], '42');
      assert.equal(storedSettings['test-flag'], 'true');
      assert.equal(storedSettings['test-number'], 7);

      // The database stores only a hash of the session cookie.
      const rawToken = cookie.split('=')[1];
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get(rawToken).n, 0);

      // A session left open (closed tab, killed PWA) only counts until its
      // last heartbeat plus a short grace period.
      const idleSession = await (await jsonPost('/api/sessions/start', { book_id: uploaded.id })).json();
      assert.equal((await jsonPost(`/api/sessions/${idleSession.id}/heartbeat`, {})).status, 200);
      database.prepare('UPDATE reading_sessions SET started_at = ?, last_active_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 11 * 3600000).toISOString(), new Date(Date.now() - 10 * 3600000).toISOString(), idleSession.id);
      const idleEnded = await (await jsonPost(`/api/sessions/${idleSession.id}/end`, {})).json();
      assert.ok(idleEnded.duration_seconds >= 3700 && idleEnded.duration_seconds <= 3740, String(idleEnded.duration_seconds));
      assert.equal((await jsonPost(`/api/sessions/${idleSession.id}/heartbeat`, {})).status, 404);

      const patchBook = async body => fetch(`${baseUrl}/api/books/${uploaded.id}`, {
        method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal((await patchBook({ rating: 3.5 })).status, 400);
      assert.equal((await patchBook({ rating: 4 })).status, 200);

      // "Mark as unread" sticks while progress stays put, and reading on flips it back.
      assert.equal((await (await patchBook({ status: 'unread' })).json()).status, 'unread');
      assert.equal((await (await patchBook({ progress_percent: 90 })).json()).status, 'unread');
      assert.equal((await (await patchBook({ progress_percent: 91 })).json()).status, 'reading');
      const unreadList = await (await fetch(`${baseUrl}/api/books?filter=unread`, { headers: { Cookie: cookie } })).json();
      assert.equal(unreadList.books.length, 0);

      // Full-text search finds words inside the book and points at the chapter.
      const textSearch = await (await fetch(`${baseUrl}/api/search/text?q=${encodeURIComponent('chapter tw')}`, { headers: { Cookie: cookie } })).json();
      assert.equal(textSearch.results[0].book_id, uploaded.id);
      assert.equal(textSearch.results[0].href, 'chapter2.xhtml');
      assert.match(textSearch.results[0].snippet, /\u0002Two\u0003/);
      assert.deepEqual((await (await fetch(`${baseUrl}/api/search/text?q=${encodeURIComponent('"); DROP')}`, { headers: { Cookie: cookie } })).json()).results, []);

      // Two-step sign-in for the reader: setup, confirm, sign in with a code, recovery code works once.
      const totp = require('../src/lib/totp');
      const readerLogin = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', passphrase: 'another secure phrase' }) });
      const readerCookie = readerLogin.headers.get('set-cookie').split(';', 1)[0];
      const asReaderJson = (url, body) => fetch(`${baseUrl}${url}`, { method: 'POST', headers: { Cookie: readerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const setup = await (await asReaderJson('/api/account/totp/setup', {})).json();
      assert.match(setup.otpauth_url, /^otpauth:\/\/totp\/Endpaper%3Areader\?secret=/);
      assert.equal((await asReaderJson('/api/account/totp/enable', { code: '000000' })).status, 400);
      // Enrolling needs the current passphrase as well as a code from the new app.
      assert.equal((await asReaderJson('/api/account/totp/enable', { code: totp.codeAt(setup.secret, totp.currentStep()) })).status, 400);
      assert.equal((await asReaderJson('/api/account/totp/enable', { code: totp.codeAt(setup.secret, totp.currentStep()), passphrase: 'wrong phrase here' })).status, 400);
      const enabled = await (await asReaderJson('/api/account/totp/enable', { code: totp.codeAt(setup.secret, totp.currentStep()), passphrase: 'another secure phrase' })).json();
      assert.equal(enabled.recovery_codes.length, 8);
      const signIn = body => fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', passphrase: 'another secure phrase', ...body }) });
      const needsCode = await signIn({});
      assert.equal(needsCode.status, 401);
      assert.equal((await needsCode.json()).totp_required, true);
      assert.equal((await signIn({ code: totp.codeAt(setup.secret, totp.currentStep() + 1) })).status, 200);
      assert.equal((await signIn({ code: enabled.recovery_codes[0] })).status, 200);
      assert.equal((await signIn({ code: enabled.recovery_codes[0] })).status, 401);
      assert.equal((await asReaderJson('/api/account/totp/disable', { code: enabled.recovery_codes[1] })).status, 200);
      assert.equal((await signIn({})).status, 200);
      // An admin passphrase reset is the way back for a lost authenticator: it turns two-step sign-in off.
      const readerId = database.prepare("SELECT id FROM users WHERE username = 'reader'").get().id;
      database.prepare("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_recovery = '[]' WHERE id = ?").run(readerId);
      assert.equal((await signIn({})).status, 401);
      const reset = await fetch(`${baseUrl}/api/users/${readerId}`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'another secure phrase' }) });
      assert.equal(reset.status, 200);
      assert.equal(database.prepare('SELECT totp_secret FROM users WHERE id = ?').get(readerId).totp_secret, null);
      assert.equal((await signIn({})).status, 200);
      // Leave the reader with no sessions for the device-list checks further down.
      database.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'reader')").run();

      // OPDS: reading apps use the username plus a revocable app key (never the passphrase).
      const basic = (user, key) => ({ Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}` });
      assert.equal((await fetch(`${baseUrl}/opds`)).status, 401);
      const appKey = await (await jsonPost('/api/account/opds', {})).json();
      assert.ok(appKey.key && appKey.key.length >= 20);
      assert.equal((await fetch(`${baseUrl}/opds`, { headers: basic('admin', 'wrong-key') })).status, 401);
      assert.equal((await fetch(`${baseUrl}/opds`, { headers: basic('admin', 'correct horse battery') })).status, 401);
      const root = await fetch(`${baseUrl}/opds`, { headers: basic('ADMIN', appKey.key) });
      assert.equal(root.status, 200);
      assert.match(root.headers.get('content-type'), /application\/atom\+xml.*kind=navigation/);
      const allFeed = await (await fetch(`${baseUrl}/opds/all`, { headers: basic('admin', appKey.key) })).text();
      assert.match(allFeed, new RegExp(`urn:uuid:${uploaded.id}`));
      assert.match(allFeed, new RegExp(`/opds/books/${uploaded.id}/file`));
      const searchFeed = await (await fetch(`${baseUrl}/opds/search?q=chapter`, { headers: basic('admin', appKey.key) })).text();
      assert.match(searchFeed, new RegExp(uploaded.id));
      const download = await fetch(`${baseUrl}/opds/books/${uploaded.id}/file`, { headers: basic('admin', appKey.key) });
      assert.equal(download.status, 200);
      assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), epub), 0);
      assert.equal((await fetch(`${baseUrl}/api/account/opds`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/opds`, { headers: basic('admin', appKey.key) })).status, 401);

      // Finishing a book is dated, and stats expose goals, calendar, per-book time and the year so far.
      assert.equal((await (await patchBook({ status: 'finished' })).json()).status, 'finished');
      assert.ok(database.prepare('SELECT finished_at FROM user_books WHERE book_id = ?').get(uploaded.id).finished_at);
      const richStats = await (await fetch(`${baseUrl}/api/stats`, { headers: { Cookie: cookie } })).json();
      assert.equal(richStats.calendar.length, 365);
      assert.equal(richStats.books_finished_this_year, 1);
      assert.equal(richStats.year_review.books_finished[0].book_id, uploaded.id);
      assert.ok(richStats.per_book.some(item => item.book_id === uploaded.id && item.seconds > 0));
      assert.equal(typeof richStats.today_seconds, 'number');
      assert.equal((await (await patchBook({ status: 'reading' })).json()).status, 'reading');
      assert.equal(database.prepare('SELECT finished_at FROM user_books WHERE book_id = ?').get(uploaded.id).finished_at, null);

      // Bookmarks can be renamed and carry a note.
      const bookmark = await (await jsonPost(`/api/books/${uploaded.id}/bookmarks`, { cfi: 'epubcfi(/6/2!/4/2)', chapter: 'Chapter One', progress_percent: 5 })).json();
      const editBookmark = body => fetch(`${baseUrl}/api/bookmarks/${bookmark.id}`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const renamed = await (await editBookmark({ label: 'The storm', note: 'Reread before book two' })).json();
      assert.equal(renamed.label, 'The storm');
      assert.equal(renamed.note, 'Reread before book two');
      assert.equal((await editBookmark({})).status, 400);

      // Personal shelving: want to read and private tags.
      const wanted = await (await patchBook({ want_to_read: true, user_tags: 'Holiday, holiday , Re-read' })).json();
      assert.equal(wanted.want_to_read, true);
      assert.deepEqual(wanted.user_tags, ['holiday', 're-read']);
      assert.equal((await patchBook({ want_to_read: 'yes' })).status, 400);
      const wantList = await (await fetch(`${baseUrl}/api/books?filter=want`, { headers: { Cookie: cookie } })).json();
      assert.deepEqual(wantList.books.map(item => item.id), [uploaded.id]);

      // The same book uploaded again as a different file is flagged, not blocked.
      const sameTitle = database.prepare('SELECT title, author FROM books WHERE id = ?').get(uploaded.id);
      const lookalike = new FormData();
      // Same contents, different bytes: give the ZIP a one-byte archive comment.
      const variant = Buffer.concat([epub, Buffer.from('x')]);
      variant.writeUInt16LE(1, epub.length - 2);
      lookalike.append('file', new Blob([variant], { type: 'application/epub+zip' }), 'copy.epub');
      const lookalikeUpload = await fetch(`${baseUrl}/api/books`, { method: 'POST', headers: { Cookie: cookie }, body: lookalike });
      const lookalikeBook = await lookalikeUpload.json();
      assert.equal(lookalikeUpload.status, 201, JSON.stringify(lookalikeBook));
      assert.equal(lookalikeBook.title, sameTitle.title);
      assert.equal(lookalikeBook.possible_duplicate?.id, uploaded.id);
      assert.equal((await fetch(`${baseUrl}/api/books/${lookalikeBook.id}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);

      // A damaged archive is the uploader's problem: 400 with a plain message, not 500.
      const damaged = new FormData();
      damaged.append('file', new Blob([Buffer.concat([epub, Buffer.from('junk')])], { type: 'application/epub+zip' }), 'damaged.epub');
      const damagedUpload = await fetch(`${baseUrl}/api/books`, { method: 'POST', headers: { Cookie: cookie }, body: damaged });
      assert.equal(damagedUpload.status, 400);
      assert.match((await damagedUpload.json()).error, /not a readable EPUB/);

      // Cover replacement re-encodes the image; ISBN lookup validates before any network call.
      const sharp = require('sharp');
      const png = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#336699' } }).png().toBuffer();
      const coverBody = new FormData();
      coverBody.append('file', new Blob([png], { type: 'image/png' }), 'cover.png');
      const coverResponse = await fetch(`${baseUrl}/api/books/${uploaded.id}/cover`, { method: 'POST', headers: { Cookie: cookie }, body: coverBody });
      assert.equal(coverResponse.status, 200);
      assert.match((await coverResponse.json()).cover_path, /^[0-9a-f-]{36}\.webp$/);
      const coverImage = await fetch(`${baseUrl}/api/books/${uploaded.id}/cover`, { headers: { Cookie: cookie } });
      assert.equal(coverImage.status, 200);
      assert.equal((await fetch(`${baseUrl}/api/books/${uploaded.id}/lookup?isbn=not-an-isbn`, { headers: { Cookie: cookie } })).status, 400);

      // Rows written by older builds (unbounded EPUB metadata, fractional
      // ratings) must not stop the app's own backup from restoring.
      database.prepare('UPDATE books SET description = ?, tags = ?, cover_color = ? WHERE id = ?')
        .run('d'.repeat(6000), 't'.repeat(800), 'red"><b>', uploaded.id);
      database.prepare('UPDATE user_books SET rating = 3.5 WHERE book_id = ?').run(uploaded.id);
      assert.equal((await fetch(`${baseUrl}/api/export`, { headers: { Cookie: cookie } })).status, 404);
      const exported = await fetch(`${baseUrl}/api/export`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(exported.status, 200);
      const importBody = new FormData();
      const backupBytes = await exported.arrayBuffer();
      importBody.append('file', new Blob([backupBytes], { type: 'application/zip' }), 'backup.zip');
      // A dry run reports what would happen and changes nothing.
      const previewBody = new FormData();
      previewBody.append('file', new Blob([backupBytes], { type: 'application/zip' }), 'backup.zip');
      const booksBefore = database.prepare('SELECT COUNT(*) AS n FROM books').get().n;
      const preview = await (await fetch(`${baseUrl}/api/import?dry_run=1`, { method: 'POST', headers: { Cookie: cookie }, body: previewBody })).json();
      assert.equal(preview.dry_run, true);
      assert.equal(preview.books_total, booksBefore);
      assert.equal(preview.books_new, 0);
      assert.equal(preview.adjustments.length, 4);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM books').get().n, booksBefore);
      const imported = await fetch(`${baseUrl}/api/import`, { method: 'POST', headers: { Cookie: cookie }, body: importBody });
      const importResult = await imported.json();
      assert.equal(imported.status, 200, JSON.stringify(importResult));
      assert.equal(importResult.adjustments.length, 4, JSON.stringify(importResult.adjustments));

      // Self-service account security, exercised as the non-admin reader.
      const loginAs = async (passphrase, userAgent) => {
        const response = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
          body: JSON.stringify({ username: 'reader', passphrase }),
        });
        return { status: response.status, cookie: (response.headers.get('set-cookie') || '').split(';', 1)[0] };
      };
      const asReader = (readerCookie, url, init = {}) => fetch(`${baseUrl}${url}`, {
        ...init, headers: { Cookie: readerCookie, 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      const sessionStatus = async readerCookie => (await asReader(readerCookie, '/api/session')).status;
      const phone = await loginAs('another secure phrase', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
      const laptop = await loginAs('another secure phrase', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36');
      assert.equal(phone.status, 200);
      assert.equal(laptop.status, 200);

      const listed = await (await asReader(laptop.cookie, '/api/account/sessions')).json();
      assert.equal(listed.sessions.length, 2);
      const phoneSession = listed.sessions.find(session => !session.current);
      const laptopSession = listed.sessions.find(session => session.current);
      assert.equal(phoneSession.label, 'Safari on iPhone');
      assert.equal(laptopSession.label, 'Chrome on Windows');
      assert.match(phoneSession.id, /^[0-9a-f]{16}$/);
      assert.ok(!JSON.stringify(listed).includes(database.prepare('SELECT token FROM sessions WHERE substr(token, 1, 16) = ?').get(phoneSession.id).token));

      // A wrong current passphrase is rejected without ending the caller's session.
      const wrongCurrent = await asReader(laptop.cookie, '/api/account/passphrase', { method: 'POST', body: JSON.stringify({ current: 'not my passphrase', next: 'a brand new passphrase' }) });
      assert.equal(wrongCurrent.status, 400);
      assert.equal(await sessionStatus(laptop.cookie), 200);

      assert.equal((await asReader(laptop.cookie, `/api/account/sessions/${laptopSession.id}`, { method: 'DELETE' })).status, 400);
      assert.equal((await asReader(laptop.cookie, `/api/account/sessions/${phoneSession.id}`, { method: 'DELETE' })).status, 200);
      assert.equal(await sessionStatus(phone.cookie), 401);

      // Changing the passphrase signs out every other device but keeps this one.
      const tablet = await loginAs('another secure phrase', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1');
      const changed = await asReader(laptop.cookie, '/api/account/passphrase', { method: 'POST', body: JSON.stringify({ current: 'another secure phrase', next: 'a brand new passphrase' }) });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).signed_out_sessions, 1);
      assert.equal(await sessionStatus(tablet.cookie), 401);
      assert.equal(await sessionStatus(laptop.cookie), 200);
      assert.equal((await loginAs('another secure phrase', 'test')).status, 401);

      const desktop = await loginAs('a brand new passphrase', 'test');
      assert.equal(desktop.status, 200);
      const revoked = await asReader(laptop.cookie, '/api/account/sessions/revoke-others', { method: 'POST' });
      assert.equal((await revoked.json()).signed_out_sessions, 1);
      assert.equal(await sessionStatus(desktop.cookie), 401);
      assert.equal(await sessionStatus(laptop.cookie), 200);
      // The audit log records admin changes, never secret values, and only admins can read it.
      const audit = await (await fetch(`${baseUrl}/api/admin/audit?limit=200`, { headers: { Cookie: cookie } })).json();
      const actions = audit.entries.map(entry => entry.action);
      for (const action of ['book.add', 'user.create', 'book.cover', 'library.import', 'library.export', 'account.two_factor_on']) assert.ok(actions.includes(action), `${action} missing from ${actions.join(',')}`);
      assert.ok(!JSON.stringify(audit).includes('another secure phrase'));
      const auditReader = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', passphrase: 'a brand new passphrase' }) });
      assert.equal(auditReader.status, 200);
      assert.equal((await fetch(`${baseUrl}/api/admin/audit`, { headers: { Cookie: auditReader.headers.get('set-cookie').split(';', 1)[0] } })).status, 403);

      // Metrics need the bearer token and expose only counts.
      assert.equal((await fetch(baseUrl + '/metrics')).status, 401);
      const metrics = await (await fetch(baseUrl + '/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } })).text();
      assert.match(metrics, /^endpaper_books \d+$/m);
      assert.match(metrics, /endpaper_http_requests_total\{method="GET",status="2xx"\} \d+/);
      assert.doesNotMatch(metrics, /admin|reader/);
    } finally { database.close(); }
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
