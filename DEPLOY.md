# Deploying Endpaper

Step-by-step guide to get Endpaper running on a fresh VPS with automatic HTTPS.

## Prerequisites

- A VPS (e.g., DigitalOcean, Linode, Hetzner) with Docker and Docker Compose installed
- A domain name you control (e.g., `books.yourdomain.com`)
- SSH access to the VPS

## 1. Point DNS at your VPS

Create an **A record** for your chosen subdomain pointing to the VPS IP address:

```
books.yourdomain.com.  →  A  →  203.0.113.42
```

Allow a few minutes for DNS propagation. You can verify with:

```bash
dig books.yourdomain.com +short
```

## 2. Clone or copy the project to the VPS

```bash
ssh your-user@your-vps-ip
git clone <your-repo-url> /opt/endpaper
cd /opt/endpaper
```

Or use `scp`/`rsync` to copy the files manually.

## 3. Configure the domain

Edit the `Caddyfile` and replace `books.yourdomain.com` with your actual domain:

```bash
nano Caddyfile
```

```
books.yourdomain.com {
  reverse_proxy app:3000
}
```

## 4. Set a session secret (optional but recommended)

Create a `.env` file or set the `SESSION_SECRET` environment variable:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
```

Docker Compose will pick this up automatically.

## 5. Start the stack

```bash
docker compose up -d
```

On first boot:
- The **app** container will initialize the SQLite database and create the `data/` directory structure
- The **caddy** container will automatically obtain a Let's Encrypt TLS certificate for your domain

This typically takes 10–30 seconds.

## 6. Set the passphrase

Run the passphrase-set CLI inside the running container:

```bash
docker compose exec app node src/lib/passphrase.js --set "your secret passphrase"
```

You should see:
```
✓ Passphrase set successfully.
  You can now log in to Endpaper with this passphrase.
```

## 7. Verify

Open `https://books.yourdomain.com` in your browser. You should see:
1. The Endpaper login gate
2. Enter your passphrase → you're in
3. Upload an EPUB to verify the full flow works

## Updating

To update to a new version:

```bash
cd /opt/endpaper
git pull
docker compose build
docker compose up -d
```

Your data is safe in the `data/` directory (bind-mounted volume).

## Backups

> **Important**: The VPS holds the only copy of your library. Regular backups of the `data/` directory are essential.

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
```
0 3 * * * cd /opt/endpaper && tar czf /backups/endpaper-$(date +\%Y\%m\%d).tar.gz data/
```

### Option 3: In-app export

Use the "Export backup" button in the Endpaper UI to download a zip containing all books and metadata.

## Changing the passphrase

```bash
docker compose exec app node src/lib/passphrase.js --set "new passphrase"
```

This invalidates any existing sessions — you'll need to log in again.

## Troubleshooting

### Caddy won't start / no HTTPS

- Ensure ports 80 and 443 are open in your firewall
- Ensure DNS A record is properly set and propagated
- Check Caddy logs: `docker compose logs caddy`

### App won't start

- Check app logs: `docker compose logs app`
- Ensure `data/` directory exists and is writable
- Rebuild: `docker compose build --no-cache`

### "No passphrase configured" error

Run the passphrase-set command (Step 6 above).
