# Endpaper

Endpaper is a self-hosted EPUB reader for a trusted household or group of friends. It has one shared library: every signed-in user can browse and read the same books and collections, while each person keeps their own reading progress, ratings, bookmarks, highlights, sessions, statistics, and reader settings.

## Roles

Endpaper has two roles:

- **Reader** - Can browse, read, and contribute new books to the shared library. Their reading activity and annotations are private to their account.
- **Admin** - Has all reader permissions and can manage users, remove shared books, edit shared book metadata, organize collections, and export or import backups.

Use an admin account for yourself and add friends and family as readers from **Account → People & permissions** after the first sign-in. Grant admin access only to people who should be able to change the library for everyone.

## Features

- **Shared library shelf** - One EPUB catalogue with cover art and shared collections for everyone.
- **Consistent desktop and mobile UI** - A desktop sidebar and cover shelves, the familiar phone layout, shared light/dark colors, accessible dropdowns, visible ratings, and motion that respects reduced-motion preferences. Uploaded cover art is preserved.
- **Private reading state** - Per-user progress, status, ratings, bookmarks, highlights, reading time, and settings.
- **Full EPUB reader** - Paginated and scrolled layouts; nine page themes including Light, Sepia and Paper white; fonts, weight, spacing, justification, hyphenation and an optional two-page spread; settings for one book only; gestures; read-aloud with saved voice settings and media-key controls; and in-book search.
- **Reusable page indexes** - Background calculation keeps reading available, and an account-scoped cache speeds up reopening a book without moving the saved reading position.
- **Library discovery** - Smart shelves (including Want to read and Recently highlighted), multi-book continue reading, search by metadata and **inside every book's text**, personal tags, grid/compact/list views, sorting, filters, bulk actions, and a global highlights notebook you can export as Markdown, CSV or Readwise-compatible JSON.
- **Reading apps (OPDS)** - KOReader, Moon+ Reader, Thorium and other OPDS apps can browse and download the library. Each person creates a revocable app key under **Account → Passphrase & devices**.
- **Calibre and folder import** - Add a whole folder of EPUBs from the browser, or import a Calibre library on the server with `npm run import-folder`, which also applies Calibre's series, tags, description and rating.
- **Offline-capable PWA** - Explicit per-book downloads, range-aware offline reading, queued reading-state sync, and safe deferred updates. After an online sign-in on a device, a fresh offline launch can restore that account's encrypted library snapshot with the same passphrase and open downloaded books.
- **Reading insights** - Goal progress (daily minutes, weekly hours, books per year), a reading calendar, time per book, a year in review, streaks, monthly trends and personalized time estimates. Reading time counts only while a book is on screen.
- **Admin tools** - Create reader/admin accounts, maintain the shared catalogue (including cover replacement and ISBN lookup from Open Library), and review a year of activity in an audit log.
- **Account security** - Change your own passphrase, see and sign out signed-in devices, and turn on two-step sign-in with any authenticator app.
- **Backup and restore** - Admin-only backup exports and imports for the shared library and supported personal reading data.
- **Responsive UI** - Works across phones, tablets, and desktop browsers.

The Atkinson Hyperlegible and Work Sans reader fonts are bundled for offline use. Their redistribution terms are in `public/fonts/ATKINSON-OFL.txt` and `public/fonts/WORK-SANS-LICENSE.txt`.

To prepare for a cold offline launch, open **More → Offline downloads** while connected. If prompted, enter your passphrase once to enable offline access on that device, then download the books you want. The app verifies that its shell, encrypted library snapshot, and book bytes are stored before confirming a download. When offline, open the installed Endpaper app and unlock with the same username and passphrase; it takes you directly to your downloads. Books that have not been downloaded still require the server. Offline installation needs a secure origin (HTTPS or localhost); a plain HTTP address on a local network cannot install the service worker.

## Reliability and security

