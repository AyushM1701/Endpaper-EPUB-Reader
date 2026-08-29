# Deploying Endpaper

This guide deploys Endpaper to a VPS with Docker, Caddy, and automatic HTTPS. Endpaper is a multi-user shared library: every signed-in user sees the same books and collections, while each account has its own private reading state.

## Prerequisites

- A VPS (for example, DigitalOcean, Linode, or Hetzner) with Docker and Docker Compose installed
- A domain name you control (for example, `books.yourdomain.com`)
- SSH access to the VPS

## 1. Point DNS at the VPS

Create an **A record** for your chosen subdomain pointing to the VPS IP address:

```text
books.yourdomain.com.  ->  A  ->  203.0.113.42
```

Allow a few minutes for DNS propagation. You can verify it with:

```bash
dig books.yourdomain.com +short
```

## 2. Copy the project to the VPS

```bash
ssh your-user@your-vps-ip
git clone <your-repo-url> /opt/endpaper
cd /opt/endpaper
```

Alternatively, use `scp` or `rsync` to copy the project files.

## 3. Configure the domain

Edit `Caddyfile` and replace `books.yourdomain.com` with your actual domain:

```bash
nano Caddyfile
```

```caddyfile
books.yourdomain.com {
  reverse_proxy app:3000
}
```

## 4. Start the stack

```bash
docker compose up -d
```

On first boot, the app initializes its SQLite database and creates the `data/` directory structure. Caddy automatically obtains and renews a Let's Encrypt TLS certificate once DNS is correct and ports 80 and 443 are reachable.

Endpaper stores random session tokens in its database; do not add a `SESSION_SECRET` environment variable. It is not used by the application.

## 5. Create the first admin account

Run the account CLI inside the app container, replacing both values:

```bash
docker compose exec app node src/lib/passphrase.js --set "a long unique passphrase" admin
```

The CLI syntax is:

```bash
node src/lib/passphrase.js --set "<passphrase>" [username]
```

The username defaults to `admin`. A new username creates an admin account; an existing username has its passphrase reset without changing its role and is signed out on all devices.

## 6. Verify and add household accounts

Open `https://books.yourdomain.com` and sign in with the username and passphrase from the previous step.

Your first account is an admin. Use **Admin Settings** to add friends and family as readers. Readers can browse, read, and contribute new books to the shared catalogue, while progress, annotations, ratings, sessions, and settings remain private. Only admins can manage users, remove shared books, edit shared metadata, organize collections, or use backup import/export.

## Updating

To update to a new version:

```bash
cd /opt/endpaper
git pull
docker compose build
docker compose up -d
```

Your persistent data remains in the bind-mounted `data/` directory.

## Native Deployment with PM2 (Alternative to Docker)

If you prefer not to use Docker, you can run Endpaper natively on your VPS using Node.js and PM2.

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url> /opt/endpaper
   cd /opt/endpaper/server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the app with PM2:**
   ```bash
   npm install -g pm2
   pm2 start src/index.js --name "endpaper"
   pm2 save
   pm2 startup
   ```

4. **Create the first admin account:**
   Instead of using `docker compose exec`, you can run the script natively:
   ```bash
   node src/lib/passphrase.js --set "a long unique passphrase" admin
   ```

5. **Updating the app:**
   ```bash
   git pull origin main
   npm install
   pm2 restart endpaper
   ```

## Backups

> **Important:** The VPS may hold the only copy of your library. Back up the entire `data/` directory regularly; it contains the SQLite database, EPUBs, and covers.

### Option 1: Manual backup

```bash
tar czf endpaper-backup-$(date +%Y%m%d).tar.gz data/
scp endpaper-backup-*.tar.gz your-local-machine:/backups/
```

### Option 2: Automated backup (cron)

```bash
crontab -e
```

Add a daily backup:

```text
0 3 * * * cd /opt/endpaper && tar czf /backups/endpaper-$(date +\%Y\%m\%d).tar.gz data/
```

### Option 3: In-app export

An admin can use **Export backup** in Endpaper. The archive includes the shared library and supported per-user reading data, but excludes password hashes, admin flags, and login sessions.

On import, shared books and collections are merged. User accounts and roles are never created or changed. Personal data is restored only for an existing local account with an exact matching username, so import only backups you trust and keep a fresh export before importing.

## Resetting an account passphrase

Run the same CLI with the account's username:

```bash
docker compose exec app node src/lib/passphrase.js --set "new passphrase" admin
```

For a reader account, replace `admin` with that reader's username. This command does not change whether the account is an admin or reader.

## Troubleshooting

### Caddy will not start or HTTPS is unavailable

- Ensure ports 80 and 443 are open in the VPS firewall.
- Ensure the DNS A record is correct and has propagated.
- Check Caddy logs: `docker compose logs caddy`.

### The app will not start

- Check app logs: `docker compose logs app`.
- Ensure `data/` exists and is writable by Docker.
- Rebuild if needed: `docker compose build --no-cache`.

### Login fails because no account exists

Create the first admin account with the command in step 5, then sign in using both its username and passphrase.
