# Endpaper

Endpaper is a self-hosted EPUB reader for a trusted household or group of friends. It has one shared library: every signed-in user can browse and read the same books and collections, while each person keeps their own reading progress, ratings, bookmarks, highlights, sessions, statistics, and reader settings.

## Roles

Endpaper has two roles:

- **Reader** - Can browse, read, and contribute new books to the shared library. Their reading activity and annotations are private to their account.
- **Admin** - Has all reader permissions and can manage users, remove shared books, edit shared book metadata, organize collections, and export or import backups.

Use an admin account for yourself and add friends and family as readers from **Admin Settings** after the first sign-in. Grant admin access only to people who should be able to change the library for everyone.

## Features

- **Shared library shelf** - One EPUB catalogue with cover art and shared collections for everyone.
- **Private reading state** - Per-user progress, status, ratings, bookmarks, highlights, reading time, and settings.
- **Full EPUB reader** - Paginated and scrolled layouts, customizable fonts, themes, spacing, gestures, text-to-speech controls, and in-book search.
- **Library discovery** - Smart shelves, multi-book continue reading, metadata search, sorting, filters, bulk actions, and a global highlights notebook.
- **Offline-capable PWA** - Explicit per-book downloads, range-aware offline reading, queued reading-state sync, and safe deferred updates. After an online sign-in on a device, a fresh offline launch can restore that account's encrypted library snapshot with the same passphrase and open downloaded books.
- **Reading insights** - Goals, streaks, comparisons, monthly trends, favorite books, and personalized time estimates.
- **Admin tools** - Create reader/admin accounts and maintain the shared catalogue.
- **Backup and restore** - Admin-only backup exports and imports for the shared library and supported personal reading data.
- **Responsive UI** - Works across phones, tablets, and desktop browsers.

The Atkinson Hyperlegible and Work Sans reader fonts are bundled for offline use. Their redistribution terms are in `public/fonts/ATKINSON-OFL.txt` and `public/fonts/WORK-SANS-LICENSE.txt`.

To prepare for a cold offline launch, open **More → Offline downloads** while connected. If prompted, enter your passphrase once to enable offline access on that device, then download the books you want. The app verifies that its shell, encrypted library snapshot, and book bytes are stored before confirming a download. When offline, open the installed Endpaper app and unlock with the same username and passphrase; it takes you directly to your downloads. Books that have not been downloaded still require the server. Offline installation needs a secure origin (HTTPS or localhost); a plain HTTP address on a local network cannot install the service worker.

## Reliability and security

- EPUB uploads and backup imports are validated, size-limited, and restricted to safe library file paths.
- Only admins can change shared catalogue structure and management: removing books, editing shared book metadata, collections, collection memberships, users, exports, and imports.
- Authentication uses high-entropy session tokens stored by the server in secure HTTP-only cookies. There is no `SESSION_SECRET` environment variable to configure.
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

Endpaper requires Node.js 20 or newer.

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

Once signed in as an admin, use **Admin Settings** to create reader accounts for the people sharing the library. `GET /healthz` is an unauthenticated health check for reverse proxies and uptime monitors.

### Existing books and reading estimates

New uploads receive a bounded spine-text word count. To fill counts for books uploaded before this feature, stop the server, back up `data/`, then run `npm run reindex-books` from `server/`. Books whose text exceeds the extraction limits keep an unknown count instead of a misleading partial estimate.

Personalized reading pace uses progress gained during completed reading sessions. Sessions with no measurable progress or an implausible pace are excluded, and an estimate appears only after enough reading data has accumulated.

### Tests

From `server/`, run `npm test` for backend and source checks. For browser regressions, run `npx playwright install webkit` once, then `npm run test:e2e`. The WebKit suite starts an isolated server and covers the mobile shell in portrait and landscape, EPUB rendering, rapid touch swipes, failed seek recovery, image-only pages, offline pinning and deletion cleanup, Reader uploads, hostile metadata, mobile sheet focus, status normalization, and the desktop shelf. The cold offline restart regression runs in Chromium with `npx playwright test --browser chromium -g "cold offline restart"` because Playwright's WebKit offline reload currently fails inside its browser harness.

When changing the app shell, bump the shared build version in `public/sw.js` and the asset query strings in `public/index.html` so a waiting worker keeps one coherent version of the shell.

## Backups

Export and import are admin-only. An export includes EPUBs, covers, shared books and collections, and supported personal reading data. It excludes credentials, admin status, and login sessions.

The server's automatic daily files in `data/backups/` are SQLite snapshots for database recovery; they do not contain EPUB or cover files. Back up the complete `data/` directory or download an in-app export when you need a portable, full-library backup.

Import is a merge: existing shared books are preserved and missing shared records are added. Local users and their roles are never changed. Personal data from a backup is applied only when its username exactly matches an existing local account; data for other usernames is skipped. Export before importing a backup from another device, and import only archives you trust.

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
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pm2
   ```
4. **Deploy Endpaper:**
   ```bash
   git clone <your-repo-url> /opt/endpaper
   cd /opt/endpaper/server
   npm ci --omit=dev

   # Create your initial admin account
   node src/lib/passphrase.js --set "your-secure-passphrase" admin

   # Start Endpaper with PM2 daemon process manager
   pm2 start src/index.js --name "endpaper"
   pm2 save
   pm2 startup
   ```
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
3. Access Endpaper securely from anywhere via the host's private Tailscale IP (e.g. `http://100.x.y.z:3001`).

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

> **Note:** All your books (`data/books/`), covers (`data/covers/`), and SQLite database (`data/endpaper.db`) remain completely intact in the persistent `data/` directory. Database migrations execute automatically when the server boots.