- EPUB uploads and backup imports are validated, size-limited, and restricted to safe library file paths.
- Only admins can change shared catalogue structure and management: removing books, editing shared book metadata, collections, collection memberships, users, exports, and imports.
- Authentication uses high-entropy session tokens in HTTP-only, SameSite=Strict cookies, marked `Secure` whenever the request arrived over HTTPS. The database stores only a SHA-256 hash of each token. Sessions slide forward while in use and end after 30 days unused (`SESSION_IDLE_DAYS`). There is no `SESSION_SECRET` to configure.
- Optional two-step sign-in (TOTP) with single-use recovery codes. Login attempts are rate limited per account and per IP.
- The Content-Security-Policy forbids inline scripts (`script-src 'self'`), so injected markup cannot run code.
- Nothing you read leaves your server unless you ask: the reader's **Define** action sends the selected word to `dictionaryapi.dev`, and an admin's **Look up by ISBN** asks `openlibrary.org` about that ISBN. Neither runs automatically.
- Backups never include password hashes, admin flags, or login sessions. On import, shared books and collections are restored; personal reading data is restored only for existing local users with an exact matching username. Imports never create accounts or change roles, and unmatched personal data is skipped.

## Architecture

```text
server/         Node.js + Express backend
  src/
    index.js    Express app entry point and backup endpoints
    db.js       SQLite connection and schema migrations
    middleware/ Session authentication
    routes/     API routes for auth, users, books, reading data, and collections
public/         Frontend (single-page HTML/CSS/JS reader)
data/           Persistent SQLite database, EPUB files, covers, and backups
```

## Local development and setup

Endpaper requires Node.js 22 or newer.

```bash
cd server
npm ci

# Create the first admin account. Replace both values with your own.
npm run set-passphrase -- "a long unique passphrase" admin

# Start the server (port 3001 by default)
npm run start
```

Open `http://localhost:3001`, then sign in with the username and passphrase you chose. The CLI syntax is:

```bash
node src/lib/passphrase.js --set "<passphrase>" [username]
```

The username defaults to `admin`. For a new username, this command creates an admin account; for an existing username, it resets that account's passphrase without changing its role and signs that account out on all devices.

Once signed in as an admin, use **Account → People & permissions** to create reader accounts for the people sharing the library. `GET /healthz` is an unauthenticated health check for reverse proxies and uptime monitors.

### Existing books and reading estimates

New uploads receive a bounded spine-text word count. To fill counts for books uploaded before this feature, stop the server, back up `data/`, then run `npm run reindex-books` from `server/`. Books whose text exceeds the extraction limits keep an unknown count instead of a misleading partial estimate.

Personalized reading pace uses progress gained during completed reading sessions. Sessions with no measurable progress or an implausible pace are excluded, and an estimate appears only after enough reading data has accumulated.

### Tests

From `server/`, run `npm test` for backend and source checks. For browser regressions, run `npx playwright install webkit chromium` once, then `npm run test:e2e`. The suite starts an isolated server with temporary data and covers desktop/mobile navigation, dropdowns and keyboard focus, EPUB scrolling and pagination, annotations, audio timing, page-index caching, account isolation, offline downloads, and updates. Run the complete suite again with `npx playwright test --browser chromium`; run browsers sequentially because they share the isolated test port. The cold offline restart check is skipped in Windows WebKit and exercised in Chromium because Playwright's WebKit offline reload currently fails inside its browser harness. Physical iPhone Safari and Home Screen behavior still needs device verification.

See the [2 October 2026 release verification](docs/final-verification-2026-10-02.md) for the final review findings and results.

When changing the app shell, bump the shared build version in `public/sw.js` and the asset query strings in `public/index.html` so a waiting worker keeps one coherent version of the shell.

## Backups

Export and import are admin-only. An export includes EPUBs, covers, shared books and collections, and supported personal reading data. It excludes credentials, admin status, and login sessions.

The server's automatic daily files in `data/backups/` are SQLite snapshots for database recovery; they do not contain EPUB or cover files. For a full, restorable backup (database, EPUBs and covers in the same format as an in-app export), run `npm run backup` from `server/`; it writes to `data/backups/full/` and keeps the newest three (`--keep 7` to change that). It is safe while the server runs. Set `FULL_BACKUP_EVERY_DAYS=1` to have the server do this every day. Copy those archives off the machine regularly.

