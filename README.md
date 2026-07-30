# Endpaper

Endpaper is a self-hosted, single-user EPUB reader with a beautiful, premium book-like UI. It transforms a client-side reader into a robust personal library that securely syncs your books, progress, and highlights across all your devices using a Node.js and SQLite backend.

## Features

- **Full EPUB reader** — Paginated and scrolled layouts, customizable fonts, themes, and spacing.
- **Library Shelf** — A visual bookshelf with cover art automatically extracted from your uploaded EPUBs.
- **Collections Management** — Organize your books into custom collections (e.g., "Classics", "To Read").
- **Reading Statistics** — Tracks your reading streak, books finished, read time this week, and total reading time.
- **Bookmarks & Highlights** — Save your place and annotate text with colored highlights.
- **In-book Search** — Full-text search across all chapters.
- **Sorting & Filtering** — Filter your shelf by collections, or sort by progress, recently added, author, etc.
- **Export/Import** — Full ZIP backup and restore of your entire library (database + EPUB files).
- **Passphrase-Gated** — Single passphrase login via secure cookies, eliminating the need for complex user accounts.
- **Responsive** — Dynamically adapts to tight mobile screens or large desktop monitors.

## Reliability & security

- Search the shelf by title or author, and manage collections without affecting the books in them.
- Abandoned reading sessions are closed automatically when a new session begins, keeping reading statistics accurate.
- EPUB uploads and backup imports are validated, size-limited, and restricted to safe library file paths.
- Backups merge missing data and files into the current library; they never overwrite an existing EPUB.

## Architecture

Endpaper is built for simplicity and portability:
- **Backend:** Node.js + Express
- **Database:** SQLite (using `better-sqlite3`)
- **Frontend:** Vanilla HTML/CSS/JS (utilizing `epub.js`)

```text
server/         Node.js + Express backend
  src/
    index.js    Express app entry point
    db.js       SQLite connection & schema migration
    middleware/ Auth middleware (session cookie checks)
    routes/     API routes (books, sessions, stats, collections)
public/         Frontend (index.html containing all UI and logic)
data/           Persistent storage (SQLite DB, book files, covers)
```

---

## Local Development & Setup

To run Endpaper locally on your computer:

```bash
cd server
npm install

# Initialize your database and set your secure passphrase
npm run set-passphrase

# Start the server (runs on port 3001)
npm run start
```
Open `http://localhost:3001` in your browser.

Endpaper requires Node.js 20 or newer. `GET /healthz` is an unauthenticated health check for reverse proxies and uptime monitors.

### Backups

An export includes EPUBs, covers, progress, annotations, collections, and reader settings. Import is a safe merge: it adds missing records and files but does not overwrite an existing book. Export before importing a backup from another device.

---

## Going Live: Zero-Cost Deployment Guide

Because Endpaper stores files directly on the hard drive (SQLite and `.epub` files), it requires a permanent, persistent server. You have two fantastic, completely free options for accessing your library anywhere in the world.

### Option 1: The "Always Free" Cloud Server (Google Cloud)
Google Cloud provides one permanent Linux VM (`e2-micro`) with 30GB of storage for $0/month.

1. **Claim your free server:**
   - Go to Google Cloud Console -> **Compute Engine** -> **VM instances**.
   - Create an `e2-micro` instance in `us-west1`, `us-central1`, or `us-east1`.
   - Set Boot Disk to **Standard persistent disk** (up to 30GB) and OS to **Ubuntu**.
   - Under Firewall, check **Allow HTTP** and **Allow HTTPS**.
2. **Transfer your code:** Zip the Endpaper folder (without `node_modules`), use the browser SSH button, click "Upload file", and unzip it.
3. **Run the server:**
   ```bash
   cd Endpaper/server
   sudo apt install -y nodejs npm
   sudo npm install -g pm2
   npm install
   npm run set-passphrase
   pm2 start src/index.js --name "endpaper"
   pm2 save
   pm2 startup
   ```
4. **Expose securely via Caddy:** 
   - Claim a free domain (e.g., from [DuckDNS](https://www.duckdns.org/)).
   - Point the domain to your Google Cloud External IP.
   - Install [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) on your server.
   - Edit the Caddyfile (`sudo nano /etc/caddy/Caddyfile`):
     ```caddyfile
     yourdomain.duckdns.org {
         reverse_proxy 127.0.0.1:3001
     }
     ```
   - Run `sudo systemctl restart caddy`. You now have a secure, 24/7 cloud library!

### Option 2: The Private Mesh Network (Tailscale)
If you don't want to use Google Cloud, you can run Endpaper on a computer at home (like a Raspberry Pi or a laptop that stays on).

1. Install **[Tailscale](https://tailscale.com/)** on the computer running Endpaper and on your phone.
2. Sign into both devices with the same account.
3. Start the Endpaper server on your computer (`npm run start`).
4. Look at the Tailscale app on your computer to find your private Tailscale IP (e.g., `100.85.34.12`).
5. On your phone, navigate to `http://100.85.34.12:3001`. 

Your phone is now securely connected directly to your computer's library, completely invisible to the public internet!