Importing a backup first shows a preview of what will change (new books, matching accounts, values that will be adjusted) and only proceeds when you confirm.

Import is a merge: existing shared books are preserved and missing shared records are added. Local users and their roles are never changed. Personal data from a backup is applied only when its username exactly matches an existing local account; data for other usernames is skipped. Export before importing a backup from another device, and import only archives you trust.

## Configuration

All settings are optional environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `NODE_ENV` | — | Set `production` on servers |
| `TRUST_PROXY` | `loopback` | Which proxy's `X-Forwarded-*` headers to trust; set to your proxy's address if it is on another machine |
| `ENDPAPER_DATA_DIR` / `ENDPAPER_PUBLIC_DIR` | `../data`, `../public` | Data and frontend folders (the Docker image sets both) |
| `SESSION_IDLE_DAYS` | `30` | Sign a device out after this many days unused |
| `LOGIN_LIMIT_PER_ACCOUNT` / `LOGIN_LIMIT_PER_IP` / `LOGIN_LIMIT_WINDOW_MINUTES` | `5` / `50` / `15` | Failed sign-in limits |
| `FULL_BACKUP_EVERY_DAYS` / `FULL_BACKUP_KEEP` | off / `3` | Scheduled full-library backups |
| `METRICS_TOKEN` | off | Enables Prometheus metrics at `/metrics` (send `Authorization: Bearer <token>`) |
| `EPUB_WORKERS` | `2` | Parallel EPUB processing workers |
| `LOG_LEVEL` | `info` | pino log level |

### Reading apps (OPDS)

Under **Account → Passphrase & devices → Reading apps**, create an app key. In your reading app, add the catalogue `https://your-domain/opds` and sign in with your Endpaper username and that key. Revoke or replace the key there at any time; it never reveals your passphrase.

### Importing a Calibre library

From the browser, **Library tools → Add a folder of books** uploads every EPUB in a folder. For a large library on the server itself:

```bash
cd /opt/endpaper/server
npm run import-folder -- "/path/to/Calibre Library" --dry-run   # list what would be imported
npm run import-folder -- "/path/to/Calibre Library"             # import as the first admin
npm run import-folder -- "/path/to/Calibre Library" --user ana  # or as another account
```

Books already in the library are skipped. Calibre's `metadata.opf` (series and number, tags, description, ISBN, rating) is applied when present.

## Going live

### Option 1: Always Free Google Cloud VM + PM2 (Recommended — No Docker Needed)

Because Endpaper is a lightweight Node.js + SQLite application, you do **not** need Docker. Running Endpaper natively with **PM2** on Google Cloud's Always Free Linux VM (`e2-micro` with 30GB disk) gives you maximum performance with minimal RAM usage (~50MB RAM vs Docker overhead).

1. **Create the VM Instance:**
   - Go to Google Cloud Console → **Compute Engine** → **VM instances**.
   - Click **Create Instance** with machine type `e2-micro` in an Always Free region (`us-west1`, `us-central1`, or `us-east1`).
   - Set Boot Disk to **Ubuntu 22.04 / 24.04 LTS** (up to 30GB Standard Persistent Disk).
   - Under Firewall, check **Allow HTTP traffic** and **Allow HTTPS traffic**.
2. **Connect via SSH:**
   - In Google Cloud Console, click the **SSH** button next to your VM instance to open the terminal (or use `gcloud compute ssh <instance-name>`).
3. **Install Node.js & PM2:**
   ```bash
   sudo apt update && sudo apt install -y git curl
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pm2
   ```
   Node.js 22 is the minimum: Node 20 reached end of life in April 2026 and no longer receives security fixes.
4. **Deploy Endpaper:**
   ```bash
   # /opt is owned by root, so create the folder and hand it to your user first
   sudo mkdir -p /opt/endpaper && sudo chown "$USER": /opt/endpaper
   git clone <your-repo-url> /opt/endpaper
   cd /opt/endpaper/server
   npm ci --omit=dev

   # Create your initial admin account
   node src/lib/passphrase.js --set "your-secure-passphrase" admin

   # Start Endpaper with PM2 daemon process manager
   NODE_ENV=production pm2 start src/index.js --name "endpaper"
   ```
   Make PM2 start again after a VM reboot. `pm2 startup` does not enable anything by itself: it **prints** a `sudo env PATH=… pm2 startup systemd -u <you> --hp /home/<you>` command, which you must copy and run. Then save the process list:
   ```bash
   pm2 startup        # copy and run the sudo command it prints
   pm2 save
   systemctl status "pm2-$USER"   # should say "active"
   ```

   Endpaper trusts `X-Forwarded-For`/`X-Forwarded-Proto` only from a proxy on the same machine (`TRUST_PROXY=loopback` is the default), which matches Caddy on localhost. Login rate limits then see real client IPs, and the session cookie is marked `Secure` over HTTPS. If your proxy runs on a different host, set `TRUST_PROXY` to its address instead.
5. **Configure HTTPS Reverse Proxy (Caddy):**
   - Point your domain or free dynamic DNS hostname (e.g. from [DuckDNS](https://www.duckdns.org/)) to your VM's External IP address.
   - Install Caddy:
     ```bash
     sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
     curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
     curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
     sudo apt update && sudo apt install -y caddy
     ```
   - Edit `/etc/caddy/Caddyfile`:
     ```caddyfile
     books.yourdomain.com {
         reverse_proxy 127.0.0.1:3001
     }
     ```
   - Apply configuration:
     ```bash
     sudo systemctl restart caddy
     ```

### Option 2: Docker + Caddy

If you prefer containerized deployment, see the Docker guide in [DEPLOY.md](DEPLOY.md).

### Option 3: Private Mesh Network (Tailscale)

If you prefer running at home on a Raspberry Pi or local server without exposing ports to the public internet:
1. Install [Tailscale](https://tailscale.com/) on the host machine and your mobile devices / laptops.
2. Run Endpaper with `pm2` or `npm run start` on the host.
3. Expose it over HTTPS inside your tailnet with `tailscale serve --bg 3001`, then open the `https://<host>.<tailnet>.ts.net` address it prints. (Enable MagicDNS and HTTPS certificates in the Tailscale admin console first.)

> **Plain HTTP works, with limits.** Reading, progress, bookmarks and highlights work over `http://100.x.y.z:3001`, but browsers only enable some features on HTTPS: encrypted offline snapshots and the service worker are unavailable, so prefer `tailscale serve`.

---

## Updating an already live instance (through PM2)

To update your live server to the latest version of Endpaper:

```bash
# 1. Navigate to project root and pull latest changes
cd /opt/endpaper
git pull origin main

# 2. Install any dependency updates
cd server
npm ci --omit=dev

# 3. Restart the application seamlessly
pm2 restart endpaper
```

### Upgrading a PM2 install from before October 2026

Do these once, the first time you update past the October 2026 security release:

1. **Move to Node.js 22** if `node -v` shows v20 or older, then reinstall dependencies (bcrypt and better-sqlite3 contain native code built for one Node version):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
   cd /opt/endpaper/server && npm ci --omit=dev
   ```
2. **Restart with the production environment.** PM2 keeps the environment a process was first started with, so add `--update-env` this one time:
   ```bash
   NODE_ENV=production pm2 restart endpaper --update-env
   pm2 save
   ```
3. **Check that HTTPS is detected through Caddy.** This should print a `Strict-Transport-Security` line:
   ```bash
   curl -sI https://books.yourdomain.com/ | grep -i strict-transport
   ```
   If it prints nothing, Caddy is not on the same machine as Endpaper (or not proxying to `127.0.0.1`). Set `TRUST_PROXY` to your proxy's address and restart with `--update-env`.

What changes on first start: migrations run automatically after a database backup, and existing logins are converted to hashed tokens in place, so nobody is signed out. Reading time recorded before this release is not recalculated.

> **Note:** All your books (`data/books/`), covers (`data/covers/`), and SQLite database (`data/endpaper.db`) remain completely intact in the persistent `data/` directory. Database migrations execute automatically when the server boots.
