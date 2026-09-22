# Endpaper — Complete Architecture & Full Codebase Documentation

> **Project Name:** Endpaper  
> **Workspace Directory:** `C:\Users\AYUSH\Documents\Endpaper`  
> **Application Type:** Self-Hosted Multi-User EPUB Reader & Shared Digital Library  
> **Technology Stack:** Node.js (v20+), Express.js, `better-sqlite3` (WAL Mode), Worker Threads, Multer, Fast-XML-Parser, Sharp, Archiver, Yauzl, Bcrypt, Vanilla HTML5/CSS3/ES6+ JS, `ePub.js` Engine  
> **Deployment Model:** PM2 / Docker, Docker Compose, Caddy Reverse Proxy (Auto-HTTPS)  

---

## Table of Contents
1. [Part 1: Architecture and Technical Design](#part-1-architecture-and-technical-design)
   - [1. Executive System Overview & Design Principles](#1-executive-system-overview--design-principles)
   - [2. System Architecture & Component Interactions](#2-system-architecture--component-interactions)
   - [3. Database Architecture & Relational Schema](#3-database-architecture--relational-schema)
   - [4. Authentication, Security & Role-Based Access Control](#4-authentication-security--role-based-access-control)
   - [5. Reading Engine Architecture (EPUB.js Integration)](#5-reading-engine-architecture-epubjs-integration)
   - [6. Service Worker, Offline Caching & Synchronization Pipeline](#6-service-worker-offline-caching--synchronization-pipeline)
   - [7. Backup, Export, and Disaster Recovery Subsystem](#7-backup-export-and-disaster-recovery-subsystem)
   - [8. REST API Reference & Endpoint Directory](#8-rest-api-reference--endpoint-directory)
   - [9. Infrastructure & Deployment Topology](#9-infrastructure--deployment-topology)
   - [10. Project Directory & File Hierarchy](#10-project-directory--file-hierarchy)
2. [Part 2: Complete Project Source Code](#part-2-complete-project-source-code)

---

# Part 1: Architecture and Technical Design

## 1. Executive System Overview & Design Principles

**Endpaper** is a modern, lightweight, self-hosted web application tailored for reading and managing EPUB eBooks. It addresses a common challenge in household and private group hosting: **sharing a single curated digital book library while strictly isolating private reading metadata** (reading progress, CFI locations, annotations, bookmarks, reading session statistics, personal star ratings, and visual preferences).

### Core Architectural Principles
1. **Zero-Build Frontend**: The client is built exclusively with standard HTML5, CSS3 Custom Properties, and modern Vanilla ES6+ JavaScript. There is no Webpack, Vite, Babel, or TypeScript compilation step. This guarantees instant startup, transparent browser debugging, and effortless long-term maintainability.
2. **Embedded Relational Persistence**: Built on SQLite via `better-sqlite3` operating in Write-Ahead Logging (`WAL`) mode with schema versioning (`PRAGMA user_version = 3`) and pre-migration database snapshots. This provides ACID compliance, zero configuration overhead, high concurrency for simultaneous readers, and single-file database portability.
3. **PWA and Offline Resilience**: A custom Service Worker precaches the self-hosted application shell and reader dependencies (`epub.min.js`, `jszip.min.js`), supports cached byte ranges for EPUBs, and defers updates while a reader is active. Explicit offline downloads, range-aware caching, and an account-scoped, bounded, idempotent mutation queue (`client_operations` deduplication table) make offline state and later synchronization robust and transparent.
4. **Single-Process Lightweight Server with Bounded Worker Threads**: The backend is an Express.js Node.js server with EPUB metadata parsing and validation dispatched through a bounded worker queue. File hashing and large archive transfers use streams so startup and request handling remain responsive without memory spikes.
5. **Streaming & Memory Efficiency**: Large EPUB binary transfers support RFC 7233 HTTP single-range requests (206 Partial Content) with private cache headers. Full library export archives stream on-the-fly directly to the response with `archiver` with constant $O(1)$ memory usage. Imports use lazy ZIP iteration, bounded decompression limits (max 200:1 ratio, max entry bounds), isolated staging, and transactional database promotion with rollback cleanup.
6. **Production Simplicity**: Deployable in seconds via native PM2 process management or Docker Compose with Caddy for automatic Let's Encrypt / ZeroSSL TLS termination and HTTP/2 + HTTP/3 support.

---

## 2. System Architecture & Component Interactions

```mermaid
graph TD
    subgraph Client ["Client Layer (Browser / PWA)"]
        UI["Vanilla JS UI Engine (public/app.js)"]
        CSS["Design System & Theme Styles (public/app.css)"]
        DOM["Semantic HTML Shell (public/index.html)"]
        SW["Service Worker (public/sw.js)"]
        Reader["EPUB.js Engine (Viewer & Rendition)"]
        OffQ["Offline Mutation Queue (localStorage)"]
    end

    subgraph Transport ["Transport & Edge Security"]
        Caddy["Caddy Reverse Proxy (HTTPS / Auto-SSL / Compression)"]
    end

    subgraph Server ["Server Layer (Node.js / Express)"]
        Express["Express App (server/src/index.js)"]
        AuthMid["Auth Middleware (server/src/middleware/auth.js)"]
        RateLim["Rate Limiter & Brute-Force Shield"]
        Routes["API Route Handlers (server/src/routes/*.js)"]
        WorkerPool["Worker Threads (server/src/lib/epubWorker.js)"]
    end

    subgraph Storage ["Storage Layer (data/)"]
        DB[(SQLite DB: data/endpaper.db in WAL Mode)]
        EPUBs[("EPUB Store: data/books/")]
        Covers[("Cover Cache: data/covers/")]
        Backups[("Automated Backups: data/backups/")]
    end

    UI --> SW
    UI --> Reader
    UI --> OffQ
    UI -->|HTTP REST Requests (Cookies: session=...)| Caddy
    Caddy --> Express
    Express --> AuthMid
    Express --> RateLim
    RateLim --> Routes
    Routes --> WorkerPool
    Routes --> DB
    Routes --> EPUBs
    Routes --> Covers
    DB --> Backups
```

---

## 3. Database Architecture & Relational Schema

The SQLite schema is initialized in `server/src/db.js` using WAL mode (`PRAGMA journal_mode = WAL;`), foreign key constraints (`PRAGMA foreign_keys = ON;`), and a 5000ms busy timeout (`PRAGMA busy_timeout = 5000;`). Migrations are tracked with `PRAGMA user_version = 3`, with automated pre-migration safety snapshots created in `data/backups/`.

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : has
    USERS ||--o{ USER_BOOKS : tracks
    USERS ||--o{ BOOKMARKS : creates
    USERS ||--o{ HIGHLIGHTS : creates
    USERS ||--o{ READING_SESSIONS : records
    USERS ||--o{ SETTINGS : configures
    USERS ||--o{ CLIENT_OPERATIONS : logs
    BOOKS ||--o{ USER_BOOKS : associates
    BOOKS ||--o{ BOOK_COLLECTIONS : grouped_in
    BOOKS ||--o{ BOOKMARKS : contains
    BOOKS ||--o{ HIGHLIGHTS : contains
    BOOKS ||--o{ READING_SESSIONS : tracked_in
    COLLECTIONS ||--o{ BOOK_COLLECTIONS : includes

    USERS {
        text id PK
        text username UK "COLLATE NOCASE"
        text passphrase_hash
        integer is_admin
        text created_at
    }
    SESSIONS {
        text token PK
        text user_id FK
        text created_at
        text expires_at
    }
    BOOKS {
        text id PK
        text title
        text author
        text description
        text isbn
        text tags
        text filename
        text file_hash UK
        integer file_size
        text series
        real series_index
        text cover_path
        text cover_color
        text added_at
    }
    USER_BOOKS {
        text user_id FK
        text book_id FK
        text status
        integer rating
        real progress_percent
        text last_location_cfi
        text last_opened_at
    }
    COLLECTIONS {
        text id PK
        text name UK "COLLATE NOCASE"
    }
    BOOK_COLLECTIONS {
        text book_id FK
        text collection_id FK
    }
    BOOKMARKS {
        text id PK
        text user_id FK
        text book_id FK
        text cfi
        text chapter
        text label
        real progress_percent
        text created_at
    }
    HIGHLIGHTS {
        text id PK
        text user_id FK
        text book_id FK
        text cfi_range
        text excerpt
        text color
        text note
        text chapter
        text tags
        text created_at
    }
    READING_SESSIONS {
        text id PK
        text user_id FK
        text book_id FK
        text started_at
        text ended_at
        integer duration_seconds
        text client_id
    }
    SETTINGS {
        text user_id PK,FK
        text key PK
        text value
    }
    CLIENT_OPERATIONS {
        text user_id PK,FK
        text operation_id PK
        text response_json
        text created_at
    }
```

### Schema Tables & Indexes
1. **`users`**: Stores reader and administrator credentials. `username` is indexed with `COLLATE NOCASE` for case-insensitive logins and uniqueness.
2. **`sessions`**: Server-side storage for active authentication tokens with strict expiration timestamps (`expires_at`).
3. **`books`**: Shared metadata for books in the library. `file_hash` enforces SHA-256 uniqueness to reject duplicates upon upload. Includes rich fields: `description`, `isbn`, `tags`, `series`, `series_index`.
4. **`user_books`**: Per-user reading progress (`progress_percent`, `last_location_cfi`), read status (`unread`, `reading`, `finished`, `abandoned`), and personal 1–5 star ratings.
5. **`collections` & `book_collections`**: Shared organizational shelves with case-insensitive unique names.
6. **`bookmarks`**: User-specific saved positions with CFI, chapter title, custom label, and percentage progress.
7. **`highlights`**: Annotations and quotes with CFI range, selected excerpt, color swatch, note text, chapter name, and optional tags.
8. **`reading_sessions`**: Granular reading activity log with start/end timestamps, duration in seconds, and client operation ID for deduplication.
9. **`settings`**: Per-user appearance preferences (font family, font size, margins, line height, letter spacing, theme, layout flow, gesture preferences).
10. **`client_operations`**: Idempotency ledger storing client operation IDs and cached responses to prevent duplicate mutations during offline sync replay.

---

## 4. Authentication, Security & Role-Based Access Control

1. **User Roles**:
   - **Admin**: Full library and account administration permissions. Can upload books, remove books from shared library, edit shared metadata (title, author, series, ISBN, tags, description), manage global collections, trigger export/import backups, provision reader accounts, and manage user roles/passphrases.
   - **Reader**: Standard reading access to all books in the shared library. Can upload books, read, track personal progress, set bookmarks, create highlights/notes, rate books, and view personal reading analytics.
2. **Session Security & Credentials**:
   - Authenticated via secure `httpOnly` cookie-based session tokens (`endpaper_session`) with a 90-day expiry (`Max-Age=7776000`, `SameSite=Strict`).
   - Case-insensitive username uniqueness is enforced at both the database level (`username TEXT NOT NULL UNIQUE COLLATE NOCASE` with index `idx_users_username_nocase`) and application level (`WHERE lower(username) = lower(?)`).
   - Passphrases are hashed using `bcrypt` with salt rounds of 10. Minimum passphrase length of 12 characters is enforced for account creation and resets.
   - Background hourly pruning purges expired session tokens without impacting request hot paths.
3. **Brute-Force Protection & Account Management**:
   - IP-based rate limiting on `POST /api/login` prevents brute-force credential stuffing.
   - Admin `PATCH /api/users/:id` endpoint enables role updates and passphrase resets with automatic session revocation and self-demotion prevention.

---

## 5. Reading Engine Architecture (EPUB.js Integration)

- **Rendering Modes**:
  - **Paginated Mode**: Columnar pagination with horizontal keyboard navigation (`ArrowLeft`, `ArrowRight`), touch swipe gestures, and click nav zones.
  - **Scrolled Continuous Mode**: Continuous vertical reading stream (`flow: 'scrolled', manager: 'continuous'`) with smooth scrolling and live passive scroll progress tracking.
- **Dynamic Theming System**:
  - Four distinct reading themes: **Light** (`#F6F1E7`), **Sepia** (`#EBDCC0`), **Dark** (`#22262C`), and **Night** (`#000000`).
  - Themes inject scoped CSS overrides into the EPUB iframe body, paragraphs, and headings while dynamically aligning the app shell background (`--reader-page-bg`) and mobile browser theme color meta tags.
- **EPUB File Loading — Blob URL Pattern (R-16)**:
  - `api.getBookFile()` fetches the EPUB and stores it as a `Blob` (not `ArrayBuffer`) in a 24 MB LRU cache (`epubBlobCache`).
  - A `blob://` URL is created via `URL.createObjectURL(blob)` and passed directly to `ePub()`. This avoids the `.slice(0)` copy that previously doubled peak memory usage for large books.
  - The active `currentBlobUrl` is revoked in `discardReaderState()` so the browser can immediately reclaim the underlying EPUB data.
  - Book warmup is **disabled on touch/mobile devices** (R-17/R-18) — `scheduleBookWarmup()` checks `(hover: none) and (pointer: coarse)` and skips prefetch when true.
- **Overlay Chrome Architecture (R-13 v2)**:
  - `#topbar` and `#progress-bar` are removed from document flow during reader mode (`body.reader-active`) and become `position:fixed` overlays via CSS. Chrome show/hide uses CSS `transform: translateY(±110%)` + `opacity` transitions rather than `height:0` collapse.
  - This eliminates viewport reflows that previously triggered EPUB.js's internal `ResizeObserver` on chrome toggles — the root cause of the chapter-skip bug in scrolled mode.
  - The EPUB viewport is **permanently fullscreen** — its dimensions never change regardless of chrome state. On mobile (`≤768px`), `#app` is `position:fixed; inset:0`, `#reader-view` and `#viewer-wrap` are `position:absolute; inset:0; padding:0`. On desktop, `#viewer-wrap` is `flex:1` and fills all remaining height.
  - `#topbar` and `#progress-bar` are **translucent glass overlays**: `background: color-mix(in srgb, var(--paper) 88%, transparent)` + `backdrop-filter: blur(18px)`.
  - `enterImmersiveReading()` and `exitImmersiveReading()` do not call `resizeReaderViewport()` — there is nothing to resize.
  - **Auto-hide (Kindle/Apple Books UX)**: `showReaderChromeTemporarily(delay=3000)` shows the chrome and starts a 3-second timer; if no drawer is open when the timer fires, `enterImmersiveReading()` is called. Center-tap while chrome is hidden calls `showReaderChromeTemporarily()`; center-tap while chrome is visible calls `enterImmersiveReading()` immediately and cancels any pending timer.
- **Robust Spine Progress Calculation**:
  - Employs a 4-tier location resolution strategy (`getSpineSection`):
    1. Standard EPUB.js `spine.get(cfi)`.
    2. Direct mathematical parsing of EPUB CFI spine components `/6/(\d+)` ($(\frac{N}{2}) - 1$).
    3. Multi-strategy href normalization matching base paths, clean paths, or basename filenames (`chapter04.xhtml`) — basename match is unique-only (R-23).
    4. TOC navigation fallback matching using `tocIdx / (length-1)` formula (R-21).
  - **Finished threshold** is 98% (R-22): a book is auto-marked finished when progress reaches $\ge 98\%$.
- **Text-to-Speech (TTS) & Highlighting**:
  - Advanced TTS controller featuring: play/pause, voice selector dropdown (`#tts-voice-select`), pitch adjustment slider (`#tts-pitch`), sleep timer (10, 20, 30 min), speed rate cycling (0.75× to 2.0×), and stop control.
  - TTS chapter advance uses `rendition.currentLocation()` to identify the active section after navigation (R-10/R-11).
  - Captures selected text DOM ranges inside the EPUB iframe, serializes to CFIs, and renders persistent highlight swatches with notes and tag support.
  - Highlight selection popup provides: Note, Define (dictionary lookup), Copy, Share (Web Share API), and Listen.
- **Interactive UI Modals & Reading Discovery**:
  - **Notebook Modal (`#notebook-modal`)**: Global search across all highlights and notes with book title, author, text excerpt, and tag filters, plus Markdown export.
  - **Book Details Modal (`#book-details-modal`)**: Cover preview, description, ISBN, series, tags, page estimates, reading stats, and admin metadata editing.
  - **Reading Insights Modal (`#stats-modal`)**: 14-day interactive reading bar chart, current & longest reading streaks, total time read, and customizable goals (daily minutes, weekly hours, books per year).
  - **Gesture Settings**: User-configurable toggles for swipe page turns, edge tap zones, and center tap chrome controls.
- **Navigation Serialization (R-09)**:
  - All `rendition.next()` / `rendition.prev()` calls route through `turnPage(direction)` with a module-level mutex (`pageTurnLock`).

---

## 6. Service Worker, Offline Caching & Synchronization Pipeline

- **Service Worker (`public/sw.js`)**:
  - Shell cache versioned with build timestamps (e.g. `endpaper-shell-v10.1.0-20260922`).
  - Core app shell assets (`/`, `/index.html`, `/app.js`, `/app.css`, `/epub.min.js`, `/jszip.min.js`, `/manifest.json`) use **Network-First with Cache Fallback**. Both `epub.min.js` and `jszip.min.js` are self-hosted for complete CDN independence and offline PWA reliability.
  - Handles single-range RFC 7233 HTTP `Range` requests directly from the cache for offline EPUB playback.
  - `controllerchange` event listener in `public/index.html` triggers a deferred update notification banner (`#update-banner`), allowing readers to finish reading uninterrupted before updating.
  - Dedicated runtime cache (`endpaper-runtime-v10.1.0-20260922`) caches active EPUB files and covers with `SET_CURRENT_BOOK` message synchronization.
- **Offline Mutation Queue (`public/app.js`)**:
  - If a network failure occurs during reading (progress updates, bookmarks, highlights, reading sessions), the mutation payload is assigned a UUID `operation_id` and saved to `localStorage` under `endpaper_offline_queue`.
  - When the browser fires the `online` event or reconnects, `flushOfflineQueue()` replays pending mutations to the server in FIFO order. The server stores executed IDs in `client_operations` to ensure strict idempotency.

---

## 7. Backup, Export, and Disaster Recovery Subsystem

- **Export (`ALL /api/export`)**:
  - Admin-authorized endpoint supporting HEAD, GET, and POST requests.
  - Pre-flight asset verification across all referenced book and cover files before streaming begins.
  - Streams on-the-fly ZIP archives via `archiver` directly to `res` with constant $O(1)$ memory usage. Missing assets trigger a clean `500` JSON error rather than a corrupted archive.
- **Import (`POST /api/import`)**:
  - Validates archive structure using `yauzl` with lazy entry reading and strict decompression bounds (max entries: 10,000, max size: 2 GB, max compression ratio: 200:1).
  - Decompresses assets into an isolated staging directory (`data/tmp/import-*`) first. No live library file is touched until all entries validate.
  - Promotes staged files via atomic filesystem renames and executes database import inside a single SQLite transaction with rollback file cleanup on failure.
- **Automated Rolling Backups**:
  - Automatic non-blocking daily backups maintain the last 5 database snapshots in `data/backups/`.
  - Pre-migration backups are automatically created prior to any structural table changes.

---

## 8. REST API Reference & Endpoint Directory

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/healthz` | Public | Unauthenticated health check for reverse proxies / uptime monitors |
| `POST` | `/api/login` | Public (Rate Limited) | Authenticate username + passphrase, sets 90-day httpOnly session cookie |
| `POST` | `/api/logout` | User | Clear session cookie and delete session record |
| `GET` | `/api/session` | User | Return active user account status, role, and username |
| `GET` | `/api/users` | Admin | List all user accounts in system |
| `POST` | `/api/users` | Admin | Create a new user account (Admin or Reader) with min 12-char passphrase |
| `PATCH` | `/api/users/:id` | Admin | Update user role (`is_admin`) or reset passphrase with session revocation |
| `DELETE` | `/api/users/:id` | Admin | Delete a user account and associated personal reading data |
| `GET` | `/api/books` | User | List all books in shared library (`?q=&sort=recent|title|author|opened|series&status=&collection=`) |
| `POST` | `/api/books` | User | Upload new EPUB book (SHA-256 deduplicated, returns `409 Conflict` on duplicate) |
| `GET` | `/api/books/:id` | User | Get detailed book metadata and user reading status |
| `PATCH` | `/api/books/:id` | User / Admin | Update reading progress (CFI, %, status, rating) or edit shared metadata (title, author, series, series_index, description, isbn, tags - Admin only) |
| `DELETE` | `/api/books/:id` | Admin | Staged atomic deletion of book and cover files from library |
| `GET` | `/api/books/:id/file` | User | Stream EPUB binary with RFC 7233 single-range support (`206 Partial Content`) and private caching |
| `GET` | `/api/books/:id/cover` | User | Serve extracted book cover image with caching |
| `GET` | `/api/books/:id/bookmarks` | User | List user bookmarks for a book |
| `POST` | `/api/books/:id/bookmarks` | User | Create a new bookmark |
| `DELETE` | `/api/bookmarks/:id` | User | Delete a bookmark |
| `GET` | `/api/highlights` | User | Global highlights notebook search (`?q=&book_id=&color=&tag=&limit=&offset=`) |
| `GET` | `/api/books/:id/highlights` | User | List user highlights for a specific book |
| `POST` | `/api/books/:id/highlights` | User | Create a new text highlight, note, and optional tags |
| `PATCH` | `/api/highlights/:id` | User | Update highlight note, color, or tags |
| `DELETE` | `/api/highlights/:id` | User | Delete a highlight |
| `GET` | `/api/collections` | User | List all collections |
| `POST` | `/api/collections` | Admin | Create a new collection |
| `PATCH` | `/api/collections/:id` | Admin | Rename a collection |
| `DELETE` | `/api/collections/:id` | Admin | Delete a collection |
| `POST` | `/api/books/:id/collections/:collectionId` | Admin | Add a book to a collection |
| `DELETE` | `/api/books/:id/collections/:collectionId` | Admin | Remove a book from a collection |
| `POST` | `/api/sessions/start` | User | Start reading time tracking session (supports client deduplication) |
| `POST` | `/api/sessions/:id/end` | User | End reading session and record duration |
| `GET` | `/api/stats` | User | Get reading stats (streaks, 14-day history, total time, goals) with `?tz=` support |
| `GET` | `/api/settings` | User | Retrieve personal reader appearance and gesture settings |
| `PUT` | `/api/settings` | User | Save personal reader appearance and gesture settings |
| `ALL` | `/api/export` | Admin | Stream complete library backup ZIP directly to client (HEAD/GET/POST) |
| `POST` | `/api/import` | Admin | Staged, atomic restore and merge of library from backup ZIP |

---

## 9. Infrastructure & Deployment Topology

Endpaper supports two primary production deployment architectures:

### Option 1: Native PM2 Process Deployment (Recommended for Single VPS)
Running directly on Node.js 20+ with PM2 avoids Docker abstraction overhead and provides instant process restarts:

```bash
# Run server under PM2
cd server
npm ci --omit=dev
pm2 start src/index.js --name "endpaper"
pm2 save
pm2 startup
```

### Option 2: Docker Compose & Caddy Reverse Proxy
Containerized deployment with automatic Let's Encrypt / ZeroSSL TLS termination:

```yaml
services:
  app:
    build: ./server
    volumes:
      - ./data:/app/data
      - ./public:/app/public
    environment:
      - NODE_ENV=production
      - PORT=3000
      - TRUST_PROXY=1
      - TZ=${TZ:-UTC}
    restart: unless-stopped
    expose:
      - "3000"

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    restart: unless-stopped
    depends_on:
      - app

volumes:
  caddy_data:
```

---

## 10. Project Directory & File Hierarchy

```text
Endpaper/
├── .dockerignore
├── .gitignore
├── ARCHITECTURE_AND_SOURCE.md
├── Caddyfile
├── DEPLOY.md
├── docker-compose.yml
├── README.md
├── data/
│   ├── backups/
│   ├── books/
│   ├── covers/
│   └── endpaper.db
├── public/
│   ├── app.css
│   ├── app.js
│   ├── epub.min.js          (self-hosted EPUB.js build)
│   ├── icon-source.svg
│   ├── icons/
│   │   ├── apple-touch-icon.png
│   │   ├── icon-192.png
│   │   ├── icon-512.png
│   │   └── icon-maskable-512.png
│   ├── index.html
│   ├── jszip.min.js         (self-hosted JSZip build)
│   ├── manifest.json
│   └── sw.js
└── server/
    ├── Dockerfile
    ├── package-lock.json
    ├── package.json
    ├── src/
    │   ├── db.js
    │   ├── index.js
    │   ├── lib/
    │   │   ├── epubMeta.js
    │   │   ├── epubWorker.js
    │   │   ├── passphrase.js
    │   │   └── validation.js
    │   ├── middleware/
    │   │   └── auth.js
    │   └── routes/
    │       ├── auth.js
    │       ├── bookmarks.js
    │       ├── books.js
    │       ├── collections.js
    │       ├── highlights.js
    │       ├── sessions.js
    │       ├── settings.js
    │       └── users.js
    └── test/
        ├── api-smoke.test.js
        └── validation.test.js
```

---

---
# Part 2: Complete Project Source Code

The following sections contain the complete, verbatim source code for every file in the Endpaper project repository.

---

## File: `server/package.json`

*Relative Path: `server/package.json` | Size: 0.7 KB | Total Lines: 30*

````json
{
  "name": "endpaper-server",
  "version": "1.0.0",
  "description": "Endpaper — self-hosted EPUB reader backend",
  "main": "src/index.js",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "set-passphrase": "node src/lib/passphrase.js --set",
    "test": "node --test"
  },
  "dependencies": {
    "archiver": "^8.0.0",
    "bcrypt": "^6.0.0",
    "better-sqlite3": "^11.3.0",
    "cookie-parser": "^1.4.6",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.0",
    "fast-xml-parser": "^5.10.1",
    "multer": "^2.4.0",
    "pino": "^10.3.1",
    "pino-http": "^11.0.0",
    "sharp": "^0.35.4",
    "yauzl": "^3.4.0"
  }
}

````

---

## File: `server/Dockerfile`

*Relative Path: `server/Dockerfile` | Size: 0.6 KB | Total Lines: 32*

````dockerfile
FROM node:20-alpine AS dependencies

# better-sqlite3 requires build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./

COPY src/ ./src/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]

````

---

## File: `docker-compose.yml`

*Relative Path: `docker-compose.yml` | Size: 0.5 KB | Total Lines: 30*

````yaml
services:
  app:
    build: ./server
    volumes:
      - ./data:/app/data
      - ./public:/app/public
    environment:
      - NODE_ENV=production
      - PORT=3000
      - TRUST_PROXY=1
      - TZ=${TZ:-UTC}
    restart: unless-stopped
    expose:
      - "3000"

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    restart: unless-stopped
    depends_on:
      - app

volumes:
  caddy_data:

````

---

## File: `Caddyfile`

*Relative Path: `Caddyfile` | Size: 0.2 KB | Total Lines: 6*

````text
# Replace books.yourdomain.com with your actual domain before deploying.
# Caddy will automatically obtain and renew a Let's Encrypt certificate.
books.yourdomain.com {
  reverse_proxy app:3000
}

````

---

## File: `.gitignore`

*Relative Path: `.gitignore` | Size: 0.1 KB | Total Lines: 13*

````text
node_modules/
.env
data/
*.zip

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

````

---

## File: `.dockerignore`

*Relative Path: `.dockerignore` | Size: 0.1 KB | Total Lines: 11*

````text
node_modules
data
tmp
output
.git
.gitignore
README.md
DEPLOY.md
audit_report.md
context.md

````

---

## File: `README.md`

*Relative Path: `README.md` | Size: 8.3 KB | Total Lines: 164*

````markdown
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
- **Offline-first PWA** - Explicit per-book downloads, range-aware offline reading, queued reading-state sync, and safe deferred updates.
- **Reading insights** - Goals, streaks, comparisons, monthly trends, favorite books, and personalized time estimates.
- **Admin tools** - Create reader/admin accounts and maintain the shared catalogue.
- **Backup and restore** - Admin-only backup exports and imports for the shared library and supported personal reading data.
- **Responsive UI** - Works across phones, tablets, and desktop browsers.

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

````

---

## File: `DEPLOY.md`

*Relative Path: `DEPLOY.md` | Size: 5.6 KB | Total Lines: 188*

````markdown
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
   npm ci --omit=dev
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
   npm ci --omit=dev
   pm2 restart endpaper
   ```

## Backups

> **Important:** The VPS may hold the only copy of your library. Back up the entire `data/` directory regularly; it contains the SQLite database, EPUBs, and covers.

Endpaper also writes automatic SQLite snapshots to `data/backups/`. Those snapshots protect the database during migrations and routine operation, but they are not full-library backups because EPUB and cover files are stored separately.

### Option 1: Manual backup

```bash
tar czf endpaper-backup-$(date +%Y%m%d).tar.gz data/
scp endpaper-backup-*.tar.gz your-local-machine:/backups/
```

### Option 2: Automated backup (cron)

```bash
crontab -e
```

Add a daily full-data backup:

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

````

---

## File: `public/manifest.json`

*Relative Path: `public/manifest.json` | Size: 0.7 KB | Total Lines: 32*

````json
{
  "name": "Endpaper",
  "short_name": "Endpaper",
  "description": "A self-hosted EPUB library and reader",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#F6F1E7",
  "theme_color": "#F6F1E7",
  "orientation": "any",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "categories": ["books", "education"]
}

````

---

## File: `public/sw.js`

*Relative Path: `public/sw.js` | Size: 5.2 KB | Total Lines: 142*

````javascript
const BUILD_VERSION = 'v12.0.0-20260922';
const CACHE_NAME = `endpaper-shell-${BUILD_VERSION}`;
const RUNTIME_CACHE_NAME = `endpaper-runtime-${BUILD_VERSION}`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/jszip.min.js',
  '/epub.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

async function cachedRangeResponse(request, cached) {
  const range = request.headers.get('range');
  if (!range || !cached) return cached;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const blob = await cached.blob();
  let start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2] || 0));
  let end = match[2] && match[1] ? Number(match[2]) : blob.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= blob.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  end = Math.min(end, blob.size - 1);
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { 'Content-Type': cached.headers.get('Content-Type') || 'application/epub+zip', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Accept-Ranges': 'bytes' } });
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Listen for active book messages to prune runtime cache for non-active books
let activeBookId = null;
self.addEventListener('message', async (e) => {
  if (e.data && e.data.type === 'SET_CURRENT_BOOK') {
    activeBookId = e.data.bookId;
    if (activeBookId) {
      try {
        const cache = await caches.open(RUNTIME_CACHE_NAME);
        const requests = await cache.keys();
        for (const req of requests) {
          const url = req.url;
          if (url.includes('/api/books/') && !url.includes(`/api/books/${activeBookId}/`)) {
            await cache.delete(req);
          }
        }
      } catch (err) {
        console.error('[SW] Error pruning runtime cache:', err);
      }
    }
  } else if (e.data && e.data.type === 'CLEAR_RUNTIME_CACHE') {
    activeBookId = null;
    try {
      await caches.delete(RUNTIME_CACHE_NAME);
    } catch (_) {}
  } else if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Book files and covers: Network first with runtime cache fallback and background cache write
  if (url.pathname.includes('/api/books/') && (url.pathname.includes('/file') || url.pathname.includes('/cover'))) {
    const cacheRequest = new Request(e.request.url, { credentials: 'same-origin' });
    e.respondWith(
      fetch(e.request).then((fetchRes) => {
        if (fetchRes && fetchRes.status === 200) {
          const resClone = fetchRes.clone();
          caches.open(RUNTIME_CACHE_NAME).then((cache) => cache.put(cacheRequest, resClone)).catch(() => {});
        }
        return fetchRes;
      }).catch(() => {
        return caches.open(RUNTIME_CACHE_NAME).then(async cache => cachedRangeResponse(e.request, await cache.match(cacheRequest)));
      })
    );
    return;
  }

  // Personal API payloads are deliberately not placed in a shared service-
  // worker cache. Return an explicit offline response instead of pretending a
  // cache fallback exists (and avoid leaking one account's data to another).
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }))
    );
    return;
  }

  // External lookups (currently the optional dictionary service) are managed
  // by the bounded application cache rather than an unbounded CacheStorage.
  if (url.origin !== location.origin) {
    return;
  }

  // Core App Shell (/, /index.html, /app.js, /app.css, /manifest.json):
  // NETWORK-FIRST with CACHE FALLBACK.
  // When online, users instantly receive the latest updates without manual hard refresh or stale cache locks.
  // When offline, seamlessly serves the cached shell assets.
  e.respondWith(
    fetch(e.request).then((fetchRes) => {
      if (fetchRes && fetchRes.status === 200) {
        const resClone = fetchRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone)).catch(() => {});
      }
      return fetchRes;
    }).catch(() => {
      return caches.match(e.request).then((cachedRes) => {
        if (cachedRes) return cachedRes;
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html').then((r) => r || caches.match('/'));
        }
        return null;
      });
    })
  );
});

````

---

## File: `public/index.html`

*Relative Path: `public/index.html` | Size: 41.9 KB | Total Lines: 647*

````html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="description" content="Endpaper is a shared, self-hosted EPUB library and reader.">
<meta name="theme-color" content="#F6F1E7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Endpaper">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<title>Endpaper — an EPUB reader</title>
<script src="/jszip.min.js"></script><!-- JSZip 3.10.1, self-hosted for EPUB.js and offline startup. -->
<script src="/epub.min.js"></script><!-- epubjs built from upstream commit eee359d (2026-09-22), includes mobile continuous-scroll jitter fix (171f7ec). Self-hosted for PWA offline support and CDN independence. -->
<link rel="stylesheet" href="app.css">

  <script>
    if ('serviceWorker' in navigator) {
      let refreshing = false;
      let hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // clients.claim() also fires during the first install. There is no old
        // application shell to replace in that case, so avoid a surprise reload.
        if (!hadController) {
          hadController = true;
          return;
        }
        if (refreshing) return;
        refreshing = true;
        if (document.body.classList.contains('reader-active')) {
          window.__reloadAfterReader = true;
        } else {
          window.location.reload();
        }
      });
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
          const announce = () => {
            if (!reg.waiting) return;
            window.__pendingServiceWorker = reg.waiting;
            document.getElementById('update-banner')?.removeAttribute('hidden');
          };
          announce();
          reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', () => {
            if (reg.installing?.state === 'installed' && navigator.serviceWorker.controller) announce();
          }));
          reg.update().catch(() => {});
        }).catch(err => console.error('SW registration failed:', err));
      });
    }
  </script>
</head>
<body>

<!-- Login gate -->
<div id="login-gate" class="hidden" role="dialog" aria-label="Login">
  <div id="login-card">
    <div class="mark"></div>
    <h1>Endpaper</h1>
    <p>Enter your passphrase to access your library.</p>
    <form id="login-form" onsubmit="return handleLogin(event)">
      <input type="text" id="username-input" placeholder="Username" autocomplete="username" autofocus style="margin-bottom: 14px; width:100%; padding:11px 14px; border:1px solid var(--line); border-radius: var(--radius); background: var(--paper); color: var(--ink); font-family: var(--font-ui); font-size:14px; outline:none; text-align:center; letter-spacing:1px;">
      <input type="password" id="passphrase-input" placeholder="Passphrase" autocomplete="current-password">
      <button type="submit" id="login-btn">Unlock</button>
      <div id="login-error"></div>
    </form>
  </div>
</div>

<div id="app">

  <div id="topbar">
    <button id="brand" type="button" onclick="showShelf()" title="Back to shared library" aria-label="Back to shared library">
      <div class="mark"></div>
      <span class="brand-name">Endpaper</span>
      <span id="current-user-context" hidden aria-live="polite">
        <span id="current-user-name" class="account-context-name"></span>
        <span id="current-user-role" class="role-badge"></span>
      </span>
    </button>
    <div id="topbar-actions" role="group" aria-label="Reader and library actions">
      <button class="icon-btn" id="toc-toggle" title="Contents" aria-label="Table of contents" aria-controls="toc-drawer" aria-expanded="false" data-drawer-toggle="toc" style="display:none;" onclick="toggleDrawer('toc')">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
      </button>
      <button class="icon-btn" id="search-toggle" title="Search this book" aria-label="Search this book" aria-controls="search-drawer" aria-expanded="false" data-drawer-toggle="search" style="display:none;" onclick="toggleDrawer('search')">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
      <button class="icon-btn" id="settings-toggle" title="Text & theme settings" aria-label="Reading settings" aria-controls="settings-drawer" aria-expanded="false" data-drawer-toggle="settings" style="display:none;" onclick="toggleDrawer('settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="icon-btn" id="bookmarks-toggle" title="Bookmarks & highlights" aria-label="Bookmarks and highlights" aria-controls="bookmarks-drawer" aria-expanded="false" data-drawer-toggle="bookmarks" style="display:none;" onclick="toggleDrawer('bookmarks')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 3h7a.5.5 0 0 1 .5.5v12l-4-2.5L4 15.5v-12a.5.5 0 0 1 .5-.5z"/><path d="M10.5 6.5H18a.5.5 0 0 1 .5.5v12l-4-2.5-1.5.94" stroke-opacity="0.5"/></svg>
      </button>
      <button class="icon-btn" id="bookmark-toggle" title="Bookmark this page" aria-label="Bookmark this page" style="display:none;" onclick="toggleBookmark()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3.5h12a.5.5 0 0 1 .5.5v17l-6.5-4-6.5 4V4a.5.5 0 0 1 .5-.5z"/></svg>
      </button>
      <button class="icon-btn" id="tts-btn" title="Read aloud" aria-label="Read aloud" style="display:none;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </button>
      <button class="icon-btn" id="fullscreen-btn" title="Fullscreen" aria-label="Toggle fullscreen" style="display:none;" onclick="toggleFullscreen()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4"/></svg>
      </button>
      <button class="icon-btn" id="reader-more-btn" title="More reading tools" aria-label="More reading tools" aria-expanded="false" style="display:none;" onclick="toggleReaderMoreMenu(event)">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </button>
      <button class="icon-btn" id="help-toggle" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onclick="openShortcutsModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 1.7-2.3 3.3"/><line x1="12" y1="17" x2="12" y2="17.1"/></svg>
      </button>
      <button class="icon-btn" id="shell-theme-toggle" title="Use dark app appearance" aria-label="Use dark app appearance" aria-pressed="false" onclick="toggleShellTheme()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <button class="icon-btn" id="logout-btn" title="Log out" aria-label="Log out" onclick="logout()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M21 3v18H10"/></svg>
      </button>
      <button class="icon-btn" id="admin-toggle" title="People and library settings" aria-label="People and library settings" data-admin-only hidden onclick="openAdminModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      </button>
      <button id="upload-btn" hidden onclick="document.getElementById('file-input').click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 21h14"/></svg>
        Add book
      </button>
      <input type="file" id="file-input" accept=".epub" multiple hidden>
      <input type="file" id="import-input" accept=".zip" style="display:none;" data-admin-only hidden>
    </div>
    <span id="sync-status" class="sync-status" data-state="saved" hidden aria-live="polite"></span>
    <div id="reader-more-menu" class="reader-more-menu" hidden>
      <button type="button" onclick="toggleDrawer('search'); toggleReaderMoreMenu()">Search book</button>
      <button type="button" onclick="toggleDrawer('bookmarks'); toggleReaderMoreMenu()">Notebook</button>
      <button type="button" onclick="document.getElementById('tts-btn').click(); toggleReaderMoreMenu()">Read aloud</button>
      <button type="button" onclick="toggleFullscreen(); toggleReaderMoreMenu()">Fullscreen</button>
      <button type="button" onclick="openShortcutsModal(); toggleReaderMoreMenu()">Help</button>
    </div>
  </div>

  <!-- Library -->
  <div id="shelf-view">
    <div id="shelf-empty">
      <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3">
        <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16.5A1.5 1.5 0 0 1 18.5 20H6.5A2.5 2.5 0 0 0 4 22.5"/>
        <path d="M4 4.5A2.5 2.5 0 0 0 6.5 7H20"/>
        <path d="M4 4.5v18"/>
      </svg>
      <h1>The shared shelf is empty</h1>
      <p id="empty-shelf-copy">Loading the shared library…</p>
      <div id="dropzone" hidden>Drag an .epub file here, or use "Add book" above</div>
      <p id="empty-import-row" data-admin-only hidden style="margin-top:18px; font-size:13px;">Already have a backup? <button class="file-link-btn" onclick="document.getElementById('import-input').click()">Import backup</button></p>
    </div>
    <div id="continue-card" class="continue-rail" style="display:none;"></div>
    <div id="smart-sections" style="display:none;"></div>
    <div id="shelf-header" style="display:none;">
      <div class="shelf-title-group">
        <h2>Shared library</h2>
        <span id="shelf-count" class="shelf-badge"></span>
      </div>
      <div class="shelf-controls">
        <input id="shelf-search" class="shelf-select" type="search" placeholder="Search books…" aria-label="Search library" oninput="scheduleShelfRender()">
        <select id="shelf-filter" class="shelf-select" onchange="renderShelf()">
          <option value="all">All Books</option>
          <option value="unread">Unread</option>
          <option value="finished">Finished</option>
          <optgroup label="Collections" id="shelf-filter-collections"></optgroup>
        </select>
        <select id="shelf-sort" class="shelf-select" onchange="renderShelf()">
          <option value="recent">Recently Added</option>
          <option value="opened">Recently Read</option>
          <option value="series">Series</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
          <option value="progress">Progress</option>
        </select>
        <select id="shelf-density" class="shelf-select" aria-label="Shelf density" onchange="renderShelf()">
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
        <button type="button" class="file-link-btn" onclick="openStatsModal()" title="Reading statistics">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px; height:13px; margin-right:4px;"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
          Stats
        </button>
        <button type="button" class="file-link-btn" onclick="openNotebookModal()">Notebook</button>
        <button type="button" class="file-link-btn" id="bulk-select-btn" onclick="toggleBulkMode()">Select</button>
        <div class="admin-library-tools dropdown-wrap" data-admin-only hidden role="group" aria-label="Shared library tools">
          <button type="button" class="file-link-btn dropdown-toggle" id="library-tools-btn" aria-haspopup="true" aria-expanded="false" onclick="toggleLibraryToolsMenu(event)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px; height:13px; margin-right:4px;"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 21h14"/></svg>
            Library tools
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px; height:11px; margin-left:3px;"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="dropdown-menu" id="library-tools-menu" role="menu">
            <button type="button" class="dropdown-item" id="collections-manager-btn" role="menuitem" onclick="openCollectionsManager(); closeLibraryToolsMenu();">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              Manage collections
            </button>
            <button type="button" class="dropdown-item" role="menuitem" onclick="exportLibrary(); closeLibraryToolsMenu();">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export backup
            </button>
            <button type="button" class="dropdown-item" role="menuitem" onclick="document.getElementById('import-input').click(); closeLibraryToolsMenu();">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Import backup
            </button>
          </div>
        </div>
      </div>
    </div>
    <div id="bulk-toolbar" hidden aria-live="polite">
      <span id="bulk-count">0 selected</span>
      <button type="button" onclick="bulkDownloadOffline()">Download offline</button>
      <button type="button" data-admin-only hidden onclick="bulkAddToCollection()">Add to collection</button>
      <button type="button" data-admin-only hidden onclick="bulkRemoveFromCollection()">Remove from collection</button>
      <button type="button" data-admin-only hidden onclick="bulkEditSeries()">Edit series</button>
      <button type="button" data-admin-only hidden onclick="bulkDeleteBooks()">Remove</button>
      <button type="button" onclick="toggleBulkMode(false)">Cancel</button>
    </div>
    <div id="shelf"></div>
  </div>

  <!-- Reader -->
  <div id="reader-view">
    <div id="progress-bar">
      <span id="progress-chapter"></span>
      <div id="progress-track">
        <label class="sr-only" for="progress-slider">Reading progress</label>
        <input type="range" id="progress-slider" min="0" max="100" value="0" aria-describedby="progress-chapter progress-pct">
        <div id="bookmark-ticks"></div>
      </div>
      <span id="progress-pct">0%</span>
      <span id="progress-remaining" aria-live="polite"></span>
      <div id="reader-bottom-actions">
        <button type="button" onclick="toggleDrawer('settings')" aria-label="Reading appearance">Aa</button>
        <button type="button" onclick="toggleBookmark()" aria-label="Bookmark this page">♧</button>
        <button type="button" onclick="toggleDrawer('toc')" aria-label="Contents">☰</button>
        <button type="button" onclick="toggleReaderMoreMenu(event)" aria-label="More">•••</button>
      </div>
    </div>
    <div id="viewer-wrap">
      <div id="viewer"></div>
      <button type="button" class="nav-zone left" title="Previous page" aria-label="Previous page" aria-controls="viewer" onclick="turnPage('prev')">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <button type="button" class="nav-zone right" title="Next page" aria-label="Next page" aria-controls="viewer" onclick="turnPage('next')">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </button>
      <div id="loading-overlay" class="hidden">
        <div class="spinner"></div>
        <p id="loading-text">Opening book…</p>
      </div>
      <div id="chrome-hint">Tap the page to show controls again</div>
      <button type="button" id="fullscreen-exit-control" aria-label="Exit fullscreen reading" title="Exit fullscreen reading" onclick="exitImmersiveReading()">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4"/></svg>
        <span>Exit</span>
      </button>
    </div>

    <!-- Table of contents drawer -->
    <div id="drawer-backdrop" aria-hidden="true" onclick="closeDrawers()"></div>
    <aside class="drawer toc" id="toc-drawer" aria-label="Table of contents" aria-hidden="true" inert>
      <div class="drawer-title">
        Contents
        <button type="button" aria-label="Close table of contents" title="Close" onclick="toggleDrawer('toc')">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="toc-list"></div>
    </aside>

    <!-- Search drawer -->
    <aside class="drawer toc" id="search-drawer" aria-label="Search this book" aria-hidden="true" inert>
      <div class="drawer-title">
        Search this book
        <button type="button" aria-label="Close book search" title="Close" onclick="toggleDrawer('search')">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="search-input-wrap">
        <label class="sr-only" for="search-input">Search this book</label>
        <input type="text" id="search-input" placeholder="Search for a word or phrase…">
      </div>
      <div id="search-status" role="status" aria-live="polite"></div>
      <div id="search-results"></div>
    </aside>

    <!-- Bookmarks & highlights drawer -->
    <aside class="drawer" id="bookmarks-drawer" aria-label="Bookmarks and highlights" aria-hidden="true" inert>
      <div class="drawer-title">
        Bookmarks & highlights
        <button type="button" aria-label="Close bookmarks and highlights" title="Close" onclick="toggleDrawer('bookmarks')">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="marks-tabs" role="tablist" aria-label="Saved reading marks">
        <button type="button" class="marks-tab active" id="bookmarks-tab" role="tab" aria-selected="true" aria-controls="bookmarks-pane" data-tab="bookmarks-pane" onclick="setMarksTab('bookmarks-pane')">Bookmarks</button>
        <button type="button" class="marks-tab" id="highlights-tab" role="tab" aria-selected="false" aria-controls="highlights-pane" data-tab="highlights-pane" onclick="setMarksTab('highlights-pane')">Highlights</button>
      </div>
      <div class="marks-pane active" id="bookmarks-pane" role="tabpanel" aria-labelledby="bookmarks-tab">
        <div id="bookmarks-list" aria-live="polite"></div>
      </div>
      <div class="marks-pane" id="highlights-pane" role="tabpanel" aria-labelledby="highlights-tab" hidden>
        <div style="padding: 6px 16px 12px; display: flex; justify-content: flex-end;">
          <button type="button" id="export-highlights-btn" class="file-link-btn" style="font-size: 12px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px; height:13px; margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export Markdown
          </button>
        </div>
        <div id="highlights-list" aria-live="polite"></div>
      </div>
    </aside>

    <!-- Settings drawer -->
    <aside class="drawer" id="settings-drawer" aria-label="Reading settings" aria-hidden="true" inert>
      <div class="drawer-title">
        Reading settings
        <button type="button" aria-label="Close reading settings" title="Close" onclick="toggleDrawer('settings')">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="setting-group" role="radiogroup" aria-label="Reading layout">
        <span class="setting-label">Layout</span>
        <div class="layout-options">
          <button type="button" class="layout-option" role="radio" aria-checked="true" data-layout="paginated" onclick="setLayout('paginated')">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/></svg>
            Paginated
          </button>
          <button type="button" class="layout-option" role="radio" aria-checked="false" data-layout="scrolled" onclick="setLayout('scrolled')">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="3" width="14" height="18" rx="1"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>
            Scrolled
          </button>
        </div>
      </div>

      <div class="setting-group" role="radiogroup" aria-label="Book page theme">
        <span class="setting-label">Page theme</span>
        <div class="theme-swatches">
          <button type="button" class="theme-swatch light" role="radio" aria-checked="true" data-theme="light" onclick="setReadingTheme('light')">Light</button>
          <button type="button" class="theme-swatch sepia" role="radio" aria-checked="false" data-theme="sepia" onclick="setReadingTheme('sepia')">Sepia</button>
          <button type="button" class="theme-swatch dark" role="radio" aria-checked="false" data-theme="dark" onclick="setReadingTheme('dark')">Dark</button>
          <button type="button" class="theme-swatch night" role="radio" aria-checked="false" data-theme="night" onclick="setReadingTheme('night')">Night</button>
        </div>
      </div>

      <div class="setting-group">
        <span class="setting-label">Typeface</span>
        <div class="font-options" id="font-options" role="radiogroup" aria-label="Typeface"></div>
      </div>

      <div class="setting-group">
        <span class="setting-label">Font size</span>
        <div class="stepper">
          <button type="button" aria-label="Decrease font size" onclick="stepFontSize(-1)">A−</button>
          <span class="val" id="font-size-val" aria-live="polite">100%</span>
          <button type="button" aria-label="Increase font size" onclick="stepFontSize(1)">A+</button>
        </div>
      </div>

      <div class="setting-group">
        <label class="setting-label" for="line-height-slider">Line spacing — <span id="line-height-val">1.5</span></label>
        <input type="range" class="mini" id="line-height-slider" min="120" max="220" step="10" value="150" aria-valuetext="1.5 line spacing">
      </div>

      <div class="setting-group">
        <label class="setting-label" for="margin-slider">Page width — <span id="margin-val">Medium</span></label>
        <input type="range" class="mini" id="margin-slider" min="0" max="2" step="1" value="1" aria-valuetext="Medium page width">
      </div>

      <div class="setting-group">
        <label class="setting-label" for="letter-spacing-slider">Letter spacing — <span id="letter-spacing-val">Normal</span></label>
        <input type="range" class="mini" id="letter-spacing-slider" min="0" max="3" step="1" value="0" aria-valuetext="Normal letter spacing">
      </div>
      <div class="setting-group gesture-settings">
        <span class="setting-label">Gestures &amp; tap zones</span>
        <label><input type="checkbox" id="gesture-swipe" checked onchange="updateGestureSettings()"> Swipe to turn pages</label>
        <label><input type="checkbox" id="gesture-edge" checked onchange="updateGestureSettings()"> Edge tap zones</label>
        <label><input type="checkbox" id="gesture-center" checked onchange="updateGestureSettings()"> Center tap toggles controls</label>
      </div>
    </aside>
  </div>

</div>

<div id="highlight-popup" role="dialog" aria-modal="false" aria-label="Choose highlight color or action" aria-hidden="true">
  <button type="button" class="swatch-btn" style="background:#F2D94E" aria-label="Highlight in yellow" title="Highlight in yellow" onclick="applyHighlight('#F2D94E')"></button>
  <button type="button" class="swatch-btn" style="background:#8FD19E" aria-label="Highlight in green" title="Highlight in green" onclick="applyHighlight('#8FD19E')"></button>
  <button type="button" class="swatch-btn" style="background:#8FC1E3" aria-label="Highlight in blue" title="Highlight in blue" onclick="applyHighlight('#8FC1E3')"></button>
  <button type="button" class="swatch-btn" style="background:#E8A0BF" aria-label="Highlight in pink" title="Highlight in pink" onclick="applyHighlight('#E8A0BF')"></button>
  <button type="button" id="highlight-listen-btn" class="popup-action-btn" title="Listen from here" aria-label="Listen from here" onclick="readAloudFromSelection()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="width:13px; height:13px; margin-right:3px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
    <span>Listen</span>
  </button>
  <button type="button" class="popup-action-btn" onclick="addNoteToSelection()">Note</button>
  <button type="button" class="popup-action-btn" onclick="lookupSelectedWord()">Define</button>
  <button type="button" class="popup-action-btn" onclick="copySelectionText()">Copy</button>
  <button type="button" class="popup-action-btn" onclick="shareSelectionText()">Share</button>
  <button type="button" id="highlight-remove-btn" style="display:none;" onclick="removeCurrentHighlight()">Remove</button>
</div>

<!-- Floating Read Aloud Player Bar -->
<div id="tts-player-bar" class="hidden" role="region" aria-label="Read Aloud controls">
  <div class="tts-bar-content">
    <div class="tts-info">
      <span class="tts-indicator">
        <span class="tts-pulse"></span>
        <span class="tts-label">Read Aloud</span>
      </span>
      <span id="tts-active-text" class="tts-snippet"></span>
    </div>
    <div class="tts-controls">
      <button type="button" class="tts-ctrl-btn" id="tts-prev-btn" title="Previous sentence" aria-label="Previous sentence" onclick="ttsPrevSentence()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/><polyline points="19 18 13 12 19 6"/></svg>
      </button>
      <button type="button" class="tts-ctrl-btn main" id="tts-play-btn" title="Pause speech" aria-label="Pause speech" onclick="toggleTtsPause()">
        <svg id="tts-play-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:none;"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg id="tts-pause-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      </button>
      <button type="button" class="tts-ctrl-btn" id="tts-next-btn" title="Next sentence" aria-label="Next sentence" onclick="ttsNextSentence()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/><polyline points="5 18 11 12 5 6"/></svg>
      </button>
      <button type="button" class="tts-ctrl-btn rate-btn" id="tts-rate-btn" title="Change speech rate" aria-label="Change speech rate" onclick="cycleTtsRate()">
        <span id="tts-rate-label">1.0×</span>
      </button>
      <select id="tts-voice-select" class="tts-select" aria-label="Voice"></select>
      <label class="tts-compact-label">Pitch <input id="tts-pitch" type="range" min="0.5" max="2" value="1" step="0.1"></label>
      <select id="tts-sleep" class="tts-select" aria-label="Sleep timer">
        <option value="0">No timer</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option>
      </select>
      <button type="button" class="tts-ctrl-btn stop-btn" id="tts-stop-btn" title="Stop reading aloud" aria-label="Stop reading aloud" onclick="stopTts()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>
</div>

<div id="stats-modal" class="modal" role="dialog" aria-modal="true" aria-label="Reading statistics" aria-hidden="true" onclick="if(event.target===this) closeStatsModal()">
  <div id="stats-card" class="modal-card">
    <div class="modal-title">
      <h3>Reading stats</h3>
      <button type="button" class="modal-close" aria-label="Close reading statistics" title="Close" onclick="closeStatsModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number" id="stat-streak">0</div>
        <div class="stat-label">Day Streak</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" id="stat-finished">0</div>
        <div class="stat-label">Books Finished</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" id="stat-week">0h</div>
        <div class="stat-label">Last 7 Days</div>
      </div>
      <div class="stat-card">
        <div class="stat-number" id="stat-total">0h</div>
        <div class="stat-label">Total Time Read</div>
      </div>
    </div>
    <div id="stats-chart" class="stats-chart" aria-label="Reading minutes over the last 14 days"></div>
    <div id="stats-comparison" class="stats-summary"></div>
    <div id="stats-most-read" class="stats-summary"></div>
    <div class="reading-goals">
      <h4>Optional goals</h4>
      <label>Daily minutes <input id="goal-daily" type="number" min="0" max="1440" step="5"></label>
      <label>Weekly hours <input id="goal-weekly" type="number" min="0" max="168" step="0.5"></label>
      <label>Books per year <input id="goal-books" type="number" min="0" max="1000"></label>
      <button type="button" onclick="saveReadingGoals()">Save goals</button>
    </div>
    <div class="close-row" style="text-align:right;"><button type="button" class="new-collection-btn" onclick="closeStatsModal()">Close</button></div>
  </div>
</div>

<div id="collections-modal" class="modal" role="dialog" aria-modal="true" aria-label="Manage collections" aria-hidden="true" onclick="if(event.target===this) closeCollectionsModal()">
  <div id="collections-card" class="modal-card">
    <div class="modal-title">
      <h3 id="collections-title">Organize Collections</h3>
      <button type="button" class="modal-close" aria-label="Close collections" title="Close" onclick="closeCollectionsModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="collection-list" id="collection-list"></div>
    <div class="new-collection-row">
      <input type="text" id="new-collection-input" class="new-collection-input" placeholder="New collection..." onkeydown="if(event.key==='Enter') createCollection()">
      <button type="button" class="new-collection-btn" onclick="createCollection()">Create</button>
    </div>
    <div class="close-row" style="text-align:right; margin-top:16px;"><button type="button" class="new-collection-btn" onclick="closeCollectionsModal()">Done</button></div>
  </div>
</div>

<div id="admin-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="admin-title" aria-describedby="admin-description" aria-hidden="true" onclick="if(event.target===this) closeAdminModal()">
  <div id="admin-card" class="modal-card">
    <div class="admin-modal-header">
      <div>
        <p class="admin-eyebrow">Shared library</p>
        <h3 id="admin-title">People &amp; permissions</h3>
      </div>
      <button type="button" class="modal-close" aria-label="Close people and permissions" title="Close" onclick="closeAdminModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <p id="admin-description" class="admin-description">Readers can use every book in the shared library. Admins can add or remove books, manage collections and backups, and manage accounts.</p>

    <section aria-labelledby="people-list-title">
      <h4 id="people-list-title" class="admin-section-title">People</h4>
      <div class="collection-list" id="user-list" role="list" aria-live="polite"></div>
    </section>

    <form id="add-user-form" class="admin-create-form" onsubmit="createUser(event); return false;">
      <h4 class="admin-section-title">Add a person</h4>
      <div class="admin-fields">
        <div class="admin-field">
          <label for="new-user-username">Username</label>
          <input type="text" id="new-user-username" class="new-collection-input" autocomplete="username" required>
        </div>
        <div class="admin-field">
          <label for="new-user-passphrase">Passphrase</label>
          <input type="password" id="new-user-passphrase" class="new-collection-input" autocomplete="new-password" minlength="12" required>
        </div>
        <label class="admin-role-option" for="new-user-isadmin">
          <input type="checkbox" id="new-user-isadmin">
          <span>
            <strong>Make this person an admin</strong>
            <small>Admins can manage everyone’s shared library and accounts.</small>
          </span>
        </label>
      </div>
      <div class="admin-create-actions">
        <button type="submit" class="new-collection-btn">Add account</button>
      </div>
    </form>
  </div>
</div>

<!-- Reusable Confirmation Modal -->
<div id="confirm-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" aria-hidden="true">
  <div id="confirm-card" class="modal-card" style="max-width: 440px;">
    <div class="modal-title">
      <h3 id="confirm-title">Confirm Action</h3>
      <button type="button" class="modal-close" aria-label="Close confirmation dialog" title="Close" id="confirm-x-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <p id="confirm-message" style="margin: 14px 0 22px; font-size: 13.5px; line-height: 1.5; color: var(--ink);"></p>
    <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 10px;">
      <button type="button" id="confirm-cancel-btn" class="file-link-btn" style="padding: 8px 14px;">Cancel</button>
      <button type="button" id="confirm-ok-btn" class="new-collection-btn danger-btn" style="padding: 8px 16px;">Confirm</button>
    </div>
  </div>
</div>

<!-- Reset Passphrase Modal -->
<div id="reset-passphrase-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="reset-passphrase-title" aria-hidden="true">
  <div class="modal-card" style="max-width: 400px;">
    <div class="modal-title">
      <h3 id="reset-passphrase-title">Reset Passphrase</h3>
      <button type="button" class="modal-close" aria-label="Close reset passphrase dialog" title="Close" onclick="closeResetPassphraseModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <form id="reset-passphrase-form" onsubmit="handleResetPassphraseSubmit(event); return false;">
      <p id="reset-passphrase-user-label" style="font-size: 13px; color: var(--ink-soft); margin: 8px 0 14px;"></p>
      <div class="admin-field">
        <label for="reset-passphrase-input">New Passphrase</label>
        <input type="password" id="reset-passphrase-input" class="new-collection-input" autocomplete="new-password" minlength="12" required placeholder="Minimum 12 characters">
      </div>
      <div class="admin-create-actions" style="margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px;">
        <button type="button" class="file-link-btn" onclick="closeResetPassphraseModal()" style="padding: 8px 12px;">Cancel</button>
        <button type="submit" class="new-collection-btn" style="padding: 8px 14px;">Save Passphrase</button>
      </div>
    </form>
  </div>
</div>

<div id="book-details-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="book-details-title" aria-hidden="true">
  <div class="modal-card book-details-card">
    <div class="modal-title"><h3 id="book-details-title">Book details</h3><button type="button" class="modal-close" onclick="closeBookDetails()" aria-label="Close">×</button></div>
    <div id="book-details-content"></div>
    <div id="book-details-actions" class="modal-actions"></div>
  </div>
</div>

<div id="notebook-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="notebook-title" aria-hidden="true">
  <div class="modal-card notebook-card">
    <div class="modal-title"><h3 id="notebook-title">Notebook</h3><button type="button" class="modal-close" onclick="closeNotebookModal()" aria-label="Close">×</button></div>
    <input id="notebook-search" type="search" placeholder="Search highlights, notes, books, or tags…" oninput="renderNotebook()">
    <div id="notebook-tags"></div>
    <div id="notebook-list"></div>
  </div>
</div>

<div id="install-tip" class="install-tip" hidden>
  <strong>Install Endpaper</strong>
  <span>In Safari, tap Share, then “Add to Home Screen” for fullscreen reading and reliable offline access.</span>
  <button type="button" onclick="dismissInstallTip()">Got it</button>
</div>

<div id="update-banner" class="update-banner" hidden>
  <span>A new Endpaper version is ready.</span>
  <button type="button" onclick="applyAppUpdate()">Update now</button>
  <button type="button" onclick="this.parentElement.hidden=true">Later</button>
</div>

<div id="toast" role="status" aria-live="polite"></div>

<div id="shortcuts-modal" class="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" aria-hidden="true" onclick="if(event.target===this) closeShortcutsModal()">
  <div id="shortcuts-card" class="modal-card">
    <div class="modal-title">
      <h3>Keyboard shortcuts</h3>
      <button type="button" class="modal-close" aria-label="Close keyboard shortcuts" title="Close" onclick="closeShortcutsModal()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <table class="shortcuts-table">
      <tbody>
        <tr><td>Previous / next page</td><td><kbd>←</kbd> <kbd>→</kbd></td></tr>
        <tr><td>Scroll a screen (Scrolled mode)</td><td><kbd>Space</kbd></td></tr>
        <tr><td>Bookmark this page</td><td><kbd>B</kbd></td></tr>
        <tr><td>Table of contents</td><td><kbd>T</kbd></td></tr>
        <tr><td>Search</td><td><kbd>/</kbd></td></tr>
        <tr><td>Bookmarks &amp; highlights</td><td><kbd>M</kbd></td></tr>
        <tr><td>Settings</td><td><kbd>S</kbd></td></tr>
        <tr><td>Fullscreen</td><td><kbd>F</kbd></td></tr>
        <tr><td>Back to library</td><td><kbd>H</kbd></td></tr>
        <tr><td>Close panel / exit fullscreen</td><td><kbd>Esc</kbd></td></tr>
      </tbody>
    </table>
    <div class="close-row" style="margin-top:18px; text-align:right;"><button type="button" class="new-collection-btn" onclick="closeShortcutsModal()">Got it</button></div>
  </div>
</div>

<div id="upload-progress">
  <div id="upload-progress-card">
    <div class="spinner"></div>
    <div id="upload-progress-text" role="status" aria-live="polite">Uploading…</div>
  </div>
</div>

<script src="app.js"></script>

  <div id="dict-tooltip" class="hidden"></div>
</body>
</html>

````

---

## File: `public/app.css`

*Relative Path: `public/app.css` | Size: 59.5 KB | Total Lines: 1743*

````css
:root{
  --paper: #F6F1E7;
  --paper-card: #FFFCF6;
  --ink: #201C16;
  --ink-soft: #5C5346;
  --line: #E1D6C1;
  --gold: #A9803F;
  --gold-bright: #C9973F;
  --cloth: #3F5D4C;
  --cloth-deep: #2C4237;
  --shadow: rgba(32,28,22,0.12);
  --radius: 3px;
  --font-display: Georgia, "Times New Roman", serif;
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --accent: var(--gold);
  --bg: var(--paper);
  --fg: var(--ink);
  --border: var(--line);
  --border-soft: color-mix(in srgb, var(--line) 65%, transparent);
}
html.dark-shell{
  --paper: #12151A;
  --paper-card: #1A1E25;
  --ink: #E9E4D8;
  --ink-soft: #9C9587;
  --line: #2A2F38;
  --gold: #C9973F;
  --gold-bright: #E0B15C;
  --cloth: #527A66;
  --cloth-deep: #3D5E4E;
  --shadow: rgba(0,0,0,0.4);
}
*{box-sizing:border-box;}
html,body{height:100%;margin:0; width:100%; max-width:100vw; overflow-x:hidden;}
body{
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
  transition: background .3s ease, color .3s ease;
  overflow: hidden;
}

/* Eliminate tap highlight on all interactive elements */
a, button, [role="button"], label, select, summary {
  -webkit-tap-highlight-color: transparent;
}

/* Eliminate 300ms delay and prevent double-tap zoom on controls */
button, [role="button"], a, label, input[type="range"] {
  touch-action: manipulation;
}

/* Prevent text selection on UI chrome (not on reading content) */
header,
nav,
#topbar,
#topbar-actions,
#progress-bar,
.spine,
.spine-book,
.layout-option,
.theme-swatch,
.font-option,
.marks-tab,
.drawer-title,
.setting-label,
.modal-card,
#stats-card,
#collections-card,
#shortcuts-card,
#admin-card {
  user-select: none;
  -webkit-user-select: none;
}

#app{
  --reader-page-bg: var(--paper);
  height:100vh; height:100dvh; min-height:0; width:100%; max-width:100vw;
  display:flex; flex-direction:column; overflow:hidden;
  background: var(--paper);
}
body.reader-active,
body.reader-active #app,
body.reader-active #reader-view,
body.reader-active #viewer-wrap,
body.reader-active #viewer{ background:var(--reader-page-bg); }
#app:fullscreen, #app:-webkit-full-screen{
  width:100vw; max-width:none; height:100vh; height:100dvh; min-height:100%;
  background:var(--reader-page-bg);
}

/* ---------- Top bar ---------- */
#topbar{
  display:flex; align-items:center; justify-content:space-between;
  gap:12px; min-width:0; 
  padding: calc(14px + env(safe-area-inset-top)) 22px 14px;
  border-bottom: 1px solid var(--line);
  flex-shrink:0;
  z-index: 30;
  background: var(--paper);
  transition: max-height .25s ease, padding .25s ease, opacity .2s ease, border-color .2s ease;
}
#app.chrome-hidden #topbar{
  flex:0 0 0; height:0; min-height:0; max-height:0;
  padding:0; opacity:0; border-width:0; pointer-events:none;
}

/* R-13: In reader mode the chrome bars become translucent glass overlays so
   the EPUB viewport is exactly the same size whether controls are visible or
   not. No height-collapse, no viewer resize, no chapter-skip. */
body.reader-active #topbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 40;
  transition: transform .22s ease, opacity .18s ease;
  /* reset shelf-mode flex sizing */
  flex: initial; height: initial; min-height: initial; max-height: initial;
  /* translucent glass — adapts automatically to light/sepia/dark/night themes */
  border-bottom: none;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  backdrop-filter: blur(18px) saturate(1.4);
}
body.reader-active #app.chrome-hidden #topbar {
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}
#brand{
  background: none;
  border: none;
  padding: 0;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 20px; font-weight: 600;
  letter-spacing: -0.2px;
  display:flex; align-items:center; gap:9px;
  cursor:pointer; user-select:none;
}
#brand .mark{
  width:18px; height:24px;
  background: linear-gradient(160deg, var(--gold-bright), var(--gold));
  border-radius: 2px 4px 4px 2px;
  box-shadow: inset -2px 0 0 rgba(0,0,0,0.15);
}
#current-user-context{
  display:inline-flex; align-items:center; gap:6px;
  margin-left:6px; font-family:var(--font-ui);
}
.account-context-name{
  font-size:12.5px; font-weight:500; color:var(--ink-soft);
}
.role-badge{
  font-size:9.5px; font-weight:600; letter-spacing:0.4px;
  text-transform:uppercase; padding:2px 6px; border-radius:var(--radius);
}
.role-badge.admin{
  background:rgba(201,151,63,0.18); color:var(--gold);
  border:1px solid rgba(201,151,63,0.35);
}
.role-badge.reader{
  background:var(--paper-card); color:var(--ink-soft);
  border:1px solid var(--line);
}
#topbar-meta{
  display:none; flex-direction:column; align-items:center; text-align:center;
  overflow:hidden; max-width: 480px; margin: 0 auto;
}
#topbar-meta.visible{ display:flex; }
#topbar-title{
  font-family: var(--font-display);
  font-size: 14.5px; font-weight: 600;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;
}
#topbar-author{
  font-size: 11.5px; color: var(--ink-soft);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;
}
#topbar-actions{
  display:flex; align-items:center; gap:6px; flex-shrink:1; min-width:0;
}
.icon-btn{
  background:none; border: 1px solid transparent;
  color: var(--ink); width: 34px; height: 34px;
  border-radius: var(--radius); cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition: background .15s ease, border-color .15s ease;
}
.icon-btn:hover{
  background: var(--paper-card);
  border-color: var(--line);
}
.icon-btn svg{ width:18px; height:18px; }
#bookmark-toggle.active{ color: var(--gold); }
#bookmark-toggle.active svg{ fill: var(--gold); }
#tts-btn[aria-pressed="true"]{ color: var(--gold); border-color: var(--gold); }

:where(button, input, select, [tabindex]):focus-visible{
  outline:3px solid var(--gold-bright); outline-offset:2px;
}
.sr-only{
  position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0;
}

#upload-btn{
  display:flex; align-items:center; gap:8px;
  background: var(--cloth); color: #FBF8F0;
  border:none; padding: 9px 16px; border-radius: var(--radius);
  font-family: var(--font-ui); font-weight:500; font-size:14px;
  cursor:pointer; transition: background .15s ease;
}
#upload-btn:hover{ background: var(--cloth-deep); }
#upload-btn svg{ width:15px; height:15px; }
#file-input{ display:none; }

/* ---------- Library / shelf ---------- */
#shelf-view{
  flex:1; overflow-y:auto; padding: 48px 8vw calc(80px + env(safe-area-inset-bottom));
}
#shelf-empty{
  max-width: 480px; margin: 8vh auto 0; text-align:center;
}
#shelf-empty .glyph{
  width:64px; height:64px; margin: 0 auto 22px;
  color: var(--gold);
}
#shelf-empty h1{
  font-family: var(--font-display); font-size: 26px; font-weight:600;
  margin: 0 0 10px;
}
#shelf-empty p{
  color: var(--ink-soft); font-size:15px; line-height:1.6; margin:0 0 26px;
}
#dropzone{
  border: 1.5px dashed var(--line); border-radius: var(--radius);
  padding: 22px; font-size: 13.5px; color: var(--ink-soft);
  transition: border-color .15s ease, background .15s ease;
}
#dropzone.drag-over{ border-color: var(--gold); background: var(--paper-card); }

#shelf-header{
  display:flex; align-items:center; justify-content:space-between;
  max-width: 1100px; margin: 0 auto 28px; gap:16px; flex-wrap:wrap;
}
.shelf-title-group{
  display:flex; align-items:center; gap:12px;
}
.shelf-title-group h2{ font-family: var(--font-display); font-weight:600; font-size:22px; margin:0; letter-spacing:-0.2px; }
.shelf-badge{
  font-size:11.5px; font-weight:500; color:var(--ink-soft);
  background:var(--paper-card); border:1px solid var(--line);
  padding:2px 8px; border-radius:999px; white-space:nowrap;
}

#shelf{
  max-width: 1100px; margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 32px 22px;
}

#shelf.compact {
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 18px 14px;
}

#shelf.compact .book-meta-under .author,
#shelf.compact .shelf-rating-widget {
  display: none;
}
.book-card{
  display:flex; flex-direction:column; cursor:pointer;
  position:relative; transition: transform .18s ease;
}
.book-card:hover{ transform: translateY(-4px); }
.book-card:hover .spine{ box-shadow: 0 14px 28px var(--shadow), 0 2px 6px var(--shadow); }

/* Spine representation */
.spine{
  aspect-ratio: 2 / 3;
  border-radius: 2px 5px 5px 2px;
  position:relative;
  box-shadow: 0 6px 16px var(--shadow);
  transition: box-shadow .18s ease;
  overflow:hidden;
  display:flex; flex-direction:column; justify-content:space-between;
  padding: 14px 12px;
  color: #F8F5EE;
}
.spine::before{
  /* Book crease */
  content:""; position:absolute; top:0; bottom:0; left:0; width:12px;
  background: linear-gradient(to right, rgba(0,0,0,0.3), rgba(0,0,0,0.05) 60%, rgba(255,255,255,0.1) 80%, rgba(0,0,0,0.15));
}
.spine::after{
  /* Gold foil accent bar */
  content:""; position:absolute; top:0; bottom:0; right:0; width:3px;
  background: rgba(0,0,0,0.2);
}
.spine-title{
  font-family: var(--font-display);
  font-size: 13px; font-weight:600; line-height:1.25;
  word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow:hidden;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}
.spine-author{
  font-size: 10.5px; opacity:0.85;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  letter-spacing: 0.3px; text-transform: uppercase;
}
.spine-badge{
  position:absolute; top:8px; right:8px;
  background: var(--gold); color:#201C16;
  font-size:9.5px; font-weight:600; padding:2px 5px; border-radius:2px;
}
.book-meta-under{
  margin-top: 9px;
}
.book-meta-under .title{
  font-size: 12.5px; font-weight:500; line-height:1.3;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.book-meta-under .author{
  font-size: 11px; color: var(--ink-soft); margin-top:2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.book-progress-bar{
  height: 2px; background: var(--line); border-radius: 1px;
  margin-top: 6px; overflow:hidden;
}
.book-progress-fill{
  height:100%; background: var(--gold); width: 0%;
}

/* Palette variations for spines */
.spine-c0{ background: linear-gradient(145deg, #2E3E34, #1E2B24); }
.spine-c1{ background: linear-gradient(145deg, #6B3428, #4D231A); }
.spine-c2{ background: linear-gradient(145deg, #2C3E50, #1B2836); }
.spine-c3{ background: linear-gradient(145deg, #5C4A38, #3E3225); }
.spine-c4{ background: linear-gradient(145deg, #4A3B56, #31263A); }
.spine-c5{ background: linear-gradient(145deg, #35505B, #22353D); }

/* ---------- Reader View ---------- */
#reader-view{
  flex:1; display:none; flex-direction:column;
  position:relative; overflow:hidden;
  background: var(--paper);
}
#reader-view.active{ display:flex; }
#viewer-wrap{
  flex:1; position:relative; overflow:hidden; min-height:0;
  background: var(--reader-page-bg, var(--paper));
  padding-bottom: env(safe-area-inset-bottom);
}
/* viewer-wrap fills all available space; its dimensions never change when
   chrome is toggled — the overlays sit on top without stealing any height */
#viewer{
  width:100%; height:100%;
}
#viewer .epub-container,
#epub-scroll-container{
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}

.nav-zone{
  position:absolute; top:0; bottom:0; width: var(--nav-zone-width, 10%);
  display:flex; align-items:center;
  color: var(--ink-soft); opacity:0;
  cursor:pointer; z-index: 10;
  transition: opacity .15s ease, background .15s ease;
  user-select:none;
  background: transparent;
  border: none;
  padding: 0;
}
.nav-zone:hover{
  opacity: 0.7;
  background: rgba(0,0,0,0.03);
}
.nav-zone.left{ left:0; justify-content: flex-start; padding-left: 16px; }
.nav-zone.right{ right:0; justify-content: flex-end; padding-right: 16px; }
.nav-zone svg{ width:24px; height:24px; }
#reader-view.scrolled .nav-zone{
  display: none !important;
}

#progress-bar{
  flex-shrink:0; padding: 10px 22px;
  display:flex; align-items:center; gap:14px;
  border-bottom: 1px solid var(--line);
  background: var(--paper);
  z-index: 30;
  max-height: 54px; overflow:hidden;
  transition: max-height .25s ease, padding .25s ease, opacity .2s ease, border-color .2s ease;
}
#app.chrome-hidden #progress-bar{
  flex:0 0 0; height:0; min-height:0; max-height:0;
  padding-top:0; padding-bottom:0; opacity:0; border-width:0; pointer-events:none;
}

/* R-13: progress-bar as translucent glass overlay during reader mode */
body.reader-active #progress-bar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  padding: 10px 22px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  border-bottom: none;
  z-index: 40;
  transition: transform .22s ease, opacity .18s ease;
  flex: initial; height: initial; min-height: initial; max-height: initial; overflow: visible;
  /* translucent glass */
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  backdrop-filter: blur(18px) saturate(1.4);
}
body.reader-active #app.chrome-hidden #progress-bar {
  transform: translateY(110%);
  opacity: 0;
  pointer-events: none;
}
/* A small tap hint that briefly appears the first time chrome is hidden */
#chrome-hint{
  position:absolute; bottom: calc(18px + env(safe-area-inset-bottom)); left:50%;
  transform: translateX(-50%); background: rgba(20,17,12,0.75); color:#F6F1E7;
  font-size:12px; padding:8px 14px; border-radius:20px; pointer-events:none;
  opacity:0; transition: opacity .3s ease; z-index:15; white-space:nowrap;
}
#chrome-hint.show{ opacity:1; }

#fullscreen-exit-control{
  position:fixed;
  top: calc(8px + env(safe-area-inset-top));
  right: 10px;
  z-index: 45;
  display: none;
  align-items:center;
  justify-content:center;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(225, 214, 193, 0.7);
  border-radius: 999px;
  background: rgba(246, 241, 231, 0.88);
  color: var(--ink);
  box-shadow: 0 4px 12px rgba(32, 28, 22, 0.18);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  opacity: 0.86;
  transition: opacity .18s ease, transform .18s ease, background-color .18s ease;
}
#app.chrome-hidden #fullscreen-exit-control{
  display: flex;
}
#fullscreen-exit-control:hover,
#fullscreen-exit-control:focus-visible{
  opacity: 1;
  transform: scale(1.04);
  background: rgba(255, 252, 246, 0.96);
}
#fullscreen-exit-control svg{
  width: 16px;
  height: 16px;
}
html.dark-shell #fullscreen-exit-control{
  border-color: rgba(42, 47, 56, 0.85);
  background: rgba(26, 30, 37, 0.88);
  color: var(--ink);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}
html.dark-shell #fullscreen-exit-control:hover,
html.dark-shell #fullscreen-exit-control:focus-visible{
  background: rgba(35, 41, 51, 0.96);
}

#progress-slider{
  flex:1; -webkit-appearance:none; appearance:none;
  height:3px;
  background: linear-gradient(to right, var(--gold) var(--progress, 0%), var(--line) var(--progress, 0%));
  border-radius:2px; outline:none;
  cursor:pointer;
}
#progress-slider:focus-visible{
  outline: 2px solid var(--gold-bright);
  outline-offset: 4px;
}
#progress-slider::-webkit-slider-thumb{
  -webkit-appearance:none; width:11px; height:11px; border-radius:50%;
  background: var(--gold); cursor:pointer; margin-top:-4px;
  box-shadow: 0 0 0 3px var(--paper);
}
#progress-slider:focus-visible::-webkit-slider-thumb{
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 0 6px var(--paper);
}
#progress-slider:focus-visible::-moz-range-thumb{
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 0 6px var(--paper);
}
#progress-pct{ font-size:12px; color: var(--ink-soft); min-width:38px; text-align:right; }
#progress-chapter{ font-size:12.5px; color: var(--ink-soft); font-style:italic; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

#progress-track{ position:relative; flex:1; display:flex; align-items:center; }
#bookmark-ticks{ position:absolute; left:0; right:0; top:50%; height:0; pointer-events:none; }
.bookmark-tick{
  position:absolute; top:-4px; width:7px; height:7px; border-radius:50%;
  background: var(--gold); border: 1.5px solid var(--paper);
  transform: translate(-50%,0); cursor:pointer; pointer-events:auto;
}

.bookmark-empty{ font-size:13px; color: var(--ink-soft); line-height:1.6; padding: 6px 4px; }
.bookmark-item{
  padding: 12px 4px; border-bottom: 1px solid var(--line);
  cursor:pointer; display:flex; flex-direction:column; gap:3px;
}
.bookmark-item:hover .bookmark-chapter{ color: var(--gold); }
.bookmark-chapter{ font-size:13.5px; color: var(--ink); line-height:1.4; transition: color .15s ease; }
.bookmark-meta{ display:flex; justify-content:space-between; align-items:center; }
.bookmark-pct{ font-size:11.5px; color: var(--ink-soft); }
.bookmark-remove{ border:none; background:none; color: var(--ink-soft); font-size:11px; cursor:pointer; text-decoration:underline; }
.bookmark-remove:hover{ color: var(--gold); }

/* ---------- Drawers (TOC + Settings) ---------- */
.drawer{
  position:absolute; top:0; right:0; bottom:0; width: 320px; max-width: 100vw;
  background: var(--paper-card); border-left: 1px solid var(--line);
  transform: translateX(100%); transition: transform .22s ease, visibility .22s ease;
  z-index: 30; overflow-y:auto; padding: 22px 20px calc(40px + env(safe-area-inset-bottom));
  box-shadow: -8px 0 24px var(--shadow);
  pointer-events: none;
  visibility: hidden;
}
.drawer.toc{ left:0; right:auto; transform: translateX(-100%); border-left:none; border-right:1px solid var(--line); box-shadow: 8px 0 24px var(--shadow); }
.drawer.open{ transform: translateX(0); pointer-events: auto; visibility: visible; }
.drawer-title{
  font-family: var(--font-display); font-size:16px; font-weight:600;
  margin: 0 0 18px; display:flex; align-items:center; justify-content:space-between;
}
.drawer-title button{ background:none; border:none; color: var(--ink-soft); cursor:pointer; padding:4px; }
.drawer-title button svg{ width:16px; height:16px; }

.toc-item{
  display:block; padding: 9px 4px; font-size: 13.5px; color: var(--ink);
  border-bottom: 1px solid var(--line); cursor:pointer; text-decoration:none;
  line-height:1.4;
}
.toc-item:hover{ color: var(--gold); }

.setting-group{ margin-bottom: 24px; }
.setting-label{
  font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.7px;
  color: var(--ink-soft); font-weight:600; margin-bottom:10px; display:block;
}
.theme-swatches{ display:flex; gap:8px; }
.theme-swatch{
  flex:1; height:52px; border-radius: var(--radius); cursor:pointer;
  border: 2px solid transparent; position:relative;
  display:flex; align-items:flex-end; justify-content:center; padding-bottom:5px;
  font-family:var(--font-ui); font-size:10px; font-weight:600; letter-spacing:0.3px;
}
.theme-swatch.active{ border-color: var(--gold); }
.theme-swatch.light{ background:#F6F1E7; color:#3a332a; }
.theme-swatch.sepia{ background:#EBDCC0; color:#4a3a22; }
.theme-swatch.dark{ background:#2B2E33; color:#d8d3c8; }
.theme-swatch.night{ background:#000; color:#8a8a8a; }

/* Continue reading */
#continue-card{
  max-width: 1100px; margin: 0 auto 40px; display:flex; gap:20px;
  background: var(--paper-card); border:1px solid var(--line); border-radius: var(--radius);
  padding: 18px; cursor:pointer; align-items:center; transition: border-color .15s ease;
}
#continue-card:hover{ border-color: var(--gold); }
#continue-card .spine-book{ width:64px; height:94px; flex-shrink:0; padding:8px 6px; }
#continue-card .spine-book .spine-title{ font-size:10.5px; }
#continue-info{ flex:1; min-width:0; }
#continue-info .kicker{
  font-size: 10.5px; text-transform:uppercase; letter-spacing:0.8px;
  color: var(--gold); font-weight:600;
}
#continue-info h3{
  font-family: var(--font-display); font-size:17px; font-weight:600;
  margin: 3px 0 2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
#continue-info .author{ font-size: 12px; color: var(--ink-soft); }
#continue-info .progress-text{ font-size: 11.5px; color: var(--ink-soft); margin-top:8px; }

.font-options{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.font-option{
  padding: 10px; border:1px solid var(--line); border-radius: var(--radius);
  background: var(--paper); color: var(--ink); text-align:center;
  font-size: 13px; cursor:pointer; transition: border-color .15s ease;
}
.font-option.active{ border-color: var(--gold); font-weight:600; }

.size-stepper{
  display:flex; align-items:center; justify-content:space-between;
  border:1px solid var(--line); border-radius: var(--radius); padding:4px;
}
.size-stepper button{
  background:none; border:none; color: var(--ink);
  font-family: var(--font-ui); font-size: 16px; font-weight:600;
  width:36px; height:32px; cursor:pointer; border-radius: 2px;
}
.size-stepper button:hover{ background: var(--paper); }
.size-stepper span{ font-size: 13px; color: var(--ink-soft); }

.layout-options{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.layout-option{
  display:flex; align-items:center; justify-content:center; gap:8px;
  padding: 10px; border:1px solid var(--line); border-radius: var(--radius);
  background: var(--paper); color: var(--ink);
  font-size: 12.5px; cursor:pointer; transition: border-color .15s ease;
}
.layout-option svg{ width:15px; height:15px; }
.layout-option.active{ border-color: var(--gold); font-weight:600; }

.slider-control{ display:flex; flex-direction:column; gap:8px; }
.slider-control-header{ display:flex; justify-content:space-between; align-items:baseline; }
.slider-control-header .setting-label{ margin-bottom:0; }
.slider-value{ font-size:12px; color:var(--ink-soft); font-weight:500; }
.setting-slider{
  -webkit-appearance:none; appearance:none; width:100%; height:3px;
  background: var(--line); border-radius:2px; outline:none; cursor:pointer;
}
.setting-slider:focus-visible{
  outline: 2px solid var(--gold-bright);
  outline-offset: 4px;
}
.setting-slider::-webkit-slider-thumb{
  -webkit-appearance:none; width:13px; height:13px; border-radius:50%;
  background: var(--gold); cursor:pointer;
}
.setting-slider:focus-visible::-webkit-slider-thumb{
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 0 6px var(--paper);
}
.setting-slider:focus-visible::-moz-range-thumb{
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 0 6px var(--paper);
}

/* Shelf view controls */
.shelf-controls{
  display:flex; gap:8px; align-items:center; flex-wrap:wrap;
}
.shelf-select{
  border:1px solid var(--line); background:var(--paper-card); color:var(--ink);
  padding:6px 12px; border-radius:var(--radius); font-family:var(--font-ui);
  font-size:12.5px; outline:none; height:34px;
  transition:border-color .15s ease;
}
.shelf-select:focus{ border-color:var(--gold); }
input.shelf-select{
  width:160px; transition:width .2s ease, border-color .15s ease;
}
input.shelf-select:focus{ width:220px; }

.file-link-btn{
  background:var(--paper-card); color:var(--ink);
  border:1px solid var(--line); border-radius:var(--radius);
  padding:5px 12px; font-family:var(--font-ui);
  font-size:12.5px; font-weight:500; cursor:pointer; height:34px;
  display:inline-flex; align-items:center; justify-content:center;
  transition:background .15s ease, border-color .15s ease, color .15s ease;
  white-space:nowrap;
}
.file-link-btn:hover{
  background:var(--paper); border-color:var(--gold); color:var(--gold);
}

/* Dropdown Menu System for Library Tools */
.dropdown-wrap{
  position:relative; display:inline-block;
}
.dropdown-menu{
  position:absolute; top:calc(100% + 6px); right:0;
  min-width:185px; background:var(--paper-card);
  border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:0 10px 28px var(--shadow); padding:6px;
  display:none; flex-direction:column; gap:2px; z-index:40;
}
.dropdown-menu.show{
  display:flex; animation:dropdownFadeIn .15s ease;
}
@keyframes dropdownFadeIn{
  from{ opacity:0; transform:translateY(-4px); }
  to{ opacity:1; transform:translateY(0); }
}
.dropdown-item{
  display:flex; align-items:center; gap:9px; width:100%;
  padding:8px 10px; background:none; border:none;
  border-radius:var(--radius); color:var(--ink);
  font-family:var(--font-ui); font-size:12.5px; font-weight:500;
  text-align:left; cursor:pointer;
  transition:background .12s ease, color .12s ease;
}
.dropdown-item svg{
  width:15px; height:15px; color:var(--gold); flex-shrink:0;
}
.dropdown-item:hover{
  background:var(--paper); color:var(--gold-bright);
}

/* Spine hover action overlay */
.spine-actions{
  position:absolute; bottom:8px; left:8px; right:8px;
  display:flex; gap:5px; opacity:0;
  transform:translateY(4px); transition:opacity .18s ease, transform .18s ease;
  z-index:5;
}
.book-card:hover .spine-actions,
.book-card:focus-within .spine-actions{
  opacity:1; transform:translateY(0);
}
.spine-action-btn{
  flex:1; background:rgba(20,17,12,0.85);
  backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);
  color:#F8F5EE; border:1px solid rgba(255,255,255,0.25);
  border-radius:var(--radius); font-family:var(--font-ui);
  font-size:10px; font-weight:500; padding:5px 4px;
  cursor:pointer; text-align:center;
  transition:background .15s ease, border-color .15s ease, color .15s ease;
}
.spine-action-btn:hover{
  background:rgba(0,0,0,0.95); border-color:var(--gold); color:var(--gold-bright);
}

.layout-toggle-btn{
  background:none; border:1px solid var(--line); border-radius: var(--radius);
  width:32px; height:32px; display:flex; align-items:center; justify-content:center;
  cursor:pointer; color:var(--ink-soft);
}
.layout-toggle-btn.active{ color:var(--gold); border-color:var(--gold); }
.layout-toggle-btn svg{ width:16px; height:16px; }

/* Shelf list layout */
#shelf.list-layout{
  display:flex; flex-direction:column; gap:8px;
}
#shelf.list-layout .book-card{
  flex-direction:row; align-items:center; gap:16px;
  padding: 10px 14px; background: var(--paper-card);
  border: 1px solid var(--line); border-radius: var(--radius);
}
#shelf.list-layout .book-card:hover{ transform:none; border-color: var(--gold); }
#shelf.list-layout .spine{ display:none; }
#shelf.list-layout .book-meta-under{ margin:0; flex:1; }
#shelf.list-layout .book-progress-bar{ width: 120px; }

/* Highlights / Annotations */
::selection{ background: rgba(201,151,63,0.3); }
#highlight-popup{
  position:absolute; z-index: 50; display:none;
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: 0 8px 24px var(--shadow);
  padding: 4px; gap:4px; align-items:center;
}
#highlight-popup.show{ display:flex; }
.hl-color-btn{
  width:22px; height:22px; border-radius:50%; border:2px solid transparent;
  cursor:pointer; transition: transform .1s ease;
}
.hl-color-btn:hover{ transform: scale(1.15); }
.hl-color-btn.active{ border-color: var(--ink); }
.hl-color-btn.yellow{ background: #FFE066; }
.hl-color-btn.green{ background: #A9E34B; }
.hl-color-btn.blue{ background: #74C0FC; }
.hl-color-btn.pink{ background: #FFA8A8; }
.hl-color-btn.delete{ background: none; border:none; color: var(--ink-soft); display:flex; align-items:center; justify-content:center; }
.hl-color-btn.delete svg{ width:14px; height:14px; }

.popup-action-btn{
  display:inline-flex; align-items:center; justify-content:center;
  background: rgba(201,151,63,0.12); color: var(--gold);
  border: 1px solid rgba(201,151,63,0.35); border-radius: var(--radius);
  font-family: var(--font-ui); font-size: 11.5px; font-weight: 600;
  padding: 3px 8px; cursor: pointer; transition: background .15s ease, border-color .15s ease;
  margin-left: 2px;
}
.popup-action-btn:hover{
  background: var(--gold); color: #fff; border-color: var(--gold);
}

/* Floating Read Aloud Player Bar */
#tts-player-bar{
  position: fixed;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 60;
  max-width: min(560px, calc(100vw - 28px));
  width: auto;
  transition: transform .22s cubic-bezier(0.2, 0.9, 0.3, 1), opacity .2s ease;
  box-shadow: 0 10px 30px var(--shadow), 0 2px 8px rgba(0,0,0,0.15);
  border-radius: 999px;
  background: var(--paper-card);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
#tts-player-bar.hidden{
  transform: translate(-50%, 60px);
  opacity: 0;
  pointer-events: none;
}
.tts-bar-content{
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px 6px 16px;
}
.tts-info{
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 240px;
}
.tts-indicator{
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tts-pulse{
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 0 0 rgba(201, 151, 63, 0.7);
  animation: tts-pulse 1.8s infinite;
}
@keyframes tts-pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(201, 151, 63, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(201, 151, 63, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(201, 151, 63, 0); }
}
.tts-label{
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--gold);
  text-transform: uppercase;
}
.tts-snippet{
  font-size: 12px;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.tts-controls{
  display: flex;
  align-items: center;
  gap: 4px;
}
.tts-ctrl-btn{
  background: none;
  border: 1px solid transparent;
  color: var(--ink);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s ease, transform .1s ease;
}
.tts-ctrl-btn:hover{
  background: var(--paper);
  border-color: var(--line);
  transform: scale(1.05);
}
.tts-ctrl-btn svg{
  width: 15px;
  height: 15px;
}
.tts-ctrl-btn.main{
  background: var(--gold);
  color: #fff;
  border-color: var(--gold);
}
.tts-ctrl-btn.main:hover{
  background: var(--gold-bright);
}
.tts-ctrl-btn.rate-btn{
  width: auto;
  border-radius: var(--radius);
  padding: 0 6px;
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  border: 1px solid var(--line);
}
.tts-ctrl-btn.stop-btn{
  color: var(--ink-soft);
}
.tts-ctrl-btn.stop-btn:hover{
  color: #C14B4B;
}

@media (max-width: 600px) {
  #tts-player-bar {
    max-width: calc(100vw - 20px);
  }
  .tts-info {
    max-width: 120px;
  }
  .tts-bar-content {
    gap: 8px;
    padding: 6px 10px 6px 12px;
  }
}

/* Marks drawer (Bookmarks + Highlights) */
.marks-tabs{ display:flex; border-bottom: 1px solid var(--line); margin-bottom:14px; }
.marks-tab{
  flex:1; padding: 8px; text-align:center; font-size:12.5px;
  background:none; border:none; color: var(--ink-soft); cursor:pointer;
  border-bottom: 2px solid transparent; font-family:var(--font-ui);
}
.marks-tab.active{ color: var(--gold); border-bottom-color: var(--gold); font-weight:600; }
.marks-panel{ display:none; }
.marks-panel.active{ display:block; }

.highlight-item{
  padding: 12px 4px; border-bottom: 1px solid var(--line);
  cursor:pointer; display:flex; flex-direction:column; gap:4px;
}
.highlight-item:hover .highlight-text{ color: var(--gold); }
.highlight-text{ font-size:13px; line-height:1.45; font-style:italic; }
.highlight-meta{ display:flex; justify-content:space-between; align-items:center; }
.highlight-color-tag{ width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:4px; }
.highlight-chapter{ font-size:11.5px; color:var(--ink-soft); }
.highlight-delete{ border:none; background:none; color:var(--ink-soft); font-size:11px; cursor:pointer; text-decoration:underline; }
.highlight-delete:hover{ color: #C14B4B; }

/* Search in book */
#search-input{
  width:100%; padding: 8px 12px; border:1px solid var(--line);
  border-radius: var(--radius); background: var(--paper); color: var(--ink);
  font-family: var(--font-ui); font-size: 13px; outline:none; margin-bottom:12px;
}
#search-input:focus{ border-color: var(--gold); }
.search-result-item{
  padding: 10px 4px; border-bottom: 1px solid var(--line);
  cursor:pointer; font-size:12.5px; line-height:1.4;
}
.search-result-item:hover{ color: var(--gold); }
.search-result-excerpt{ color: var(--ink-soft); }
.search-result-excerpt mark{ background: rgba(201,151,63,0.35); color: inherit; padding: 1px 2px; }

/* Drawer backdrop */
#drawer-backdrop{
  position:fixed; inset:0; background: rgba(20,17,12,0.35);
  z-index: 25; display:none; opacity:0; transition: opacity .2s ease;
}
#drawer-backdrop.show{ display:block; opacity:1; }

/* Modals */
.modal{
  position:fixed; inset:0; z-index:100;
  background: rgba(20,17,12,0.45);
  display:none; align-items:center; justify-content:center; padding: 20px;
  height: 100vh; height: 100dvh;
}
.modal.show{ display:flex; }
.modal-card{
  width:100%; max-width:440px; background: var(--paper-card);
  border:1px solid var(--line); border-radius: var(--radius);
  box-shadow: 0 16px 40px var(--shadow); padding: 28px;
  max-height: 85vh; overflow-y:auto;
}
.modal-title{
  font-family: var(--font-display); font-size: 19px; font-weight:600;
  margin: 0 0 18px; display:flex; justify-content:space-between; align-items:center;
}
.modal-close{ background:none; border:none; color: var(--ink-soft); cursor:pointer; padding:4px; }
.modal-close svg{ width:16px; height:16px; }

/* Stats UI */
.stats-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:18px; }
.stat-card{
  padding: 14px; border:1px solid var(--line); border-radius: var(--radius);
  text-align:center; background: var(--paper);
}
.stat-number{
  font-family: var(--font-display); font-size: 26px; font-weight:600;
  color: var(--gold); line-height:1.1; margin-bottom:4px;
}
.stat-label{ font-size: 11.5px; color: var(--ink-soft); }

/* Keyboard shortcuts table */
.shortcuts-table{ width:100%; border-collapse:collapse; font-size:13px; }
.shortcuts-table td{ padding: 8px 4px; border-bottom: 1px solid var(--line); }
.shortcuts-table kbd{
  display:inline-block; padding: 2px 6px; font-size:11px;
  border:1px solid var(--line); border-radius: 3px; background: var(--paper);
  font-family: monospace;
}

/* Edit book modal */
.form-group{ margin-bottom: 14px; }
.form-group label{ display:block; font-size:12px; font-weight:600; color:var(--ink-soft); margin-bottom:4px; }
.form-group input, .form-group select{
  width:100%; padding: 8px 12px; border:1px solid var(--line);
  border-radius: var(--radius); background: var(--paper); color:var(--ink);
  font-family: var(--font-ui); font-size:13px; outline:none;
}
.form-group input:focus, .form-group select:focus{ border-color: var(--gold); }
.modal-actions{ display:flex; justify-content:space-between; align-items:center; margin-top:20px; }
.danger-btn{ background:none; border:none; color: #C14B4B; font-size:13px; cursor:pointer; padding:6px 0; }
.danger-btn:hover{ text-decoration:underline; }
.save-btn{
  background: var(--cloth); color:#FBF8F0; border:none; padding: 8px 18px;
  border-radius: var(--radius); font-family: var(--font-ui); font-weight:500;
  font-size:13px; cursor:pointer;
}
.save-btn:hover{ background: var(--cloth-deep); }

/* Collections manager */
.collections-list{ display:flex; flex-direction:column; gap:6px; margin-bottom:16px; }
.collection-row{
  display:flex; align-items:center; justify-content:space-between;
  padding: 8px 10px; border:1px solid var(--line); border-radius: var(--radius);
}
.collection-name{ font-size:13px; font-weight:500; }
.collection-count{ font-size:11.5px; color:var(--ink-soft); }
.collection-actions{ display:flex; gap:6px; }
.collection-actions button{ background:none; border:none; color:var(--ink-soft); cursor:pointer; font-size:12px; padding:2px 4px; }
.collection-actions button:hover{ color:var(--ink); }
.new-collection-form{ display:flex; gap:8px; }
.new-collection-input{
  flex:1; padding: 7px 10px; border:1px solid var(--line); border-radius: var(--radius);
  background: var(--paper); color:var(--ink); font-family:var(--font-ui); font-size:13px; outline:none;
}
.new-collection-input:focus{ border-color: var(--gold); }
.new-collection-btn{
  background: var(--gold); color: #201C16; border:none; padding: 7px 14px;
  border-radius: var(--radius); font-family: var(--font-ui); font-size:13px; font-weight:500; cursor:pointer;
}

/* Upload progress overlay */
#upload-progress{
  position:fixed; bottom: 20px; right: 20px; z-index: 110;
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: 0 8px 24px var(--shadow);
  padding: 14px 18px; display:none; align-items:center; gap:12px;
  font-size: 13px; max-width: 320px;
}
#upload-progress.show{ display:flex; }
.upload-spinner{
  width:18px; height:18px; border: 2px solid var(--line);
  border-top-color: var(--gold); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* Loading overlay */
#loading-overlay{
  position:absolute; inset:0; background: var(--paper);
  display:none; flex-direction:column; align-items:center; justify-content:center;
  gap:12px; z-index: 20;
}
#loading-overlay.show{ display:flex; }
.loading-spinner{
  width:28px; height:28px; border: 2.5px solid var(--line);
  border-top-color: var(--gold); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin{ to{ transform: rotate(360deg); } }
#loading-overlay p{ font-size:13px; color: var(--ink-soft); font-family: var(--font-ui); }

::-webkit-scrollbar{ width:8px; }
::-webkit-scrollbar-thumb{ background: var(--line); border-radius:4px; }

#login-gate{
  position:fixed; inset:0; z-index:100;
  height: 100vh; height: 100dvh;
  min-height: 100vh; min-height: 100dvh;
  background: var(--paper);
  display:flex; align-items:center; justify-content:center; padding: 20px;
  transition: opacity .3s ease;
}
#login-gate.hidden{ display:none; }
#login-card{
  width: 100%; max-width: 340px; box-sizing: border-box;
  text-align:center; padding:40px 30px;
  background: var(--paper-card); border:1px solid var(--line);
  border-radius: var(--radius); box-shadow: 0 12px 32px var(--shadow);
}
#login-card .mark{
  width:28px; height:36px; margin:0 auto 16px;
  background: linear-gradient(160deg, var(--gold-bright), var(--gold));
  border-radius: 2px 5px 5px 2px;
  box-shadow: inset -3px 0 0 rgba(0,0,0,0.15);
}
#login-card h1{
  font-family: var(--font-display); font-size:22px; font-weight:600;
  margin:0 0 6px;
}
#login-card p{
  color: var(--ink-soft); font-size:13.5px; line-height:1.5; margin:0 0 24px;
}
#passphrase-input{
  width:100%; padding:11px 14px; border:1px solid var(--line); border-radius: var(--radius);
  background: var(--paper); color: var(--ink); font-family: var(--font-ui); font-size:14px;
  outline:none; text-align:center; letter-spacing:1px;
}
#passphrase-input:focus{ border-color: var(--gold); }
#login-btn{
  width:100%; margin-top:14px; padding:11px; border:none; border-radius: var(--radius);
  background: var(--cloth); color:#FBF8F0; font-family: var(--font-ui);
  font-weight:500; font-size:14px; cursor:pointer; transition: background .15s ease;
}
#login-btn:hover{ background: var(--cloth-deep); }
#login-btn:disabled{ opacity:.5; cursor:not-allowed; }
#login-error{
  color: #C14B4B; font-size:12.5px; margin-top:10px; min-height:18px;
}
#toast{
  position:fixed; z-index:120; left:50%; bottom:calc(24px + env(safe-area-inset-bottom));
  transform:translate(-50%, 18px); opacity:0; pointer-events:none;
  background:var(--ink); color:var(--paper-card); border-radius:var(--radius);
  padding:10px 14px; max-width:min(420px, calc(100vw - 32px));
  font-size:13px; line-height:1.4; box-shadow:0 8px 24px var(--shadow);
  transition:opacity .18s ease, transform .18s ease;
}
#toast.show{ opacity:1; transform:translate(-50%, 0); }
@media (max-width: 768px){
  #shelf-header { flex-direction: column; align-items: flex-start; gap: 16px; }
  .shelf-controls { flex-wrap: wrap; justify-content: flex-start; width: 100%; }
  .admin-library-tools{ flex-wrap:wrap; }
  #stats-card { width: 100%; max-width: none; margin: 0 16px; }
  #collections-card { width: 100%; max-width: none; margin: 0 16px; }
  #shortcuts-card { width: 100%; max-width: none; margin: 0 16px; }

  #topbar {
    padding: 8px 12px;
    gap: 8px;
  }
  
  /* In reader mode on mobile, keep brand compact to maximize action ribbon room */
  body.reader-active #brand #current-user-context {
    display: none !important;
  }
  body.reader-active #brand .brand-name {
    display: none;
  }
  body.reader-active #brand {
    padding: 4px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }
  
  #topbar-actions {
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    flex-wrap: nowrap;
    max-width: 100%;
    padding: 2px 0;
    gap: 4px;
  }
  #topbar-actions::-webkit-scrollbar {
    display: none;
  }
  
  .icon-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    flex-shrink: 0;
  }
}

/* R-13 mobile: lock the reader canvas to exactly the screen dimensions so
   no ancestor layout can resize the EPUB viewport. The chrome overlays float
   on top; viewer dimensions are constant whether controls are visible or not. */
@media (max-width: 768px) {
  body.reader-active #app {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100dvh;
    overflow: hidden;
  }
  body.reader-active #reader-view {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  body.reader-active #viewer-wrap {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;         /* overlays float on top — no padding needed */
  }
  body.reader-active #viewer {
    width: 100%;
    height: 100%;
  }
}

html.dark-shell{ color-scheme:dark; }
html.dark-shell #reader-view,
html.dark-shell #viewer-wrap{ background: var(--reader-page-bg, var(--paper)); }
html.dark-shell #progress-bar{ /* in reader mode the translucent backdrop handles theming; only override in shelf mode */ }
html.dark-shell .drawer,
html.dark-shell .nav-zone{ box-shadow:0 5px 18px rgba(0,0,0,.34); }

@media (max-width: 640px){
  #shelf{ grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap:20px 14px; }
  .spine-title{ font-size:11.5px; -webkit-line-clamp:3; }
  .spine-author{ font-size:9.5px; }
  #shelf-view{ padding: 20px 16px calc(48px + env(safe-area-inset-bottom)); }
  #topbar{ padding: calc(8px + env(safe-area-inset-top)) 10px 8px; }
  .modal-card{ padding: 20px; }
  #topbar-actions { gap: 3px; }
  .icon-btn { width: 34px; height: 34px; min-width: 34px; min-height: 34px; }
  .icon-btn svg { width: 17px; height: 17px; }
}

/* Dark mode overrides for controls */
html.dark-shell #shelf-search{ background-color: var(--paper-card); color: var(--ink); }
html.dark-shell .shelf-select{ background-color: var(--paper-card); color: var(--ink); border-color: var(--line); }
html.dark-shell .file-link-btn{ background-color: var(--paper-card); color: var(--ink); border-color: var(--line); }
html.dark-shell .file-link-btn:hover{ background-color: var(--paper); border-color: var(--gold); color: var(--gold); }
html.dark-shell .new-collection-input{ background: var(--paper); color: var(--ink); }
html.dark-shell #passphrase-input{ background: var(--paper-card); color: var(--ink); }
html.dark-shell #search-input{ background: var(--paper-card); color: var(--ink); }

/* Page turn animation */
#viewer iframe{ transition: opacity 0.15s ease; }

/* Admin card & roles */
#admin-card {
  max-width: 520px;
  max-height: 88vh;
  padding: 26px 28px 30px;
  box-sizing: border-box;
}

.admin-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 8px;
}
.admin-eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--gold);
  margin: 0 0 4px;
}
#admin-title {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 600;
  margin: 0;
  color: var(--ink);
}
.admin-modal-header .modal-close {
  margin-top: -2px;
  margin-right: -4px;
  padding: 6px;
  border-radius: var(--radius);
  color: var(--ink-soft);
  cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.admin-modal-header .modal-close:hover {
  background: var(--paper);
  color: var(--ink);
}
.admin-description {
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.5;
  margin: 0 0 20px;
}

.admin-section-title {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--gold);
  margin: 18px 0 10px;
}

#user-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 22px;
}
.admin-user-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 11px 14px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.admin-user-item:hover {
  border-color: rgba(201,151,63,0.4);
}
.admin-user-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.admin-user-name {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--ink);
}
.current-user-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  background: rgba(201, 151, 63, 0.18);
  color: var(--gold);
  border: 1px solid rgba(201, 151, 63, 0.35);
  padding: 1px 6px;
  border-radius: 4px;
}
.admin-user-item .collection-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.admin-btn-sm {
  background: var(--paper-card);
  border: 1px solid var(--line);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 9px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all .15s ease;
}
.admin-btn-sm:hover {
  border-color: var(--gold);
  color: var(--gold);
  background: var(--paper);
}
.admin-self-note {
  font-size: 11.5px;
  color: var(--ink-soft);
  font-style: italic;
  padding: 2px 4px;
}
.admin-user-item .collection-delete {
  background: none;
  border: 1px solid transparent;
  color: #C14B4B;
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all .15s ease;
}
.admin-user-item .collection-delete:hover {
  background: rgba(193, 75, 75, 0.1);
  border-color: rgba(193, 75, 75, 0.3);
  color: #e04a4a;
}

.admin-create-form {
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.admin-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}
.admin-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.admin-field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
}
.admin-field input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 13.5px;
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.admin-field input:focus {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(201, 151, 63, 0.2);
}

.admin-role-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-top: 2px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease;
}
.admin-role-option:hover {
  border-color: var(--gold);
}
.admin-role-option input {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  accent-color: var(--gold);
  cursor: pointer;
}
.admin-role-option strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.admin-role-option small {
  display: block;
  color: var(--ink-soft);
  font-size: 11.5px;
  line-height: 1.4;
  margin-top: 2px;
}
.admin-create-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
  padding-bottom: 4px;
}
.admin-create-actions .new-collection-btn {
  padding: 9px 18px;
  font-size: 13.5px;
  font-weight: 600;
}

html.dark-shell .admin-user-item,
html.dark-shell .admin-role-option,
html.dark-shell .admin-field input {
  background: var(--paper-card);
  color: var(--ink);
  border-color: var(--line);
}
html.dark-shell .admin-user-item:hover,
html.dark-shell .admin-role-option:hover {
  border-color: var(--gold);
}
html.dark-shell .admin-btn-sm {
  background: var(--paper);
  color: var(--ink);
  border-color: var(--line);
}
html.dark-shell .admin-btn-sm:hover {
  background: var(--paper-card);
  border-color: var(--gold);
  color: var(--gold);
}

/* Touch readers: show compact arrows in paginated mode (R-05/R-06).
   Scrolled mode keeps them hidden via the #reader-view.scrolled .nav-zone rule. */
@media (hover: none) and (pointer: coarse){
  .drawer{ width: min(320px, 86vw); }
  #progress-chapter{ display:none; }
  /* Paginated: visible mid-height arrow buttons */
  #reader-view:not(.scrolled) .nav-zone{
    display: flex;
    opacity: 0.72;
    top: 50%;
    bottom: auto;
    width: 48px;
    height: 64px;
    transform: translateY(-50%);
    border-radius: 8px;
    background: rgba(0,0,0,0.04);
  }
}

@media (pointer: coarse) {
  .icon-btn {
    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
  }
}

/* Danger buttons & confirmation modal */
.danger-btn {
  background: #a8382b !important;
  color: #fff !important;
  border-color: #a8382b !important;
}
.danger-btn:hover {
  background: #8e2f24 !important;
}

/* Star rating widget */
.rating-stars {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  user-select: none;
  touch-action: manipulation;
}
.star-btn {
  background: none;
  border: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  min-height: 28px;
  padding: 4px;
  font-size: 16px;
  line-height: 1;
  color: var(--line);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s ease, transform 0.1s ease;
}
.star-btn:hover {
  transform: scale(1.15);
}
.star-btn.filled {
  color: var(--gold);
}
.shelf-rating-widget {
  margin-top: 4px;
  margin-left: -4px;
  display: flex;
  align-items: center;
}
.shelf-rating-widget .star-btn {
  font-size: 15px;
  min-width: 26px;
  min-height: 26px;
  padding: 3px 4px;
}
.shelf-rating {
  font-size: 11.5px;
  color: var(--gold);
  margin-top: 3px;
  letter-spacing: 1px;
}

/* Series badge & text */
.series-tag {
  font-size: 11.5px;
  color: var(--gold);
  font-weight: 500;
  margin-bottom: 2px;
  line-height: 1.3;
}
.continue-series {
  font-size: 12.5px;
  color: var(--gold);
  font-weight: 500;
  margin-bottom: 4px;
}

/* Admin user management list controls */
.user-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 8px;
  gap: 10px;
}
.user-item-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.user-item-name {
  font-weight: 500;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.admin-btn-sm {
  background: none;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 4px 8px;
  font-size: 11.5px;
  color: var(--ink);
  cursor: pointer;
  font-family: var(--font-ui);
  transition: all .15s ease;
}
.admin-btn-sm:hover {
  border-color: var(--gold);
  color: var(--gold);
}

/* Reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* Empty state upload button */
.btn.primary {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  transition: opacity 0.2s;
}
.btn.primary:hover {
  opacity: 0.9;
}

/* Filter select */
#filter-select {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
  margin-left: 8px;
  height: 36px;
}

/* Dictionary Tooltip */
#dict-tooltip {
  position: absolute;
  background: var(--paper-card);
  color: var(--ink);
  border: 1px solid var(--line);
  box-shadow: 0 4px 12px var(--shadow);
  padding: 12px;
  border-radius: var(--radius);
  z-index: 10000;
  max-width: 300px;
  font-size: 14px;
}
#dict-tooltip.hidden {
  display: none;
}
#dict-tooltip h4 {
  margin: 0 0 4px 0;
  color: var(--gold);
}
#dict-tooltip p {
  margin: 0;
  line-height: 1.4;
}

/* Product home, sync, bulk actions, and overlay tools */
.sync-status{position:absolute;right:calc(env(safe-area-inset-right) + 12px);bottom:-22px;z-index:4;padding:3px 9px;border-radius:999px;background:var(--paper-card);border:1px solid var(--line);font-size:11px;color:var(--ink-soft);box-shadow:0 2px 8px var(--shadow)}
.sync-status[data-state="offline"],.sync-status[data-state="pending"]{color:#9b5b22}.sync-status[data-state="saved"]{color:var(--cloth)}
.reader-more-menu{position:fixed;right:12px;top:calc(58px + env(safe-area-inset-top));z-index:120;background:var(--paper-card);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 35px var(--shadow);padding:6px;min-width:190px}
.reader-more-menu button{display:block;width:100%;min-height:44px;padding:9px 12px;text-align:left;border:0;background:transparent;color:var(--ink);border-radius:8px;font:500 13px var(--font-ui)}
.reader-more-menu button:hover{background:color-mix(in srgb,var(--gold) 10%,transparent)}
.continue-rail{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 2px 12px;margin-bottom:22px;background:none!important;border:0!important;box-shadow:none!important}
.continue-item{scroll-snap-align:start;display:grid;grid-template-columns:82px minmax(175px,260px);gap:13px;min-width:290px;padding:12px;background:var(--paper-card);border:1px solid var(--line);border-radius:12px;cursor:pointer}
.continue-item .spine{height:120px;width:82px;border-radius:5px}.continue-item h3{font:600 16px var(--font-display);margin:4px 0}.continue-item .kicker{text-transform:uppercase;letter-spacing:.08em;font-size:9px;color:var(--gold)}
#smart-sections{display:grid;gap:22px;margin-bottom:28px}.smart-section h3{margin:0 0 10px;font:600 17px var(--font-display)}.smart-rail{display:flex;gap:11px;overflow-x:auto;padding-bottom:6px}.smart-book{min-width:145px;max-width:145px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--paper-card);cursor:pointer}.smart-book strong,.smart-book span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.smart-book strong{font-size:12px}.smart-book span{font-size:10px;color:var(--ink-soft);margin-top:3px}
#bulk-toolbar{position:sticky;top:72px;z-index:15;align-items:center;gap:8px;padding:9px 12px;margin:8px 0 18px;background:var(--paper-card);border:1px solid var(--line);border-radius:10px;box-shadow:0 5px 18px var(--shadow)}#bulk-toolbar:not([hidden]){display:flex}#bulk-toolbar span{margin-right:auto;font-size:12px;font-weight:600}#bulk-toolbar button,.reading-goals button{min-height:36px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);padding:6px 10px}
.book-card.bulk-mode{position:relative}.book-select{position:absolute;z-index:4;top:8px;left:8px;width:24px;height:24px;accent-color:var(--gold)}.book-card.selected .spine{outline:3px solid var(--gold);outline-offset:2px}
.book-menu-btn{position:absolute;right:7px;top:7px;z-index:3;width:36px;height:36px;border:0;border-radius:50%;background:rgba(20,18,14,.72);color:#fff;font-size:20px}.book-card .spine{position:relative}.cover-img{display:block;width:100%;height:100%;object-fit:cover;border-radius:inherit}
.book-details-card{max-width:580px}.book-details-layout{display:grid;grid-template-columns:120px 1fr;gap:18px}.book-details-cover{width:120px;aspect-ratio:2/3;object-fit:cover;border-radius:7px;background:var(--cloth)}.book-detail-meta{color:var(--ink-soft);font-size:12px;line-height:1.6}.book-description{white-space:pre-line;line-height:1.55}.modal-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.modal-actions button{min-height:42px;padding:8px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink)}
.notebook-card{max-width:760px;max-height:86dvh;overflow:auto}#notebook-search{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink)}#notebook-tags{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.tag-chip{border:1px solid var(--line);border-radius:999px;padding:4px 9px;background:var(--paper);color:var(--ink);font-size:11px}.notebook-item{padding:14px 2px;border-bottom:1px solid var(--line)}.notebook-item blockquote{margin:6px 0;font:italic 15px/1.5 var(--font-display)}.notebook-item small{color:var(--ink-soft)}
.stats-chart{height:150px;display:flex;align-items:end;gap:5px;margin:20px 0 10px;padding-top:12px;border-bottom:1px solid var(--line)}.stats-bar{flex:1;min-width:6px;background:var(--gold);border-radius:4px 4px 0 0;opacity:.78;position:relative}.stats-bar span{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:8px;color:var(--ink-soft)}.stats-summary{font-size:12px;line-height:1.6;margin-top:12px}.reading-goals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}.reading-goals h4{grid-column:1/-1;margin:0}.reading-goals label{display:grid;gap:4px;font-size:11px;color:var(--ink-soft)}.reading-goals input{width:100%;padding:7px;background:var(--paper);border:1px solid var(--line);color:var(--ink)}
.tts-select{max-width:120px;height:34px;border:1px solid var(--line);border-radius:6px;background:var(--paper-card);color:var(--ink)}.tts-compact-label{font-size:10px;display:flex;align-items:center;gap:4px}.tts-compact-label input{width:64px}
.gesture-settings label{display:block;margin:8px 0;font-size:12px}.gesture-settings input{accent-color:var(--gold)}
.install-tip,.update-banner{position:fixed;z-index:500;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(92vw,620px);padding:12px 14px;background:var(--paper-card);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 38px var(--shadow);font-size:12px}.install-tip[hidden],.update-banner[hidden]{display:none}.install-tip span{flex:1}.install-tip button,.update-banner button{min-height:36px;border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:7px;padding:6px 10px}
#progress-remaining{min-width:88px;font-size:10px;color:var(--ink-soft);text-align:right}
#reader-bottom-actions{display:none}

@media (hover:none) and (pointer:coarse){
  .icon-btn,#topbar button,.drawer button,.popup-action-btn{min-width:44px;min-height:44px}
  body.reader-active #search-toggle,body.reader-active #bookmarks-toggle,body.reader-active #tts-btn,body.reader-active #fullscreen-btn,body.reader-active #help-toggle,body.reader-active #shell-theme-toggle,body.reader-active #logout-btn,body.reader-active #admin-toggle{display:none!important}
  body.reader-active #reader-more-btn{display:flex!important}
  body.reader-active #progress-bar{padding-bottom:calc(8px + env(safe-area-inset-bottom));min-height:56px}
  body.reader-active #progress-chapter,body.reader-active #progress-track,body.reader-active #progress-pct,body.reader-active #progress-remaining{display:none}
  #reader-bottom-actions{display:flex;width:100%;align-items:center;justify-content:space-around}#reader-bottom-actions button{min-width:52px;min-height:44px;border:0;background:transparent;color:var(--ink);font:600 16px var(--font-ui)}
  .reading-goals{grid-template-columns:1fr}.book-details-layout{grid-template-columns:90px 1fr}.book-details-cover{width:90px}
  .tts-info{display:none}.tts-bar-content{justify-content:center}.tts-select,.tts-compact-label{display:none}
}

````

---

## File: `public/app.js`

*Relative Path: `public/app.js` | Size: 202.5 KB | Total Lines: 4948*

````javascript
/* ================================================================
   ENDPAPER — Self-hosted EPUB Reader
   Frontend with API-backed persistence
   ================================================================ */



/* ---------------- API Layer ---------------- */
let allCollections = [];

// Keep a small, account-scoped LRU of recently opened EPUBs. This avoids a
// second download when a reader briefly returns to the shelf, without letting
// a very large book pin an unbounded amount of mobile memory.
// R-16: Store Blobs instead of ArrayBuffers so EPUB.js receives a blob:// URL
// — the backing data lives outside the GC heap and no .slice() copy is needed.
const EPUB_BUFFER_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const EPUB_BUFFER_CACHE_MAX_ITEM_BYTES = 12 * 1024 * 1024;
const epubBlobCache = new Map();     // key → Blob
const epubBlobRequests = new Map();  // key → Promise<Blob>
const epubLocationCache = new Map();
let epubBlobCacheBytes = 0;

// Blob URL for the currently open book; revoked in discardReaderState (R-16)
let currentBlobUrl = null;

function readerAssetCacheKey(bookId, version = accountVersion) {
  return `${version}:${bookId}`;
}

function getCachedEpubBlob(key) {
  const blob = epubBlobCache.get(key);
  if (!blob) return null;
  // LRU: re-insert to move to tail
  epubBlobCache.delete(key);
  epubBlobCache.set(key, blob);
  return blob;
}

function rememberEpubBlob(key, blob) {
  if (!(blob instanceof Blob) || blob.size > EPUB_BUFFER_CACHE_MAX_ITEM_BYTES) return;
  const previous = epubBlobCache.get(key);
  if (previous) epubBlobCacheBytes -= previous.size;
  epubBlobCache.delete(key);
  epubBlobCache.set(key, blob);
  epubBlobCacheBytes += blob.size;
  while (epubBlobCacheBytes > EPUB_BUFFER_CACHE_MAX_BYTES && epubBlobCache.size > 1) {
    const oldestKey = epubBlobCache.keys().next().value;
    const oldest = epubBlobCache.get(oldestKey);
    epubBlobCache.delete(oldestKey);
    epubBlobCacheBytes -= oldest.size;
  }
}

function clearReaderAssetCaches() {
  epubBlobCache.clear();
  epubBlobRequests.clear();
  epubLocationCache.clear();
  bookSearchIndex.clear();
  bookTextIndex.clear();
  epubBlobCacheBytes = 0;
}

const api = {
  async fetch(url, opts = {}) {
    const { expectedAccountVersion, ...requestOptions } = opts;
    // Authenticated calls that do not need a custom guard still inherit the
    // account that started them, so an old 401 cannot log out a newer login.
    const requestAccountVersion = expectedAccountVersion == null ? accountVersion : expectedAccountVersion;
    const headers = new Headers(requestOptions.headers || {});
    if (requestOptions.body && !(requestOptions.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      headers,
    });
    if (res.status === 401) {
      if (requestAccountVersion === accountVersion) {
        setCurrentUser(null);
        // Session expired — show the gate after synchronously clearing reader state.
        showLoginGate();
      }
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      err.isOffline = res.status === 503 && data.error === 'Offline';
      err.book_id = data.book_id;
      err.title = data.title;
      throw err;
    }
    return res;
  },

  async startSession(bookId, opts = {}) {
    const res = await this.fetch('/api/sessions/start', {
      ...opts,
      method: 'POST',
      body: JSON.stringify({ book_id: bookId, client_id: CLIENT_ID }),
    });
    return res.json();
  },

  async endSession(sessionId, opts = {}) {
    if (!sessionId) return;
    const res = await this.fetch(`/api/sessions/${sessionId}/end`, { ...opts, method: 'POST' });
    return res.json();
  },

  async getBooks(opts = {}) {
    const books = [];
    let page = 1;
    let firstPayload = null;
    do {
      const res = await this.fetch(`/api/books?limit=100&page=${page}`, opts);
      const payload = await res.json();
      if (!firstPayload) firstPayload = payload;
      books.push(...(Array.isArray(payload) ? payload : (payload.books || [])));
      if (Array.isArray(payload) || page >= (payload.totalPages || 1)) break;
      page++;
    } while (page <= 10_000);
    return { ...(firstPayload || {}), books, page: 1, totalPages: 1 };
  },

  async uploadBook(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await this.fetch('/api/books', {
      method: 'POST',
      body: formData,
    });
    return res.json();
  },

  async getBookFile(id, opts = {}) {
    const requestAccountVersion = opts.expectedAccountVersion == null ? accountVersion : opts.expectedAccountVersion;
    const key = readerAssetCacheKey(id, requestAccountVersion);
    // R-16: Return Blob from cache — EPUB.js will receive a blob:// URL, no .slice() copy needed
    const cached = getCachedEpubBlob(key);
    if (cached) return cached;
    if (opts.signal && opts.signal.aborted) {
      const error = new Error('The user aborted a request.');
      error.name = 'AbortError';
      throw error;
    }
    if (epubBlobRequests.has(key)) return epubBlobRequests.get(key);

    const pending = this.fetch(`/api/books/${id}/file`, {
      ...opts,
      headers: {},  // no Content-Type for binary
    }).then(res => res.blob()).then(blob => {
      if (requestAccountVersion === accountVersion && currentUser) rememberEpubBlob(key, blob);
      return blob;
    }).finally(() => {
      if (epubBlobRequests.get(key) === pending) epubBlobRequests.delete(key);
    });
    epubBlobRequests.set(key, pending);
    return pending;
  },

  async updateBook(id, data, opts = {}) {
    const res = await this.fetch(`/api/books/${id}`, {
      ...opts,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async deleteBook(id) {
    const res = await this.fetch(`/api/books/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async getStats(opts = {}) {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      : 'UTC';
    const res = await this.fetch(`/api/stats?tz=${encodeURIComponent(tz)}`, opts);
    return res.json();
  },

  async getCollections() {
    const res = await this.fetch('/api/collections');
    return res.json();
  },

  async createCollection(name) {
    const res = await this.fetch('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return res.json();
  },

  async deleteCollection(id) {
    const res = await this.fetch(`/api/collections/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async renameCollection(id, name) {
    const res = await this.fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return res.json();
  },

  async addBookToCollection(bookId, collectionId) {
    const res = await this.fetch(`/api/books/${bookId}/collections/${collectionId}`, {
      method: 'POST',
    });
    return res.json();
  },

  async removeBookFromCollection(bookId, collectionId) {
    const res = await this.fetch(`/api/books/${bookId}/collections/${collectionId}`, {
      method: 'DELETE',
    });
    return res.json();
  },
  async getBookmarks(bookId, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/bookmarks`, opts);
    return res.json();
  },

  async addBookmark(bookId, data, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/bookmarks`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async removeBookmark(id, opts = {}) {
    await this.fetch(`/api/bookmarks/${id}`, { ...opts, method: 'DELETE' });
  },

  async getHighlights(bookId, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/highlights`, opts);
    return res.json();
  },

  async getAllHighlights(query = '', opts = {}) {
    const res = await this.fetch(`/api/highlights?q=${encodeURIComponent(query)}`, opts);
    return res.json();
  },

  async addHighlight(bookId, data, opts = {}) {
    const res = await this.fetch(`/api/books/${bookId}/highlights`, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async updateHighlight(id, data, opts = {}) {
    const res = await this.fetch(`/api/highlights/${id}`, {
      ...opts,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async removeHighlight(id, opts = {}) {
    await this.fetch(`/api/highlights/${id}`, { ...opts, method: 'DELETE' });
  },

  async getSettings(opts = {}) {
    const res = await this.fetch('/api/settings', opts);
    return res.json();
  },

  async saveSettings(data, opts = {}) {
    await this.fetch('/api/settings', {
      ...opts,
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async getUsers() {
    const res = await this.fetch('/api/users');
    return res.json();
  },

  async createUser(data) {
    const res = await this.fetch('/api/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async deleteUser(id) {
    const res = await this.fetch(`/api/users/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async updateUser(id, data) {
    const res = await this.fetch(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.json();
  },
};

/* ---------------- State ---------------- */
let library = [];          // {id, title, author, series, seriesIndex, rating, coverColor, coverPath, progress, lastLocationCfi, bookmarks, highlights}
let book = null;
let rendition = null;
let currentBookId = null;
let locationsReady = false;
var currentSessionId = null;
let toastTimer = null;
let currentUser = null;
let adminModalReturnFocus = null;
let shortcutsModalReturnFocus = null;
let accountVersion = 0;
let readerRequestVersion = 0;
let readerAbortController = null;
let activeReaderRequest = null;
let isDraggingProgressSlider = false;
let seekLockUntil = 0;
let lastReaderInteractionAt = 0;
let personalReadingBytesPerMinute = 4200;
const CLIENT_ID = sessionStorage.getItem('endpaper_client_id') || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
sessionStorage.setItem('endpaper_client_id', CLIENT_ID);

function showToast(message, action = null) {
  const toast = document.getElementById('toast');
  toast.innerHTML = '';
  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (action && action.text && action.onClick) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action-btn';
    actionBtn.textContent = action.text;
    actionBtn.style.marginLeft = '12px';
    actionBtn.style.padding = '2px 8px';
    actionBtn.style.borderRadius = '4px';
    actionBtn.style.border = '1px solid currentColor';
    actionBtn.style.background = 'transparent';
    actionBtn.style.color = 'inherit';
    actionBtn.style.cursor = 'pointer';
    actionBtn.style.font = 'inherit';
    actionBtn.style.fontWeight = '600';
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      toast.classList.remove('show');
      action.onClick();
    };
    toast.appendChild(actionBtn);
  }

  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 5000 : 3200);
}

function isCurrentUserAdmin() {
  return Boolean(currentUser && currentUser.isAdmin);
}

function updateRoleAwareControls() {
  const isAdmin = isCurrentUserAdmin();
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.hidden = !isAdmin;
    if (el.matches('input')) el.disabled = !isAdmin;
  });

  const accountContext = document.getElementById('current-user-context');
  const accountName = document.getElementById('current-user-name');
  const accountRole = document.getElementById('current-user-role');
  if (accountContext && accountName && accountRole && currentUser && currentUser.username) {
    accountName.textContent = currentUser.username;
    accountRole.textContent = isAdmin ? 'Admin' : 'Reader';
    accountRole.className = `role-badge ${isAdmin ? 'admin' : 'reader'}`;
    accountContext.title = `Signed in as ${currentUser.username} (${isAdmin ? 'Admin' : 'Reader'})`;
    accountContext.hidden = false;
  } else if (accountContext) {
    accountContext.hidden = true;
  }

  const adminModal = document.getElementById('admin-modal');
  if (!isAdmin && adminModal && adminModal.classList.contains('show')) {
    closeAdminModal({ returnFocus: false });
  }

  const uploadButton = document.getElementById('upload-btn');
  const readerActive = document.getElementById('reader-view').classList.contains('active');
  if (uploadButton) uploadButton.style.display = !readerActive ? 'flex' : 'none';

  const dropzoneEl = document.getElementById('dropzone');
  if (dropzoneEl) dropzoneEl.classList.remove('drag-over');

  const emptyCopy = document.getElementById('empty-shelf-copy');
  if (emptyCopy) {
    emptyCopy.textContent = 'Add an EPUB to the shared library. Everyone can read it, while bookmarks, progress, and settings stay personal.';
  }
}

function userIdentity(user) {
  return user && user.username ? `${user.username}\u0000${user.isAdmin ? 'admin' : 'reader'}` : null;
}

function isActiveAccount(version) {
  return Boolean(currentUser) && version === accountVersion;
}

function setCurrentUser(session) {
  const nextUser = session && session.ok !== false
    ? { isAdmin: Boolean(session.is_admin), username: session.username || null }
    : null;
  if (userIdentity(currentUser) !== userIdentity(nextUser)) {
    accountVersion += 1;
    // Never leave one family member's active rendition or private metadata
    // visible while the next account is being opened.
    discardReaderState({ clearLibrary: true, resetPreferences: true });
  }
  currentUser = nextUser;
  updateRoleAwareControls();
}

function requireAdmin(action) {
  if (isCurrentUserAdmin()) return true;
  showToast(`Only an admin can ${action}.`);
  return false;
}

async function refreshCurrentUser() {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (!res.ok) {
    setCurrentUser(null);
    return null;
  }
  const session = await res.json();
  setCurrentUser(session);
  return session;
}

const DEFAULT_READER_SETTINGS = Object.freeze({
  theme: 'light',
  font: 'Serif (Georgia)',
  fontSize: 100,
  lineHeight: 150,
  marginIdx: 1,
  letterSpacingIdx: 0,
  layout: 'paginated',
  gestures: { swipe: true, edge: true, center: true },
});

const settings = { ...DEFAULT_READER_SETTINGS };

const FONTS = [
  { name: 'Serif (Georgia)', css: 'Georgia, "Times New Roman", serif' },
  { name: 'Book (Atkinson)', css: '"Atkinson Hyperlegible", sans-serif' },
  { name: 'Sans (Work Sans)', css: '"Work Sans", Helvetica, Arial, sans-serif' },
  { name: 'Classic Serif', css: '"Palatino Linotype", Palatino, serif' },
  { name: 'Monospace', css: '"Courier New", monospace' },
];

const THEMES = {
  light: { body: '#F6F1E7', text: '#201C16', link: '#A9803F' },
  sepia: { body: '#EBDCC0', text: '#4A3A22', link: '#8A6A2F' },
  dark:  { body: '#22262C', text: '#DAD5C8', link: '#C9973F' },
  night: { body: '#000000', text: '#B8B8B8', link: '#E0B15C' },
};

// Many EPUBs hard-code foreground colours on individual text elements. Keep
// the override deliberately text-only so page art and SVG illustrations retain
// their authored fills while Dark and Night pages remain readable.
const EPUB_TEXT_SELECTORS = 'body, body p, body div, body span, body li, body dd, body dt, body blockquote, body figcaption, body caption, body td, body th, body h1, body h2, body h3, body h4, body h5, body h6, body em, body strong, body b, body i, body small, body cite, body q, body code, body pre, body [style*="color"]';

const MARGIN_LABELS = ['Narrow', 'Medium', 'Wide'];
const MARGIN_PADDING = ['4%', '10%', '18%'];
const SPACING_LABELS = ['Normal', 'Relaxed', 'Loose', 'Airy'];
const SPACING_VALUES = ['normal', '0.5px', '1px', '1.6px'];

const spineColors = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#8A6A2F','#43506B'];

function normalizeSettings() {
  if (!THEMES[settings.theme]) settings.theme = 'light';
  if (!FONTS.some(font => font.name === settings.font)) settings.font = FONTS[0].name;
  settings.fontSize = Number.isFinite(settings.fontSize) ? Math.max(70, Math.min(220, Math.round(settings.fontSize / 10) * 10)) : 100;
  settings.lineHeight = Number.isFinite(settings.lineHeight) ? Math.max(120, Math.min(220, Math.round(settings.lineHeight / 10) * 10)) : 150;
  settings.marginIdx = Number.isInteger(settings.marginIdx) ? Math.max(0, Math.min(MARGIN_LABELS.length - 1, settings.marginIdx)) : 1;
  settings.letterSpacingIdx = Number.isInteger(settings.letterSpacingIdx) ? Math.max(0, Math.min(SPACING_VALUES.length - 1, settings.letterSpacingIdx)) : 0;
  if (!['paginated', 'scrolled'].includes(settings.layout)) settings.layout = 'paginated';
  settings.gestures = { swipe: true, edge: true, center: true, ...(settings.gestures || {}) };
}

/* ---------------- Auth gate ---------------- */
function showLoginGate() {
  document.getElementById('login-gate').classList.remove('hidden');
}

function hideLoginGate() {
  document.getElementById('login-gate').classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  const userIn = document.getElementById('username-input');
  const passIn = document.getElementById('passphrase-input');
  const username = userIn.value.trim();
  const passphrase = passIn.value;

  if (!username) { errEl.textContent = 'Please enter a username.'; return false; }
  if (!passphrase) { errEl.textContent = 'Please enter a passphrase.'; return false; }

  btn.disabled = true;
  errEl.textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passphrase }),
    });

    if (res.ok) {
      userIn.value = '';
      passIn.value = '';
      const session = await refreshCurrentUser();
      if (!session) {
        errEl.textContent = 'Your session could not be started. Please try again.';
      } else {
        hideLoginGate();
        boot();
      }
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || 'Incorrect passphrase.';
    }
  } catch (err) {
    errEl.textContent = 'Connection error. Please try again.';
  }

  btn.disabled = false;
  return false;
}

async function logout() {
  if (currentBookId || rendition || currentSessionId) {
    await showShelf();
  }
  if (!currentUser) {
    showLoginGate();
    return;
  }
  try {
    await api.fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    // A stale session is already effectively logged out; show the gate either way.
    console.error('Logout failed:', err);
  }
  if (currentSessionId) {
    currentSessionId = null;
  }
  setCurrentUser(null);
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_RUNTIME_CACHE' });
  }
  showLoginGate();
  document.getElementById('username-input').focus();
  showToast('You have been logged out.');
}

/* ---------------- Font options UI ---------------- */
function renderFontOptions(){
  const wrap = document.getElementById('font-options');
  wrap.innerHTML = '';
  FONTS.forEach(f => {
    const selected = settings.font === f.name;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'font-option' + (selected ? ' active' : '');
    el.style.fontFamily = f.css;
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-checked', String(selected));
    el.innerHTML = `<span>${f.name}</span><span class="check">✓</span>`;
    el.onclick = () => { settings.font = f.name; renderFontOptions(); applyTheme(); };
    wrap.appendChild(el);
  });
}
renderFontOptions();

/* ---------------- Drag & drop / upload ---------------- */
const dropzone = document.getElementById('dropzone');
['dragover','dragenter'].forEach(evt => document.body.addEventListener(evt, e => {
  e.preventDefault();
  if (dropzone) dropzone.classList.add('drag-over');
}));
['dragleave','drop'].forEach(evt => document.body.addEventListener(evt, e => {
  e.preventDefault();
  if (dropzone) dropzone.classList.remove('drag-over');
}));
document.body.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});
document.getElementById('file-input').addEventListener('change', e => handleFiles(e.target.files));

async function handleFiles(fileList){
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const epubFiles = files.filter(f => f.name.toLowerCase().endsWith('.epub'));
  if (epubFiles.length === 0) return;

  const progressEl = document.getElementById('upload-progress');
  const progressText = document.getElementById('upload-progress-text');
  progressEl.classList.add('show');
  progressText.replaceChildren();
  const uploadHeading = document.createElement('strong');
  uploadHeading.textContent = `Adding ${epubFiles.length} book${epubFiles.length === 1 ? '' : 's'}`;
  const uploadList = document.createElement('div');
  const uploadRows = epubFiles.map(file => {
    const row = document.createElement('div');
    row.className = 'upload-status-row';
    row.textContent = `${file.name} — waiting`;
    uploadList.appendChild(row);
    return row;
  });
  progressText.append(uploadHeading, uploadList);

  let uploaded = 0;
  let lastAddedBookId = null;
  for (let i = 0; i < epubFiles.length; i++) {
    const file = epubFiles[i];
    uploadRows[i].textContent = `${file.name} — uploading…`;
    try {
      const bookData = await api.uploadBook(file);
      const entry = {
        id: bookData.id,
        name: bookData.title,
        author: bookData.author,
        series: bookData.series || null,
        seriesIndex: bookData.series_index != null && bookData.series_index !== '' ? bookData.series_index : null,
        rating: bookData.rating != null ? Number(bookData.rating) : null,
        coverColor: bookData.cover_color,
        coverPath: bookData.cover_path,
        description: bookData.description || '',
        isbn: bookData.isbn || '',
        tags: bookData.tags || '',
        progress: bookData.progress_percent || 0,
        status: bookData.status || 'unread',
        lastLocationCfi: bookData.last_location_cfi,
        fileSize: Number(bookData.file_size) || file.size || 0,
        addedAt: bookData.added_at ? new Date(bookData.added_at).getTime() : Date.now(),
        lastOpenedAt: bookData.last_opened_at ? new Date(bookData.last_opened_at).getTime() : null,
        bookmarks: [],
        highlights: [],
      };
      library.push(entry);
      renderShelf();
      lastAddedBookId = entry.id;
      uploaded++;
      uploadRows[i].textContent = `${file.name} — added`;
    } catch(err) {
      console.error('Upload failed:', err);
      if (err.status === 409 || (err.message && err.message.toLowerCase().includes('already in the library'))) {
        const bookId = err.book_id || (err.data && err.data.book_id);
        const bookTitle = (err.data && err.data.title) || file.name;
        showToast(`“${bookTitle}” is already in the library.`, bookId ? {
          text: 'Open',
          onClick: () => openBook(bookId)
        } : null);
      } else {
        showToast(`Could not add “${file.name}”: ${err.message}`);
      }
      uploadRows[i].textContent = `${file.name} — ${err.status === 409 ? 'already in library' : 'failed'}`;
    }
  }
  progressEl.classList.remove('show');
  if (uploaded === 1) showToast('Book added to your library.');
  else if (uploaded > 1) showToast(`${uploaded} books added to your library.`);
  document.getElementById('file-input').value = '';
  if (epubFiles.length === 1 && uploaded === 1 && lastAddedBookId) openBook(lastAddedBookId);
}

/* ---------------- Shelf rendering ---------------- */
let bookWarmupHandle = null;
let bookWarmupKey = null;

function cancelBookWarmup() {
  if (bookWarmupHandle == null) return;
  if ('cancelIdleCallback' in window) window.cancelIdleCallback(bookWarmupHandle);
  else clearTimeout(bookWarmupHandle);
  bookWarmupHandle = null;
  bookWarmupKey = null;
}

function scheduleBookWarmup(entry) {
  if (!entry || !currentUser || entry.fileSize > EPUB_BUFFER_CACHE_MAX_ITEM_BYTES) return;
  // R-17/R-18: Touch/mobile devices have no hover intent signal — prefetching a
  // large EPUB wastes bandwidth with no user benefit. Warmup is desktop-only.
  if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection && (connection.saveData || /(^|-)2g$/.test(connection.effectiveType || ''))) return;
  const expectedAccountVersion = accountVersion;
  const key = readerAssetCacheKey(entry.id, expectedAccountVersion);
  if (epubBlobCache.has(key) || epubBlobRequests.has(key) || bookWarmupKey === key) return;

  cancelBookWarmup();
  bookWarmupKey = key;
  const warm = () => {
    bookWarmupHandle = null;
    bookWarmupKey = null;
    if (!isActiveAccount(expectedAccountVersion) || currentBookId) return;
    api.getBookFile(entry.id, { expectedAccountVersion }).catch(() => {});
  };
  bookWarmupHandle = 'requestIdleCallback' in window
    ? window.requestIdleCallback(warm, { timeout: 2500 })
    : setTimeout(warm, 800);
}

function formatSeriesText(series, seriesIndex) {
  if (!series) return '';
  if (seriesIndex != null && seriesIndex !== '') {
    return `Book ${seriesIndex} of ${series}`;
  }
  return series;
}

function renderRatingHtml(bookId, currentRating) {
  const r = Number(currentRating) || 0;
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= r ? ' filled' : '';
    const glyph = i <= r ? '★' : '☆';
    stars += `<button type="button" class="star-btn${filled}" title="Rate ${i} star${i > 1 ? 's' : ''}" onclick="event.stopPropagation(); setBookRating('${bookId}', ${i === r ? 'null' : i})">${glyph}</button>`;
  }
  return `<div class="rating-stars" role="group" aria-label="Book rating">${stars}</div>`;
}

async function setBookRating(bookId, rating) {
  const entry = library.find(b => b.id === bookId);
  if (entry) entry.rating = rating;
  renderShelf();
  if (activeOrganizeBookId === bookId) {
    const ratingContainer = document.querySelector('#collection-list .rating-stars');
    if (ratingContainer) {
      ratingContainer.outerHTML = renderRatingHtml(bookId, rating);
    }
  }
  try {
    await api.updateBook(bookId, { rating });
    showToast(rating ? `Rated ${rating} star${rating > 1 ? 's' : ''}.` : 'Rating cleared.');
  } catch (err) {
    console.error('Rating update failed:', err);
    showToast(`Could not update rating: ${err.message}`);
  }
}

function renderContinueCard(){
  const card = document.getElementById('continue-card');
  const candidates = library.filter(b => b.lastOpenedAt);
  if (candidates.length === 0){ card.style.display = 'none'; return; }
  const b = candidates.sort((x, y) => y.lastOpenedAt - x.lastOpenedAt)[0];
  const coverStyle = b.coverPath
    ? `background-image:url('/api/books/${b.id}/cover'); background-size:cover; background-position:center;`
    : `background:${b.coverColor};`;
  const seriesInfo = b.series ? `<div class="continue-series">${escapeHtml(formatSeriesText(b.series, b.seriesIndex))}</div>` : '';
  const ratingWidget = `<div style="margin-top:6px;">${renderRatingHtml(b.id, b.rating)}</div>`;
  card.innerHTML = `
    <div class="spine spine-book" style="${coverStyle}">${b.coverPath ? '' : `<span class="spine-title">${escapeHtml(b.name)}</span>`}</div>
    <div id="continue-info">
      <div class="kicker">Continue reading</div>
      <h3>${escapeHtml(b.name)}</h3>
      ${seriesInfo}
      <div class="author">${escapeHtml(b.author || 'Unknown author')}</div>
      <div class="progress-text">${b.progress}% through the book</div>
      <div class="book-progress-bar" style="margin-top:8px;"><div class="book-progress-fill" style="width:${b.progress}%"></div></div>
      ${ratingWidget}
    </div>
  `;
  card.style.display = 'flex';
  card.onclick = () => openBook(b.id);
  scheduleBookWarmup(b);
}

function renderShelf(){
  const shelf = document.getElementById('shelf');
  const empty = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  shelf.innerHTML = '';
  renderContinueCard();
  if (library.length === 0){
    empty.style.display = 'block';
    header.style.display = 'none';
    document.getElementById('continue-card').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  header.style.display = 'flex';
  document.getElementById('shelf-count').textContent = library.length + (library.length === 1 ? ' book' : ' books');

  // Search, filtering, and sorting
  const searchQuery = document.getElementById('shelf-search').value.trim().toLocaleLowerCase();
  const filterVal = document.getElementById('shelf-filter').value;
  let filtered = searchQuery
    ? library.filter(b => `${b.name || ''} ${b.author || ''}`.toLocaleLowerCase().includes(searchQuery))
    : library;
  if (filterVal === 'unread') filtered = filtered.filter(b => b.progress === 0);
  // R-22: threshold raised from 95 to 98 — avoids premature finished marking on
  // the second-to-last chapter (R-21 formula now makes last entry reach 100% only
  // at its actual end, so 98% is a safe auto-finish trigger)
  else if (filterVal === 'finished') filtered = filtered.filter(b => b.progress >= 98);
  else if (filterVal.startsWith('col_')) {
    const colId = filterVal.substring(4);
    const col = allCollections.find(c => c.id === colId);
    if (col) filtered = filtered.filter(b => col.book_ids.includes(b.id));
  }

  // Sorting
  const sortVal = document.getElementById('shelf-sort').value;
  filtered = [...filtered].sort((a, b) => {
    if (sortVal === 'recent') return (b.addedAt || 0) - (a.addedAt || 0);
    if (sortVal === 'opened') return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (sortVal === 'title') return a.name.localeCompare(b.name);
    if (sortVal === 'author') return (a.author || '').localeCompare(b.author || '');
    if (sortVal === 'series') {
      const aSeries = a.series || '';
      const bSeries = b.series || '';
      if (!aSeries && bSeries) return 1;
      if (aSeries && !bSeries) return -1;
      const sComp = aSeries.localeCompare(bSeries);
      if (sComp !== 0) return sComp;
      const idxComp = (a.seriesIndex || 0) - (b.seriesIndex || 0);
      if (idxComp !== 0) return idxComp;
      return a.name.localeCompare(b.name);
    }
    if (sortVal === 'progress') return b.progress - a.progress;
    return 0;
  });

  filtered.forEach(b => {
    const card = document.createElement('div');
    card.className = 'book-card';
    const coverStyle = b.coverPath
      ? `background-image:url('/api/books/${b.id}/cover'); background-size:cover; background-position:center;`
      : `background:${b.coverColor};`;
    const adminActions = isCurrentUserAdmin() ? `
      <div class="spine-actions">
        <button type="button" class="spine-action-btn" title="Organize shared collections" onclick="event.stopPropagation(); openBookCollectionsModal('${b.id}')">Organize</button>
        <button type="button" class="spine-action-btn" title="Remove from shared library" onclick="event.stopPropagation(); removeBook('${b.id}')">Remove</button>
      </div>
    ` : '';
    const progressBadge = b.progress > 0
      ? `<span class="spine-badge">${b.progress}%</span>`
      : '';
    const seriesBadge = b.series ? `<div class="series-tag">${escapeHtml(formatSeriesText(b.series, b.seriesIndex))}</div>` : '';
    const ratingHtml = `<div class="shelf-rating-widget">${renderRatingHtml(b.id, b.rating)}</div>`;
    card.innerHTML = `
      <div class="spine" style="${coverStyle}">
        ${b.coverPath ? '' : `<span class="spine-title">${escapeHtml(b.name)}</span>`}
        ${b.coverPath ? '' : `<span class="spine-author">${escapeHtml(b.author || '')}</span>`}
        ${progressBadge}
        ${adminActions}
      </div>
      <div class="book-meta-under">
        ${seriesBadge}
        <div class="title" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</div>
        <div class="author">${escapeHtml(b.author || 'Unknown')}</div>
        ${ratingHtml}
        <div class="book-progress-bar"><div class="book-progress-fill" style="width:${b.progress}%"></div></div>
      </div>
    `;
    card.onclick = () => openBook(b.id);
    shelf.appendChild(card);
  });
}

async function removeBook(id){
  if (!requireAdmin('remove books from the shared library')) return;
  const entry = library.find(b => b.id === id);
  if (!entry) return;
  const confirmed = await showConfirmDialog({
    title: 'Remove Book',
    message: `Remove “${entry.name}” and all of its bookmarks and highlights? This cannot be undone.`,
    confirmText: 'Remove Book',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteBook(id);
    library = library.filter(b => b.id !== id);
    renderShelf();
    showToast('Book removed.');
  } catch(e) {
    console.error('Delete failed:', e);
    showToast(`Could not remove the book: ${e.message}`);
  }
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

async function showShelf(){
  const entry = getCurrentEntry();
  const sessionId = currentSessionId;
  const saveAccountVersion = accountVersion;
  // Tear down first, so a late EPUB/network callback cannot revive this reader.
  discardReaderState();
  renderShelf();
  updateRoleAwareControls();

  if (!isActiveAccount(saveAccountVersion)) return;
  if (entry) {
    const saved = await saveBookMeta(entry, { expectedAccountVersion: saveAccountVersion, allowInactiveReader: true });
    if (!saved || !isActiveAccount(saveAccountVersion)) return;
  }
  if (sessionId && isActiveAccount(saveAccountVersion)) {
    try {
      await api.endSession(sessionId, { expectedAccountVersion: saveAccountVersion });
    } catch (e) {
      if (isActiveAccount(saveAccountVersion)) console.error('Could not end reading session:', e);
    }
  }
  if (window.__reloadAfterReader && isActiveAccount(saveAccountVersion)) {
    window.__reloadAfterReader = false;
    window.location.reload();
  }
}

/* ---------------- Layout (paginated vs scrolled) ---------------- */
function renditionOptions(){
  if (settings.layout === 'scrolled'){
    return {
      width: '100%', height: '100%',
      flow: 'scrolled', manager: 'continuous',
      snap: false,
      sandbox: 'allow-same-origin',
    };
  }
  return { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', sandbox: 'allow-same-origin' };
}

function setLayout(mode){
  if (settings.layout === mode || !book) { settings.layout = mode; updateSettingsUI(); saveSettings(); return; }
  settings.layout = mode;
  const entry = library.find(b => b.id === currentBookId);
  const targetBook = book;
  const request = activeReaderRequest;
  if (!entry || !request) { updateSettingsUI(); saveSettings(); return; }
  const resumeCfi = getSafeCfi() || entry.lastLocationCfi;
  if (resumeCfi) entry.lastLocationCfi = resumeCfi;

  hideHighlightPopup();
  rendition.destroy();
  document.getElementById('viewer').innerHTML = '';
  document.getElementById('reader-view').classList.toggle('scrolled', mode === 'scrolled');

  rendition = book.renderTo('viewer', renditionOptions());
  const targetRendition = rendition;
  registerThemes();
  registerSwipeGestures();
  applyTheme();
  bindRenditionInteractions(entry, targetRendition, request);
  bindRelocated(entry, targetRendition, targetBook, request);
  targetRendition.display(resumeCfi || undefined).then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    tuneScrollContainer(targetRendition);
    applySavedHighlights(entry, targetRendition);
    updateBookmarkIcon();
  }).catch(err => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition)) console.error('Could not switch reading layout:', err);
  });
  updateSettingsUI();
}

function applyReaderContentStyles(contents) {
  const doc = contents && contents.document;
  if (!doc) return;
  let style = doc.getElementById('endpaper-reader-content-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'endpaper-reader-content-style';
    (doc.head || doc.documentElement).appendChild(style);
  }
  const theme = THEMES[settings.theme] || THEMES.light;
  const isScrolled = settings.layout === 'scrolled';
  style.textContent = `
    @media (max-width: 699px) {
      p, li, blockquote { text-align: start !important; hyphens: auto; -webkit-hyphens: auto; }
    }
    html, body {
      background-color: ${theme.body} !important;
      color: ${theme.text} !important;
      box-sizing: border-box !important;
      -webkit-user-select: auto;
      overflow-anchor: none !important;
      touch-action: pan-y !important;
      overscroll-behavior: none !important;
      -webkit-overflow-scrolling: touch;
    }
    body {
      margin: 0 !important;
      ${isScrolled ? 'padding-top: 14px !important; padding-bottom: 80px !important;' : 'padding-top: 0 !important; padding-bottom: 0 !important;'}
    }
    body p, body div, body span, body li, body dd, body dt, body blockquote, body figcaption, body td, body th, body h1, body h2, body h3, body h4, body h5, body h6 {
      color: inherit !important;
      background-color: transparent !important;
    }
    a, a:link, a:visited {
      color: ${theme.link} !important;
    }
    img, svg {
      max-width: 100% !important;
      height: auto !important;
    }
    .endpaper-tts-active {
      background-color: rgba(201, 151, 63, 0.32) !important;
      border-radius: 4px !important;
      box-shadow: 0 0 0 2px rgba(201, 151, 63, 0.45) !important;
      transition: background-color 0.15s ease, box-shadow 0.15s ease !important;
    }
  `;
}

function isInteractiveReaderTarget(target) {
  return Boolean(target && target.closest && target.closest('a, button, input, textarea, select, summary, [contenteditable="true"]'));
}

function handleReaderSwipeOrTap(sx, sy, ex, ey, dt, moved, width, win, isCancel) {
  if (!rendition) return false;
  lastReaderInteractionAt = Date.now();
  const dx = ex - sx;
  const dy = ey - sy;

  // If user has an active text selection in the window, do not trigger page turns
  if (win && win.getSelection && !win.getSelection().isCollapsed) return false;

  // 1. Horizontal swipe gesture in paginated mode
  if (settings.layout === 'paginated' && settings.gestures.swipe) {
    const swipeThreshold = 30; // Responsive threshold for mobile swipe
    if (Math.abs(dx) >= swipeThreshold && Math.abs(dx) > Math.abs(dy) * 1.1 && dt < 800) {
      if (dx < 0) turnPage('next');
      else turnPage('prev');
      return true;
    }
  }

  // 2. Clean tap: tap-to-turn zones (left 25% = prev, right 25% = next, center = toggle controls)
  if (!isCancel && !moved && Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 450) {
    if (settings.layout === 'paginated' && settings.gestures.edge) {
      if (ex < width * 0.25) {
        turnPage('prev');
        return true;
      } else if (ex > width * 0.75) {
        turnPage('next');
        return true;
      }
    }
    if (settings.gestures.center) {
      toggleReaderChrome();
      return true;
    }
  }
  return false;
}

function initViewerWrapGestures() {
  const wrap = document.getElementById('viewer-wrap');
  if (!wrap || wrap.__gestureBound) return;
  wrap.__gestureBound = true;

  let sx = 0, sy = 0, st = 0, moved = false, handled = false;

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    st = Date.now();
    moved = false;
    handled = false;
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
  }, { passive: true });

  const onEndOrCancel = (e, isCancel) => {
    if (e.target && e.target.tagName === 'IFRAME') return;
    if (handled || !rendition || !e.changedTouches || !e.changedTouches.length) return;
    if (isInteractiveReaderTarget(e.target)) return;

    const t = e.changedTouches[0];
    const width = wrap.clientWidth || window.innerWidth;
    const res = handleReaderSwipeOrTap(sx, sy, t.clientX, t.clientY, Date.now() - st, moved, width, window, isCancel);
    if (res) handled = true;
  };

  wrap.addEventListener('touchend', (e) => onEndOrCancel(e, false), { passive: true });
  wrap.addEventListener('touchcancel', (e) => onEndOrCancel(e, true), { passive: true });
}

function registerSwipeGestures(){
  initViewerWrapGestures();
  if (!rendition || !rendition.hooks) return;
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    const win = contents.window || (doc && doc.defaultView);
    applyReaderContentStyles(contents);
    doc.addEventListener('keydown', handleReaderShortcut);

    let sx = 0, sy = 0, st = 0, moved = false, handled = false;

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = Date.now();
      moved = false;
      handled = false;
    };

    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
    };

    const onTouchEndOrCancel = (e, isCancel) => {
      if (handled || !rendition || !e.changedTouches || !e.changedTouches.length) return;
      if (isInteractiveReaderTarget(e.target)) return;

      const t = e.changedTouches[0];
      const width = win ? win.innerWidth : (doc.documentElement ? doc.documentElement.clientWidth : window.innerWidth);
      const res = handleReaderSwipeOrTap(sx, sy, t.clientX, t.clientY, Date.now() - st, moved, width, win, isCancel);
      if (res) handled = true;
    };

    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: true });
    doc.addEventListener('touchend', (e) => onTouchEndOrCancel(e, false), { passive: true });
    doc.addEventListener('touchcancel', (e) => onTouchEndOrCancel(e, true), { passive: true });
  });
}

let chromeHintShown = false;
let chromeResizeTimer = null;
let chromeResizeFrame = null;
let lastReaderViewportSize = { width: 0, height: 0 };
// Auto-hide timer for the Kindle-like 3-second chrome dismiss (R-13)
let readerChromeTimer = null;

// Page-turn serialization mutex — all rendition.next()/prev() calls route through
// turnPage() to prevent overlapping navigations from swipe, tap, keyboard, and TTS (R-09)
let pageTurnLock = false;
let pageTurnLockTimer = null;

function turnPage(direction) {
  if (!rendition || pageTurnLock) return;
  pageTurnLock = true;
  clearTimeout(pageTurnLockTimer);
  let promise;
  try { promise = direction === 'next' ? rendition.next() : rendition.prev(); } catch (_) {}
  const unlock = () => { pageTurnLock = false; };
  if (promise && typeof promise.then === 'function') {
    pageTurnLockTimer = setTimeout(unlock, 600);
    promise.then(unlock, unlock);
  } else {
    pageTurnLockTimer = setTimeout(unlock, 600);
  }
}

/**
 * Safely read the current CFI without crashing when EPUB.js returns a Promise
 * from currentLocation() (R-12).
 */
function getSafeCfi(targetRendition) {
  try {
    const r = targetRendition || rendition;
    if (!r || !r.currentLocation) return null;
    const loc = r.currentLocation();
    if (!loc || typeof loc.then === 'function') return null;
    return (loc.start && loc.start.cfi) || null;
  } catch (_) { return null; }
}

async function getCurrentLocationSafe(targetRendition = rendition) {
  try {
    if (!targetRendition || !targetRendition.currentLocation) return null;
    return await Promise.resolve(targetRendition.currentLocation());
  } catch (_) { return null; }
}

function isTouchReader(){
  return Boolean(
    document.body.classList.contains('reader-active') &&
    window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function readerFullscreenElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isImmersiveReading(){
  const app = document.getElementById('app');
  return Boolean(app && app.classList.contains('chrome-hidden'));
}

function resizeReaderViewport(){
  const viewport = document.getElementById('viewer-wrap');
  if (!rendition || !viewport) return;
  const width = Math.round(viewport.clientWidth);
  const height = Math.round(viewport.clientHeight);
  if (width < 1 || height < 1) return;
  // Skip redundant resizes — prevents spurious relayouts during chrome animation (R-01)
  if (lastReaderViewportSize.width === width && lastReaderViewportSize.height === height) return;
  lastReaderViewportSize = { width, height };
  try { rendition.resize(width, height); } catch (e) {}
}

function scheduleReaderResize(){
  if (chromeResizeFrame != null) cancelAnimationFrame(chromeResizeFrame);
  clearTimeout(chromeResizeTimer);
  chromeResizeFrame = requestAnimationFrame(() => {
    chromeResizeFrame = requestAnimationFrame(() => {
      chromeResizeFrame = null;
      resizeReaderViewport();
    });
  });
  // The bars animate for 250ms. A final measured resize after the transition
  // prevents EPUB.js from retaining the smaller, pre-fullscreen page box.
  chromeResizeTimer = setTimeout(resizeReaderViewport, 320);
}


function syncReaderChromeAccessibility(){
  const app = document.getElementById('app');
  const hidden = app.classList.contains('chrome-hidden');
  ['topbar', 'progress-bar'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.setAttribute('aria-hidden', String(hidden));
    element.toggleAttribute('inert', hidden);
  });
}

function updateFullscreenControlUI(){
  const desktopBtn = document.getElementById('fullscreen-btn');
  const app = document.getElementById('app');
  if (!app) return;
  const immersive = isImmersiveReading() || Boolean(readerFullscreenElement());
  if (desktopBtn) {
    desktopBtn.setAttribute('aria-pressed', String(immersive));
    desktopBtn.setAttribute('aria-label', immersive ? 'Exit fullscreen' : 'Fullscreen');
    desktopBtn.title = immersive ? 'Exit fullscreen' : 'Fullscreen';
  }
}

function requestReaderFullscreen(){
  const app = document.getElementById('app');
  if (!app || readerFullscreenElement()) return;
  const request = app.requestFullscreen || app.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = app.requestFullscreen
      ? request.call(app, { navigationUI: 'hide' })
      : request.call(app);
    if (result && result.then) result.then(scheduleReaderResize).catch(scheduleReaderResize);
  } catch (e) {
    // The chrome-hidden state remains a useful immersive fallback on browsers
    // that do not permit the Fullscreen API for embedded EPUB interactions.
  }
}

function exitReaderFullscreen(){
  const app = document.getElementById('app');
  if (!app || !readerFullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const result = exit.call(document);
    if (result && result.catch) result.catch(() => {});
  } catch (e) {}
}

function enterImmersiveReading(){
  const app = document.getElementById('app');
  if (!app || !document.body.classList.contains('reader-active')) return false;
  clearTimeout(readerChromeTimer);
  readerChromeTimer = null;
  app.classList.add('chrome-hidden');
  closeDrawers();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  // R-13: Viewer dimensions are constant (overlays float on top) — no resize needed
  return true;
}

function exitImmersiveReading(){
  const app = document.getElementById('app');
  if (!app) return false;
  app.classList.remove('chrome-hidden');
  exitReaderFullscreen();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  // R-13: Viewer dimensions unchanged — no resize needed
  return true;
}

// Show chrome and start a 3-second auto-hide timer (Kindle-like UX, R-13).
// Tapping center while chrome is visible calls enterImmersiveReading() directly.
function showReaderChromeTemporarily(delay = 3000) {
  const app = document.getElementById('app');
  if (!app || !document.body.classList.contains('reader-active')) return;
  app.classList.remove('chrome-hidden');
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  clearTimeout(readerChromeTimer);
  readerChromeTimer = setTimeout(() => {
    readerChromeTimer = null;
    if (
      document.body.classList.contains('reader-active') &&
      !document.querySelector('.drawer[aria-hidden="false"]')
    ) {
      enterImmersiveReading();
    }
  }, delay);
}

function toggleReaderChrome(){
  // Tapping center: if currently immersive — show chrome briefly then auto-hide;
  // if chrome is visible — hide it immediately and cancel any pending timer.
  if (isImmersiveReading()) showReaderChromeTemporarily();
  else enterImmersiveReading();
}

function tuneScrollContainer(targetRendition = rendition, entry = getCurrentEntry(), request = activeReaderRequest){
  if (settings.layout !== 'scrolled' || !targetRendition || !targetRendition.manager) {
    return;
  }
  const el = targetRendition.manager.container;
  if (!el) return;
  el.style.scrollBehavior = 'auto';
  el.style.webkitOverflowScrolling = 'touch';
  el.style.overscrollBehavior = 'contain';
  el.style.overflowAnchor = 'none';
  el.id = 'epub-scroll-container';
  el.style.scrollbarWidth = 'thin';
  el.style.scrollbarColor = 'var(--gold) transparent';

  if (!el.__endpaperScrollListenerBound) {
    el.__endpaperScrollListenerBound = true;
    let scrollRaf = null;
    el.addEventListener('scroll', () => {
      lastReaderInteractionAt = Date.now();
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(async () => {
        scrollRaf = null;
        if (!isReaderRequestCurrent(request, book, targetRendition)) return;
        const currentEntry = entry || getCurrentEntry();
        if (!currentEntry) return;
        const loc = await getCurrentLocationSafe(targetRendition);
        if (loc && loc.start && isReaderRequestCurrent(request, book, targetRendition)) updateReaderLocation(currentEntry, loc, book, targetRendition, request);
      });
    }, { passive: true });
  }
}

function pageScroll(direction){
  if (settings.layout !== 'scrolled' || !rendition || !rendition.manager) return false;
  const el = rendition.manager.container;
  if (!el) return false;
  let lineHeight = 24;
  try {
    const iframeBody = document.querySelector('#viewer iframe')?.contentDocument?.body;
    if (iframeBody) {
      const lh = parseFloat(window.getComputedStyle(iframeBody).lineHeight);
      if (!isNaN(lh) && lh > 0) lineHeight = lh;
    }
  } catch (_) {}
  const rawScroll = el.clientHeight * 0.85;
  const snappedScroll = Math.round(rawScroll / lineHeight) * lineHeight;
  el.scrollBy({ top: direction * snappedScroll, behavior: 'smooth' });
  return true;
}

function createReaderRequest(bookId) {
  abortReaderRequests();
  readerAbortController = new AbortController();
  const request = {
    version: readerRequestVersion,
    accountVersion,
    bookId,
    controller: readerAbortController,
  };
  activeReaderRequest = request;
  return request;
}

function readerRequestOptions(request) {
  return { signal: request.controller.signal, expectedAccountVersion: request.accountVersion };
}

function isReaderRequestCurrent(request, targetBook = book, targetRendition = rendition) {
  return Boolean(
    request && activeReaderRequest === request && readerRequestVersion === request.version &&
    accountVersion === request.accountVersion && currentBookId === request.bookId &&
    readerAbortController === request.controller && !request.controller.signal.aborted &&
    targetBook === book && targetRendition === rendition
  );
}

function isAbortError(error) {
  return error && (error.name === 'AbortError' || error.message === 'The user aborted a request.');
}

async function recoverFromReaderFailure(request, message, targetBook = null, targetRendition = null){
  const current = isReaderRequestCurrent(request, targetBook, targetRendition);
  if (!current) return;
  await showShelf();
  if (isActiveAccount(request.accountVersion)) showToast(message);
}

function bindRenditionInteractions(entry, targetRendition, request) {
  if (!targetRendition) return;
  const active = () => isReaderRequestCurrent(request, book, targetRendition);
  targetRendition.on('selected', (cfi, contents) => { if (active()) onTextSelected(entry, cfi, contents); });
  targetRendition.on('selected', (cfiRange, contents) => {
    if (!active()) return;
    targetRendition.book.getRange(cfiRange).then((range) => {
      const text = range.toString().trim();
      if (text && !text.includes(' ')) {
        const rect = contents.window.getSelection().getRangeAt(0).getBoundingClientRect();
        lookupDictionary(text, rect.left + 50, rect.bottom + 50);
      } else {
        const tooltip = document.getElementById('dict-tooltip');
        if (tooltip) tooltip.classList.add('hidden');
      }
    });
  });
  targetRendition.on('markClicked', (cfi) => { if (active()) onHighlightClicked(entry, cfi); });
  targetRendition.on('mousedown', () => { if (active()) hideHighlightPopup(); });
  targetRendition.on('touchstart', () => { if (active()) hideHighlightPopup(); });
}

function getLocationsKey(bookId) {
  return `endpaper_locations_${bookId}`;
}

// NOTE (R-20): ensureLocations() was removed — it was dead code never called anywhere.
// The live location cache/generate pipeline lives in openBook() below.

/* ---------------- Opening a book ---------------- */
async function openBook(id){
  const entry = library.find(b => b.id === id);
  lastReaderInteractionAt = Date.now();
  if (!entry || !currentUser) return;
  if (currentBookId === id && rendition) return;
  if (currentBookId && (book || rendition || currentSessionId)) {
    await showShelf();
    if (!currentUser) return;
  }

  const request = createReaderRequest(id);
  const requestOptions = readerRequestOptions(request);
  currentBookId = id;
  const initialPct = (entry.progress != null && Number.isFinite(entry.progress))
    ? Math.max(0, Math.min(100, entry.progress))
    : 0;
  const initPctEl = document.getElementById('progress-pct');
  const initSliderEl = document.getElementById('progress-slider');
  if (initPctEl) initPctEl.textContent = initialPct + '%';
  if (initSliderEl) {
    initSliderEl.value = initialPct;
    initSliderEl.style.setProperty('--progress', initialPct + '%');
  }
  entry.lastOpenedAt = Date.now();
  document.getElementById('app').classList.remove('chrome-hidden');
  document.body.classList.add('reader-active');
  syncReaderPalette();
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();

  document.getElementById('shelf-view').style.display = 'none';
  document.getElementById('reader-view').classList.add('active');
  document.getElementById('toc-toggle').style.display = 'flex';
  document.getElementById('search-toggle').style.display = 'flex';
  document.getElementById('settings-toggle').style.display = 'flex';
  document.getElementById('bookmarks-toggle').style.display = 'flex';
  document.getElementById('bookmark-toggle').style.display = 'flex';
  if (document.getElementById('tts-btn')) document.getElementById('tts-btn').style.display = 'flex';
  if (document.getElementById('fullscreen-btn')) document.getElementById('fullscreen-btn').style.display = 'flex';
  if (document.getElementById('reader-more-btn')) document.getElementById('reader-more-btn').style.display = 'flex';
  document.getElementById('upload-btn').style.display = 'none';

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SET_CURRENT_BOOK', bookId: id });
  }
  window.currentBookData = entry;

  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('loading-text').textContent = 'Opening book…';
  document.getElementById('viewer').innerHTML = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-status').textContent = '';
  document.getElementById('search-results').innerHTML = '';

  // Fetch the EPUB file from the server
  let targetBook;
  try {
    const blob = await api.getBookFile(id, requestOptions);
    if (!isReaderRequestCurrent(request, null, null)) return;
    // R-16: Use a Blob URL — avoids .slice() copy, data lives outside the GC heap.
    // Revoke the previous URL first so the browser can release any prior backing store.
    if (currentBlobUrl) { try { URL.revokeObjectURL(currentBlobUrl); } catch (_) {} }
    currentBlobUrl = URL.createObjectURL(blob);
    targetBook = ePub(currentBlobUrl);
  } catch(err) {
    if (isReaderRequestCurrent(request, null, null) && !isAbortError(err)) {
      console.error('Failed to load book file:', err);
      await recoverFromReaderFailure(request, 'This book could not be opened. Please try again.', null, null);
    }
    return;
  }

  if (!isReaderRequestCurrent(request, null, null)) {
    try { targetBook.destroy(); } catch (e) {}
    return;
  }
  book = targetBook;

  try {
    rendition = book.renderTo('viewer', renditionOptions());
  } catch (err) {
    if (!isAbortError(err)) console.error('Failed to prepare EPUB reader:', err);
    await recoverFromReaderFailure(request, 'This EPUB could not be prepared. Please try again.', targetBook, null);
    return;
  }
  const targetRendition = rendition;
  document.getElementById('reader-view').classList.toggle('scrolled', settings.layout === 'scrolled');

  registerThemes();
  registerSwipeGestures();
  applyTheme();
  bindRenditionInteractions(entry, targetRendition, request);
  bindRelocated(entry, targetRendition, targetBook, request);

  // Load bookmarks and highlights from server
  entry.annotationLoadFailed = false;
  try {
    const [bookmarks, highlights] = await Promise.all([
      api.getBookmarks(id, requestOptions),
      api.getHighlights(id, requestOptions),
    ]);
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    entry.annotationLoadFailed = false;
    entry.bookmarks = bookmarks.map(bm => ({
      id: bm.id,
      cfi: bm.cfi,
      chapter: bm.chapter || bm.label || 'Untitled section',
      pct: bm.progress_percent || 0,
      addedAt: bm.created_at ? new Date(bm.created_at).getTime() : Date.now(),
    }));
    entry.highlights = highlights.map(hl => ({
      id: hl.id,
      cfi: hl.cfi_range,
      color: hl.color || 'gold',
      excerpt: hl.excerpt || '',
      chapter: hl.chapter || 'Untitled section',
      addedAt: hl.created_at ? new Date(hl.created_at).getTime() : Date.now(),
    }));
    window.currentHighlights = entry.highlights;
  } catch(e) {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) {
      console.error('Failed to load bookmarks/highlights:', e);
      entry.annotationLoadFailed = true;
    }
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  }

  targetRendition.display(entry.lastLocationCfi || undefined).then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    overlay.classList.add('hidden');
    // R-13: Show chrome briefly then auto-hide (Kindle-like UX)
    showReaderChromeTemporarily();
    tuneScrollContainer(targetRendition);
    updateBookmarkIcon();
    applySavedHighlights(entry, targetRendition);
  }).catch(err => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(err)) {
      console.error('Failed to render book:', err);
      recoverFromReaderFailure(request, 'This EPUB could not be displayed. Please try again.', targetBook, targetRendition);
    }
  });

  renderBookmarks();
  renderBookmarkTicks();
  renderHighlights();

  targetBook.loaded.navigation.then(nav => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition)) renderToc(nav.toc);
  }).catch(() => {});

  // Only admins may change shared book metadata.
  if (isCurrentUserAdmin()) targetBook.loaded.metadata.then(meta => {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && meta && meta.title && meta.title.trim() && meta.title.trim() !== entry.name){
      entry.name = meta.title.trim();
      api.updateBook(id, { title: entry.name }, requestOptions).catch(() => {});
      renderShelf();
    }
  }).catch(() => {});

  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

  // Generate locations in background for accurate % and progress bar
  targetBook.ready.then(() => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    const cachedLocations = epubLocationCache.get(readerAssetCacheKey(id));
    if (cachedLocations) {
      targetBook.locations.load(cachedLocations);
      locationsReady = true;
      syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request);
      return;
    }

    const scheduleLocations = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => setTimeout(cb, 100);

    const generateWhenQuiet = () => scheduleLocations(async () => {
      if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
      if (Date.now() - lastReaderInteractionAt < 2500) {
        generateWhenQuiet();
        return;
      }
      try {
        await targetBook.locations.generate(1024);
        if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
        locationsReady = true;
        try {
          epubLocationCache.set(readerAssetCacheKey(id), targetBook.locations.save());
        } catch (_) {}
        syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request);
      } catch(e) {
        if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) console.debug('Location generation skipped:', e);
      }
    });
  });

  // Start reading session for analytics
  try {
    const session = await api.startSession(id, requestOptions);
    if (!isReaderRequestCurrent(request, targetBook, targetRendition)) {
      if (session && session.id) {
        api.endSession(session.id, { expectedAccountVersion: request.accountVersion }).catch(() => {});
      }
      return;
    }
    if (session && session.id && isReaderRequestCurrent(request, targetBook, targetRendition)) {
      currentSessionId = session.id;
    } else if (session && session.id) {
      api.endSession(session.id, requestOptions).catch(() => {});
    }
  } catch(e) {
    if (isReaderRequestCurrent(request, targetBook, targetRendition) && !isAbortError(e)) console.error('Failed to start reading session:', e);
  }

  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  isDraggingProgressSlider = false;
  seekLockUntil = 0;

  const sliderEl = document.getElementById('progress-slider');
  if (sliderEl) {
    const startSliderDrag = () => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 5000;
    };

    sliderEl.onpointerdown = startSliderDrag;
    sliderEl.onmousedown = startSliderDrag;
    sliderEl.ontouchstart = startSliderDrag;

    sliderEl.oninput = (e) => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 5000;
      const dragPct = Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
      const pctEl = document.getElementById('progress-pct');
      if (pctEl) pctEl.textContent = dragPct + '%';
      sliderEl.style.setProperty('--progress', dragPct + '%');
    };

    sliderEl.onchange = (e) => {
      isDraggingProgressSlider = true;
      seekLockUntil = Date.now() + 2000;
      const dragPct = Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
      sliderEl.value = dragPct;
      sliderEl.style.setProperty('--progress', dragPct + '%');
      const pctEl = document.getElementById('progress-pct');
      if (pctEl) pctEl.textContent = dragPct + '%';
      entry.progress = dragPct;
      scheduleSaveMeta(entry, request);

      const targetFraction = dragPct / 100;
      if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

      const unlockSeek = () => {
        setTimeout(() => {
          isDraggingProgressSlider = false;
          seekLockUntil = 0;
        }, 200);
      };

      let displayPromise = null;
      if (locationsReady && targetBook.locations && targetBook.locations.total > 0) {
        try {
          const cfi = targetBook.locations.cfiFromPercentage(targetFraction);
          if (cfi) {
            displayPromise = targetRendition.display(cfi);
          }
        } catch (_) {}
      }

      if (!displayPromise && targetBook.spine) {
        const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
        const totalSpine = Math.max(1, spineItems.length || targetBook.spine.length || 1);
        const targetIndex = Math.min(totalSpine - 1, Math.max(0, Math.floor(targetFraction * totalSpine)));
        const item = targetBook.spine.get(targetIndex) || spineItems[targetIndex];
        if (item && (item.cfiBase || item.href)) {
          displayPromise = targetRendition.display(item.cfiBase || item.href);
        }
      }

      if (displayPromise && typeof displayPromise.then === 'function') {
        displayPromise.then(unlockSeek).catch(unlockSeek);
      } else {
        unlockSeek();
      }
    };
  }

  window.onkeydown = handleReaderShortcut;
}

let readerLocationRafId = null;
let titleUpdateTimer = null;

function scheduleDocumentTitleUpdate(titleText) {
  if (document.title === titleText) return;
  clearTimeout(titleUpdateTimer);
  titleUpdateTimer = setTimeout(() => {
    if (document.title !== titleText) document.title = titleText;
  }, 400);
}

function getSpineSection(targetBook, location, cfi) {
  if (!targetBook || !targetBook.spine) return null;
  const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
  const totalItems = spineItems.length;

  // 1. Try EPUB.js built-in spine.get(cfi)
  if (cfi) {
    try {
      const sec = targetBook.spine.get(cfi);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}

    // Fallback: Parse standard EPUB CFI spine component /6/(\d+)
    const match = String(cfi).match(/\/6\/(\d+)/);
    if (match && totalItems > 0) {
      const spinePos = (parseInt(match[1], 10) / 2) - 1;
      if (spinePos >= 0 && spinePos < totalItems && spineItems[spinePos]) {
        return spineItems[spinePos];
      }
    }
  }

  // 2. Try location.start href with multi-strategy path normalization
  if (location && location.start && location.start.href) {
    const rawHref = location.start.href;
    try {
      const sec = targetBook.spine.get(rawHref);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}

    const cleanHref = rawHref.split('#')[0].split('?')[0];
    const filename = cleanHref.split('/').pop();

    if (totalItems > 0) {
      // Path-based match (safe against basename collisions)
      const matched = spineItems.find(item => {
        if (!item || !item.href) return false;
        const itemClean = item.href.split('#')[0].split('?')[0];
        return itemClean === cleanHref ||
               itemClean.endsWith('/' + cleanHref) ||
               cleanHref.endsWith('/' + itemClean);
      });
      if (matched && typeof matched.index === 'number') return matched;

      // Basename fallback: only safe when the filename is unique across the spine (R-23)
      const basenameMatches = spineItems.filter(item =>
        item && item.href && item.href.split('#')[0].split('?')[0].split('/').pop() === filename
      );
      if (basenameMatches.length === 1 && typeof basenameMatches[0].index === 'number') {
        return basenameMatches[0];
      }
    }
  }

  // 3. Try location.start.cfi
  if (location && location.start && location.start.cfi && location.start.cfi !== cfi) {
    try {
      const sec = targetBook.spine.get(location.start.cfi);
      if (sec && typeof sec.index === 'number' && sec.index >= 0) return sec;
    } catch (_) {}
    const match = String(location.start.cfi).match(/\/6\/(\d+)/);
    if (match && totalItems > 0) {
      const spinePos = (parseInt(match[1], 10) / 2) - 1;
      if (spinePos >= 0 && spinePos < totalItems && spineItems[spinePos]) {
        return spineItems[spinePos];
      }
    }
  }

  // 4. Try location.start.index
  if (location && location.start && location.start.index != null && Number.isInteger(location.start.index)) {
    const idx = location.start.index;
    if (idx >= 0 && idx < totalItems && spineItems[idx]) {
      return spineItems[idx];
    }
  }

  return null;
}

function bindRelocated(entry, targetRendition = rendition, targetBook = book, request = activeReaderRequest){
  if (!targetRendition) return;
  targetRendition.on('relocated', (location) => {
    if (!isReaderRequestCurrent(request, targetBook, targetRendition) || !location || !location.start) return;
    updateReaderLocation(entry, location, targetBook, targetRendition, request);
  });
}

function updateReaderLocation(entry, location, targetBook, targetRendition, request) {
    if (!location || !location.start || !isReaderRequestCurrent(request, targetBook, targetRendition)) return;
    const cfi = location.start.cfi;
    entry.lastLocationCfi = cfi;

    let pct = (entry.progress != null && Number.isFinite(entry.progress)) ? entry.progress : null;
    let calculatedPct = null;

    // 1. If locations are generated, use accurate location percentage
    if (locationsReady && targetBook && targetBook.locations && targetBook.locations.total > 0 && cfi) {
      try {
        const percentage = targetBook.locations.percentageFromCfi(cfi);
        if (typeof percentage === 'number' && Number.isFinite(percentage) && percentage >= 0 && percentage <= 1) {
          calculatedPct = Math.round(percentage * 100);
        }
      } catch (err) {
        console.debug('[Reader] percentageFromCfi failed:', err);
      }
    }

    // 2. Spine-based global progress calculation (accurate across all chapters even if locations.generate hasn't completed)
    if (calculatedPct === null && targetBook && targetBook.spine) {
      const spineItems = targetBook.spine.spineItems || (Array.isArray(targetBook.spine.items) ? targetBook.spine.items : []);
      const totalSections = Math.max(1, spineItems.length || targetBook.spine.length || 1);
      const section = getSpineSection(targetBook, location, cfi);

      if (section && typeof section.index === 'number' && section.index >= 0) {
        let intraFraction = 0;
        if (location.start.percentage != null && Number.isFinite(location.start.percentage) && location.start.percentage >= 0 && location.start.percentage <= 1) {
          intraFraction = location.start.percentage;
        } else if (location.start.displayed && location.start.displayed.total > 0) {
          const curPage = location.start.displayed.page || 1;
          intraFraction = Math.max(0, (curPage - 1) / location.start.displayed.total);
        }
        calculatedPct = Math.round(((section.index + intraFraction) / totalSections) * 100);
      } else {
        console.debug('[Reader] getSpineSection could not resolve section for location:', location.start);
      }
    }

    // 3. Fallback: Navigation TOC position
    if (calculatedPct === null && targetBook && targetBook.navigation && Array.isArray(targetBook.navigation.toc) && targetBook.navigation.toc.length > 0) {
      const toc = targetBook.navigation.toc;
      const href = location.start.href ? location.start.href.split('#')[0].split('?')[0] : '';
      const filename = href.split('/').pop();
      const tocIdx = toc.findIndex(t => {
        if (!t || !t.href) return false;
        const cleanT = t.href.split('#')[0].split('?')[0];
        return cleanT === href || cleanT.endsWith('/' + href) || href.endsWith('/' + cleanT) || cleanT.split('/').pop() === filename;
      });
      if (tocIdx >= 0) {
        // Use tocIdx / (length-1) so that the last entry only reaches 100% when
        // you are actually at its end, preventing premature "finished" marking (R-21)
        calculatedPct = Math.round((tocIdx / Math.max(1, toc.length - 1)) * 100);
      }
    }

    const isSeekingLocked = isDraggingProgressSlider || Date.now() < seekLockUntil;

    if (calculatedPct !== null && !isSeekingLocked) {
      pct = Math.max(0, Math.min(100, calculatedPct));
      entry.progress = pct;
    }

    // Auto-update status
    if (pct != null && pct >= 98 && entry.status !== 'finished') { // R-22: 95→98
      entry.status = 'finished';
    } else if (pct != null && pct > 0 && entry.status === 'unread') {
      entry.status = 'reading';
    }

    const chapter = targetBook.navigation && targetBook.navigation.get(location.start.href);
    const chapterLabel = chapter ? chapter.label.trim() : '';

    // Schedule lightweight, non-blocking DOM updates in requestAnimationFrame
    if (!readerLocationRafId) {
      readerLocationRafId = requestAnimationFrame(() => {
        readerLocationRafId = null;
        if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;

        const isLockedNow = isDraggingProgressSlider || Date.now() < seekLockUntil;
        const pctEl = document.getElementById('progress-pct');
        const sliderEl = document.getElementById('progress-slider');
        const chapterEl = document.getElementById('progress-chapter');

        const displayPct = pct != null ? pct : null;
        const pctText = displayPct != null ? displayPct + '%' : '—%';
        if (pctEl && !isLockedNow && pctEl.textContent !== pctText) {
          pctEl.textContent = pctText;
        }
        if (sliderEl && !isLockedNow) {
          const sliderVal = displayPct != null ? displayPct : 0;
          if (Number(sliderEl.value) !== sliderVal) sliderEl.value = sliderVal;
          sliderEl.style.setProperty('--progress', (displayPct != null ? displayPct : 0) + '%');
        }

        if (chapterEl && chapterEl.textContent !== chapterLabel) {
          chapterEl.textContent = chapterLabel;
        }

        updateBookmarkIcon(cfi);
      });
    }

    if (!isSeekingLocked) {
      scheduleDocumentTitleUpdate(`${entry.name} — ${pct != null ? pct + '%' : '—%'} | Endpaper`);
      scheduleSaveMeta(entry, request);
    }
}

async function syncProgressFromCurrentLocation(entry, targetBook, targetRendition, request) {
  if (!isReaderRequestCurrent(request, targetBook, targetRendition)) return;
  const location = await getCurrentLocationSafe(targetRendition);
  if (location && isReaderRequestCurrent(request, targetBook, targetRendition)) updateReaderLocation(entry, location, targetBook, targetRendition, request);
}

/* ---------------- Bookmarks ---------------- */
function getCurrentEntry(){
  return library.find(b => b.id === currentBookId);
}

function createReaderMutationContext(entry = getCurrentEntry()){
  const request = activeReaderRequest;
  const targetBook = book;
  const targetRendition = rendition;
  if (!entry || !isReaderRequestCurrent(request, targetBook, targetRendition)) return null;
  return {
    entry,
    request,
    targetBook,
    targetRendition,
    requestOptions: readerRequestOptions(request),
  };
}

function isReaderMutationCurrent(context){
  return Boolean(
    context && getCurrentEntry() === context.entry &&
    isReaderRequestCurrent(context.request, context.targetBook, context.targetRendition)
  );
}

async function toggleBookmark(){
  const entry = getCurrentEntry();
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const { targetBook, targetRendition, requestOptions } = context;
  const loc = await getCurrentLocationSafe(targetRendition);
  if (!loc || !loc.start) return;
  const cfi = loc.start.cfi;

  const existingIdx = entry.bookmarks.findIndex(bm => bm.cfi === cfi);
  if (existingIdx > -1){
    const removed = entry.bookmarks.splice(existingIdx, 1)[0];
    if (removed.id) {
      api.removeBookmark(removed.id, requestOptions).catch(e => {
        if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Remove bookmark failed:', e);
      });
    }
  } else {
    const pending = entry.__pendingBookmarks || (entry.__pendingBookmarks = new Set());
    if (pending.has(cfi)) return;
    pending.add(cfi);
    const chapter = targetBook.navigation && targetBook.navigation.get(loc.start.href);
    let pct = 0;
    if (locationsReady) pct = Math.round(targetBook.locations.percentageFromCfi(cfi) * 100);
    else if (loc.start.percentage != null) pct = Math.round(loc.start.percentage * 100);

    const chapterLabel = chapter ? chapter.label.trim() : 'Untitled section';

    try {
      const saved = await resilientApiPost(`/api/books/${entry.id}/bookmarks`, {
        cfi,
        chapter: chapterLabel,
        label: chapterLabel,
        progress_percent: pct,
      }, false, 'POST', requestOptions);
      if (!isReaderMutationCurrent(context)) return;
      if (!entry.bookmarks.some(bookmark => bookmark.cfi === cfi)) {
        entry.annotationLoadFailed = false;
        entry.bookmarks.push({
          id: (saved && saved.id) || ('temp_' + Date.now()),
          cfi,
          chapter: chapterLabel,
          pct,
          addedAt: Date.now(),
        });
        entry.bookmarks.sort((a, b) => a.pct - b.pct);
      }
    } catch(e) {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Add bookmark failed:', e);
    } finally {
      pending.delete(cfi);
    }
  }
  if (!isReaderMutationCurrent(context)) return;
  updateBookmarkIcon();
  renderBookmarks();
  renderBookmarkTicks();
}

async function updateBookmarkIcon(knownCfi){
  const btn = document.getElementById('bookmark-toggle');
  const entry = getCurrentEntry();
  if (!entry || !rendition){ if (btn) btn.classList.remove('active'); return; }
  const cfi = knownCfi !== undefined ? knownCfi : ((await getCurrentLocationSafe(rendition))?.start?.cfi || null);
  const bookmarked = !!cfi && entry.bookmarks.some(bm => bm.cfi === cfi);
  if (btn && btn.classList.contains('active') !== bookmarked) {
    btn.classList.toggle('active', bookmarked);
    btn.title = bookmarked ? 'Remove bookmark' : 'Bookmark this page';
  }
}

function renderBookmarks(){
  const entry = getCurrentEntry();
  const list = document.getElementById('bookmarks-list');
  list.innerHTML = '';
  if (entry && entry.annotationLoadFailed && (!entry.bookmarks || entry.bookmarks.length === 0)) {
    list.innerHTML = '<div class="bookmark-empty" style="color:#C14B4B;">Could not load bookmarks. Please try reopening the book.</div>';
    return;
  }
  if (!entry || entry.bookmarks.length === 0){
    list.innerHTML = '<div class="bookmark-empty">No bookmarks yet — tap the ribbon icon in the top bar while reading to save your place.</div>';
    return;
  }
  entry.bookmarks.forEach(bm => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <div class="bookmark-chapter">${escapeHtml(bm.chapter)}</div>
      <div class="bookmark-meta">
        <span class="bookmark-pct">${bm.pct}% through the book</span>
        <button class="bookmark-remove">Remove</button>
      </div>
    `;
    item.querySelector('.bookmark-chapter').onclick =
      item.querySelector('.bookmark-pct').onclick = () => {
        if (getCurrentEntry() !== entry || !rendition) return;
        rendition.display(bm.cfi);
        toggleDrawer('bookmarks', true);
      };
    item.querySelector('.bookmark-remove').onclick = (e) => {
      e.stopPropagation();
      const context = createReaderMutationContext(entry);
      if (!context) return;
      entry.bookmarks = entry.bookmarks.filter(b => b.cfi !== bm.cfi);
      if (bm.id) {
        api.removeBookmark(bm.id, context.requestOptions).catch(err => {
          if (isReaderMutationCurrent(context) && !isAbortError(err)) console.error('Remove bookmark failed:', err);
        });
      }
      if (!isReaderMutationCurrent(context)) return;
      renderBookmarks();
      renderBookmarkTicks();
      updateBookmarkIcon();
    };
    list.appendChild(item);
  });
}

function renderBookmarkTicks(){
  const entry = getCurrentEntry();
  const wrap = document.getElementById('bookmark-ticks');
  wrap.innerHTML = '';
  if (!entry) return;
  entry.bookmarks.forEach(bm => {
    const dot = document.createElement('div');
    dot.className = 'bookmark-tick';
    dot.style.left = bm.pct + '%';
    dot.title = bm.chapter + ' — ' + bm.pct + '%';
    dot.onclick = () => rendition && rendition.display(bm.cfi);
    wrap.appendChild(dot);
  });
}

function setMarksTab(paneId){
  document.querySelectorAll('.marks-tab').forEach(t => {
    const selected = t.dataset.tab === paneId;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.marks-pane').forEach(p => {
    const selected = p.id === paneId;
    p.classList.toggle('active', selected);
    p.hidden = !selected;
  });
}

function moveRadioOption(event, selector){
  const option = event.target && event.target.closest && event.target.closest(selector);
  if (!option || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
  const options = Array.from(option.closest('[role="radiogroup"]').querySelectorAll(selector));
  const currentIndex = options.indexOf(option);
  if (currentIndex < 0 || options.length === 0) return false;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = options.length - 1;
  event.preventDefault();
  options[nextIndex].focus();
  options[nextIndex].click();
  return true;
}

function handleReaderSettingsKeydown(event){
  if (moveRadioOption(event, '.layout-option')) return;
  if (moveRadioOption(event, '.theme-swatch')) return;
  if (moveRadioOption(event, '.font-option')) return;
  const tab = event.target && event.target.closest && event.target.closest('.marks-tab');
  if (!tab || !['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(tab.closest('[role="tablist"]').querySelectorAll('.marks-tab'));
  const index = tabs.indexOf(tab);
  let nextIndex = index;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}
document.addEventListener('keydown', handleReaderSettingsKeydown);

/* ---------------- Highlights ---------------- */
let pendingHighlightCfi = null;
let pendingHighlightContext = null;
let highlightReturnFocus = null;

function onTextSelected(entry, cfi, contents){
  if (!contents) return;
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const win = contents.window || (contents.document && contents.document.defaultView);
  if (!win) return;
  const sel = win.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text) return;
  context.cfi = cfi;
  context.excerpt = text.length > 140 ? text.slice(0, 140) + '…' : text;
  context.returnFocus = contents.document.defaultView && contents.document.defaultView.frameElement;
  pendingHighlightContext = context;
  highlightReturnFocus = context.returnFocus;
  pendingHighlightCfi = cfi;

  try {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const iframe = contents.document.defaultView.frameElement;
    const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
    showHighlightPopup(iframeRect.left + rect.left + rect.width / 2, iframeRect.top + rect.top, false);
  } catch(e){ showHighlightPopup(window.innerWidth / 2, 90, false); }
}

function onHighlightClicked(entry, cfi){
  const context = createReaderMutationContext(entry);
  if (!context) return;
  const hl = entry.highlights.find(h => h.cfi === cfi);
  if (!hl) return;
  context.cfi = cfi;
  context.excerpt = hl.excerpt || '';
  context.returnFocus = document.querySelector('#viewer iframe');
  pendingHighlightContext = context;
  highlightReturnFocus = context.returnFocus;
  pendingHighlightCfi = cfi;
  showHighlightPopup(window.innerWidth / 2, 90, true);
}

function showHighlightPopup(x, y, isExisting){
  const popup = document.getElementById('highlight-popup');
  popup.style.left = Math.max(60, Math.min(window.innerWidth - 60, x)) + 'px';
  popup.style.top = Math.max(70, y - 46) + 'px';
  popup.style.transform = 'translateX(-50%)';
  document.getElementById('highlight-remove-btn').style.display = isExisting ? 'inline' : 'none';
  popup.setAttribute('aria-hidden', 'false');
  popup.classList.add('show');
  const context = pendingHighlightContext;
  requestAnimationFrame(() => {
    if (popup.classList.contains('show') && pendingHighlightContext === context) {
      const target = popup.querySelector('.swatch-btn');
      if (target) target.focus({ preventScroll: true });
    }
  });
}
function hideHighlightPopup({ returnFocus = false } = {}){
  const popup = document.getElementById('highlight-popup');
  const focusTarget = highlightReturnFocus;
  popup.classList.remove('show');
  popup.setAttribute('aria-hidden', 'true');
  pendingHighlightCfi = null;
  pendingHighlightContext = null;
  highlightReturnFocus = null;
  if (returnFocus && focusTarget && focusTarget.isConnected) {
    setTimeout(() => {
      try { focusTarget.focus({ preventScroll: true }); } catch (e) {}
    }, 0);
  }
}

function finishPendingHighlight(context, returnFocus = true){
  if (pendingHighlightContext === context) hideHighlightPopup({ returnFocus });
}

function highlightStyle(color){
  const isDarkPage = settings.theme === 'dark' || settings.theme === 'night';
  return {
    fill: color,
    'fill-opacity': isDarkPage ? '0.62' : '0.4',
    // Multiply makes coloured SVG highlights almost disappear on black pages.
    'mix-blend-mode': isDarkPage ? 'screen' : 'multiply',
  };
}

function refreshHighlightStyles(){
  const entry = getCurrentEntry();
  if (!entry || !rendition || !entry.highlights) return;
  entry.highlights.forEach(highlight => {
    try { rendition.annotations.remove(highlight.cfi, 'highlight'); } catch (e) {}
    try {
      rendition.annotations.add('highlight', highlight.cfi, {}, null, 'epub-highlight', highlightStyle(highlight.color));
    } catch (e) {}
  });
}

async function applyHighlight(color){
  const context = pendingHighlightContext;
  if (!context || !pendingHighlightCfi || !isReaderMutationCurrent(context)) { hideHighlightPopup(); return; }
  if (context.saving) return;
  context.saving = true;
  const { entry, targetBook, targetRendition, requestOptions } = context;
  const cfi = context.cfi;
  const existing = entry.highlights.find(h => h.cfi === cfi);
  if (existing){
    try { targetRendition.annotations.remove(existing.cfi, 'highlight'); } catch(e){}
    existing.color = color;
    if (existing.id) {
      api.updateHighlight(existing.id, { color }, requestOptions).catch(e => {
        if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Update highlight failed:', e);
      });
    }
  } else {
    const location = await getCurrentLocationSafe(targetRendition);
    const chapter = targetBook.navigation && location && location.start && targetBook.navigation.get(location.start.href);
    const chapterLabel = chapter ? chapter.label.trim() : 'Untitled section';
    const excerpt = context.excerpt || '';

    try {
      const saved = await resilientApiPost(`/api/books/${entry.id}/highlights`, {
        cfi_range: cfi,
        color,
        excerpt,
        chapter: chapterLabel,
      }, false, 'POST', requestOptions);
      if (!isReaderMutationCurrent(context)) return;
      entry.annotationLoadFailed = false;
      entry.highlights.push({
        id: (saved && saved.id) || ('temp_' + Date.now()),
        cfi,
        color,
        excerpt,
        chapter: chapterLabel,
        addedAt: Date.now(),
      });
    } catch(e) {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Add highlight failed:', e);
      finishPendingHighlight(context);
      return;
    } finally {
      context.saving = false;
    }
  }
  context.saving = false;
  if (!isReaderMutationCurrent(context)) return;
  targetRendition.annotations.add('highlight', cfi, {}, null, 'epub-highlight', highlightStyle(color));
  try {
    targetRendition.getContents().forEach(c => {
      const win = c.window || (c.document && c.document.defaultView);
      if (win) win.getSelection().removeAllRanges();
    });
  } catch(e){}
  finishPendingHighlight(context);
  renderHighlights();
}

async function removeCurrentHighlight(){
  const context = pendingHighlightContext;
  if (!context || !pendingHighlightCfi || !isReaderMutationCurrent(context)) { hideHighlightPopup(); return; }
  const { entry, targetRendition, requestOptions } = context;
  const cfi = context.cfi;
  try { targetRendition.annotations.remove(cfi, 'highlight'); } catch(e){}
  const removed = entry.highlights.find(h => h.cfi === cfi);
  entry.highlights = entry.highlights.filter(h => h.cfi !== cfi);
  if (removed && removed.id) {
    api.removeHighlight(removed.id, requestOptions).catch(e => {
      if (isReaderMutationCurrent(context) && !isAbortError(e)) console.error('Remove highlight failed:', e);
    });
  }
  if (!isReaderMutationCurrent(context)) return;
  finishPendingHighlight(context);
  renderHighlights();
}

function applySavedHighlights(entry, targetRendition = rendition){
  if (!targetRendition || !entry.highlights) return;
  entry.highlights.forEach(h => {
    try {
      targetRendition.annotations.add('highlight', h.cfi, {}, null, 'epub-highlight', highlightStyle(h.color));
    } catch(e){}
  });
}

function renderHighlights(){
  const entry = getCurrentEntry();
  const list = document.getElementById('highlights-list');
  list.innerHTML = '';
  if (entry && entry.annotationLoadFailed && (!entry.highlights || entry.highlights.length === 0)) {
    list.innerHTML = '<div class="bookmark-empty" style="color:#C14B4B;">Could not load highlights. Please try reopening the book.</div>';
    return;
  }
  if (!entry || entry.highlights.length === 0){
    list.innerHTML = '<div class="bookmark-empty">No highlights yet — select any text while reading to mark it.</div>';
    return;
  }
  entry.highlights.forEach(h => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.innerHTML = `
      <div class="highlight-excerpt"><span class="highlight-swatch" style="background:${h.color}"></span>"${escapeHtml(h.excerpt)}"</div>
    `;
    item.onclick = () => { rendition.display(h.cfi); toggleDrawer('bookmarks', true); };
    list.appendChild(item);
  });
}

/* ---------------- Search ---------------- */
let searchDebounce = null;
let searchRequestVersion = 0;
const bookSearchIndex = new Map();
const bookTextIndex = new Map();

async function getBookTextIndex(targetBook, bookId, isCurrentSearch) {
  if (bookTextIndex.has(bookId)) return bookTextIndex.get(bookId);
  const pending = (async () => {
    const sections = [];
    if (targetBook.spine && typeof targetBook.spine.each === 'function') {
      targetBook.spine.each(section => sections.push(section));
    }
    const indexed = [];
    for (const section of sections) {
      if (!isCurrentSearch()) return null;
      try {
        const documentNode = await section.load(targetBook.load.bind(targetBook));
        if (!isCurrentSearch()) return null;
        const textContent = documentNode?.documentElement?.textContent || documentNode?.body?.textContent || '';
        indexed.push({ section, text: textContent.normalize('NFKC').toLocaleLowerCase() });
      } catch (_) {
        indexed.push({ section, text: '' });
      } finally {
        if (typeof section.unload === 'function') section.unload();
      }
    }
    return indexed;
  })();
  bookTextIndex.set(bookId, pending);
  try {
    const indexed = await pending;
    if (!indexed) bookTextIndex.delete(bookId);
    while (bookTextIndex.size > 3) bookTextIndex.delete(bookTextIndex.keys().next().value);
    return indexed;
  } catch (error) {
    bookTextIndex.delete(bookId);
    throw error;
  }
}
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const requestVersion = ++searchRequestVersion;
  const q = e.target.value.trim();
  if (q.length < 3){
    document.getElementById('search-status').textContent = q.length ? 'Keep typing…' : '';
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q, requestVersion), 300);
});

async function runSearch(query, requestVersion = ++searchRequestVersion){
  const targetBook = book;
  const targetRendition = rendition;
  const isCurrentSearch = () => (
    requestVersion === searchRequestVersion &&
    targetBook === book &&
    targetRendition === rendition &&
    Boolean(currentBookId)
  );
  if (!targetBook || !isCurrentSearch()) return;
  document.getElementById('search-status').textContent = 'Searching…';
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '';
  let results = [];
  try {
    const cacheKey = `${currentBookId}:${query.toLocaleLowerCase()}`;
    const cached = bookSearchIndex.get(cacheKey);
    if (cached) {
      results = cached;
    } else {
      const indexedSections = await getBookTextIndex(targetBook, currentBookId, isCurrentSearch);
      if (!indexedSections || !isCurrentSearch()) return;
      const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase();
      const candidates = indexedSections.filter(item => item.text.includes(normalizedQuery));
      for (const { section } of candidates){
        try {
          await section.load(targetBook.load.bind(targetBook));
          if (!isCurrentSearch()) return;
          const matches = section.find(query) || [];
          matches.forEach(m => results.push({ cfi: m.cfi, excerpt: m.excerpt, href: section.href }));
        } catch(e){ /* skip unreadable section */ }
        finally { if (typeof section.unload === 'function') section.unload(); }
        if (results.length > 60) break;
      }
      bookSearchIndex.set(cacheKey, results.slice(0, 61));
      while (bookSearchIndex.size > 100) bookSearchIndex.delete(bookSearchIndex.keys().next().value);
    }
    if (!isCurrentSearch()) return;
    document.getElementById('search-status').textContent =
      results.length === 0 ? 'No matches found.' : results.length + ' match' + (results.length === 1 ? '' : 'es');
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    results.forEach(r => {
      const chapter = targetBook.navigation && targetBook.navigation.get(r.href);
      const item = document.createElement('div');
      item.className = 'search-result';
      item.innerHTML = `
        <div class="search-chapter">${chapter ? escapeHtml(chapter.label.trim()) : ''}</div>
        <div class="search-excerpt">${escapeHtml(r.excerpt).replace(re, '<mark>$1</mark>')}</div>
      `;
      item.onclick = () => {
        if (!isCurrentSearch()) return;
        rendition.display(r.cfi);
        toggleDrawer('search', true);
      };
      resultsEl.appendChild(item);
    });
  } catch (err) {
    if (!isCurrentSearch()) return;
    console.error('Search failed:', err);
    document.getElementById('search-status').textContent = 'Search failed — try a shorter query.';
  }
}

/* ---------------- Fullscreen & shortcuts modal ---------------- */
function toggleFullscreen(){
  const app = document.getElementById('app');
  if (!app) return;
  if (isImmersiveReading() || readerFullscreenElement()) {
    exitImmersiveReading();
  } else {
    enterImmersiveReading();
    requestReaderFullscreen();
  }
}

function isEditableShortcutTarget(target){
  const element = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement;
  return Boolean(element && (element.matches('input, textarea, select, [contenteditable="true"]') || element.closest('[contenteditable="true"]')));
}

function handleReaderShortcut(e){
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape'){
    e.preventDefault();
    closeDrawers();
    closeShortcutsModal();
    hideHighlightPopup({ returnFocus: true });
    document.getElementById('app').classList.remove('chrome-hidden');
    syncReaderChromeAccessibility();
    exitReaderFullscreen();
    updateFullscreenControlUI();
    scheduleReaderResize();
    return;
  }
  if (isEditableShortcutTarget(e.target)) return;
  // Preserve native text selection/caret movement in the EPUB document.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey) return;
  if (!rendition) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); turnPage('prev'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); turnPage('next'); }
  else if (e.key === ' '){ e.preventDefault(); if (!pageScroll(e.shiftKey ? -1 : 1)) turnPage(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleBookmark(); }
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleDrawer('toc'); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); toggleDrawer('settings'); }
  else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleDrawer('bookmarks'); }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); showShelf(); }
  else if (e.key === '/'){ e.preventDefault(); toggleDrawer('search'); document.getElementById('search-input').focus(); }
  else if (e.key === '?') { e.preventDefault(); openShortcutsModal(); }
}

function syncReaderFullscreenState(){
  const app = document.getElementById('app');
  if (!readerFullscreenElement() && document.body.classList.contains('reader-active')) {
    app.classList.remove('chrome-hidden');
  }
  syncReaderChromeAccessibility();
  updateFullscreenControlUI();
  scheduleReaderResize();
}
document.addEventListener('fullscreenchange', syncReaderFullscreenState);
document.addEventListener('webkitfullscreenchange', syncReaderFullscreenState);

function getShortcutsFocusableElements(){
  const modal = document.getElementById('shortcuts-modal');
  return Array.from(modal.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.getClientRects().length > 0);
}

function openShortcutsModal(){
  const modal = document.getElementById('shortcuts-modal');
  const active = document.activeElement;
  shortcutsModalReturnFocus = active instanceof HTMLElement ? active : document.getElementById('help-toggle');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const first = getShortcutsFocusableElements()[0];
    if (first) first.focus({ preventScroll: true });
  });
}

function closeShortcutsModal({ returnFocus = true } = {}){
  const modal = document.getElementById('shortcuts-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  const target = shortcutsModalReturnFocus;
  shortcutsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

function handleShortcutsModalKeydown(event){
  const modal = document.getElementById('shortcuts-modal');
  if (!modal.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeShortcutsModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = getShortcutsFocusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
document.addEventListener('keydown', handleShortcutsModalKeydown);
document.addEventListener('mousedown', (e) => {
  const popup = document.getElementById('highlight-popup');
  if (popup.classList.contains('show') && !popup.contains(e.target)) hideHighlightPopup();
});

function renderToc(toc){
  const list = document.getElementById('toc-list');
  list.innerHTML = '';
  function walk(items, depth){
    items.forEach(item => {
      const a = document.createElement('a');
      a.className = 'toc-item';
      a.style.paddingLeft = (4 + depth * 14) + 'px';
      a.textContent = item.label.trim();
      a.href = 'javascript:void(0)';
      a.onclick = () => { rendition.display(item.href); toggleDrawer('toc', true); };
      list.appendChild(a);
      if (item.subitems && item.subitems.length) walk(item.subitems, depth + 1);
    });
  }
  walk(toc, 0);
}

/* ---------------- Theming (reading pane) ---------------- */
function registerThemes(){
  Object.keys(THEMES).forEach(key => {
    const t = THEMES[key];
    rendition.themes.register(key, {
      'body': { 'background': t.body + ' !important', 'color': t.text + ' !important' },
      [EPUB_TEXT_SELECTORS]: { 'color': t.text + ' !important' },
      'a, a:link, a:visited': { 'color': t.link + ' !important' },
      '::selection': { 'background': 'rgba(169,128,63,0.35)' },
    });
  });
}

function syncReaderPalette(){
  const readerTheme = THEMES[settings.theme] || THEMES.light;
  const app = document.getElementById('app');
  if (app) app.style.setProperty('--reader-page-bg', readerTheme.body);
  const viewerWrap = document.getElementById('viewer-wrap');
  if (viewerWrap) viewerWrap.style.backgroundColor = readerTheme.body;
  const readerView = document.getElementById('reader-view');
  if (readerView) readerView.style.backgroundColor = readerTheme.body;

  const isReaderActive = document.body.classList.contains('reader-active');
  const shellColor = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#F6F1E7';
  const effectiveBg = isReaderActive ? readerTheme.body : shellColor;
  
  document.documentElement.style.backgroundColor = effectiveBg;
  document.body.style.backgroundColor = effectiveBg;

  // Track nav zone width so click zones never overlap rendered text
  const marginRaw = parseInt(MARGIN_PADDING[settings.marginIdx], 10) || 10;
  const isHover = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover)').matches;
  const effectiveMargin = isHover ? Math.max(marginRaw, 8) : marginRaw;
  const navZoneWidth = Math.min(15, effectiveMargin);
  document.documentElement.style.setProperty('--nav-zone-width', `${navZoneWidth}%`);

  // Match Safari/PWA browser chrome to the actual reading page so the safe
  // areas do not appear as contrasting grey bands.
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.content = effectiveBg;
  }
}

function applyTheme(){
  syncReaderPalette();
  if (!rendition) { updateSettingsUI(); saveSettings(); return; }
  rendition.themes.select(settings.theme);
  const fontCss = FONTS.find(f => f.name === settings.font).css;
  rendition.themes.font(fontCss);
  rendition.themes.fontSize(settings.fontSize + '%');
  let paddingVal = MARGIN_PADDING[settings.marginIdx];
  if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    paddingVal = `max(${paddingVal}, 44px, 8%)`;
  }
  const vPad = settings.layout === 'scrolled' ? '0' : '12px';
  rendition.themes.override('padding', `${vPad} ${paddingVal}`, true);
  rendition.themes.override('line-height', (settings.lineHeight / 100).toString(), true);
  rendition.themes.override('letter-spacing', SPACING_VALUES[settings.letterSpacingIdx], true);
  // Page appearance belongs inside the EPUB iframe; never tint the library shell.
  document.body.style.removeProperty('background');
  if (rendition && typeof rendition.views === 'function') {
    rendition.views().forEach(v => {
      if (v && v.contents) applyReaderContentStyles(v.contents);
    });
  }
  updateSettingsUI();
  saveSettings();
}

function updateSettingsUI(){
  document.querySelectorAll('.layout-option').forEach(el => {
    const selected = el.dataset.layout === settings.layout;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-checked', String(selected));
  });
  document.querySelectorAll('.theme-swatch').forEach(el => {
    const selected = el.dataset.theme === settings.theme;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-checked', String(selected));
  });
  document.getElementById('font-size-val').textContent = settings.fontSize + '%';
  document.getElementById('line-height-val').textContent = (settings.lineHeight/100).toFixed(1);
  document.getElementById('line-height-slider').value = settings.lineHeight;
  document.getElementById('line-height-slider').setAttribute('aria-valuetext', (settings.lineHeight / 100).toFixed(1) + ' line spacing');
  document.getElementById('margin-val').textContent = MARGIN_LABELS[settings.marginIdx];
  document.getElementById('margin-slider').value = settings.marginIdx;
  document.getElementById('margin-slider').setAttribute('aria-valuetext', MARGIN_LABELS[settings.marginIdx] + ' page width');
  document.getElementById('letter-spacing-val').textContent = SPACING_LABELS[settings.letterSpacingIdx];
  document.getElementById('letter-spacing-slider').value = settings.letterSpacingIdx;
  document.getElementById('letter-spacing-slider').setAttribute('aria-valuetext', SPACING_LABELS[settings.letterSpacingIdx] + ' letter spacing');
}

function setReadingTheme(name){
  if (!THEMES[name]) return;
  settings.theme = name;
  applyTheme();
  refreshHighlightStyles();
}
function stepFontSize(dir){
  settings.fontSize = Math.max(70, Math.min(220, settings.fontSize + dir * 10));
  applyTheme();
}
document.getElementById('line-height-slider').addEventListener('input', e => {
  settings.lineHeight = parseInt(e.target.value); applyTheme();
});
document.getElementById('margin-slider').addEventListener('input', e => {
  settings.marginIdx = parseInt(e.target.value); applyTheme();
});
document.getElementById('letter-spacing-slider').addEventListener('input', e => {
  settings.letterSpacingIdx = parseInt(e.target.value); applyTheme();
});

/* ---------------- Drawers ---------------- */
const DRAWER_IDS = ['toc', 'search', 'bookmarks', 'settings'];
let drawerReturnFocus = null;

function toggleDrawer(which, forceClose){
  const el = document.getElementById(which + '-drawer');
  const wasOpen = el.classList.contains('open');
  const willOpen = forceClose ? false : !wasOpen;

  DRAWER_IDS.forEach(id => {
    const d = document.getElementById(id + '-drawer');
    if (d) d.classList.remove('open');
  });

  if (willOpen) {
    const active = document.activeElement;
    drawerReturnFocus = active instanceof HTMLElement ? active : document.querySelector(`[data-drawer-toggle="${which}"]`);
    el.classList.add('open');
    requestAnimationFrame(() => {
      if (which === 'search') {
        const input = document.getElementById('search-input');
        if (input) input.focus();
      } else {
        const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length > 0) focusable[0].focus();
      }
    });
  } else {
    el.classList.remove('open');
    if (drawerReturnFocus && drawerReturnFocus.isConnected && !drawerReturnFocus.hidden) {
      drawerReturnFocus.focus({ preventScroll: true });
      drawerReturnFocus = null;
    }
  }
  updateDrawerBackdrop();
}
function closeDrawers({ returnFocus = true } = {}){
  DRAWER_IDS.forEach(id => document.getElementById(id + '-drawer').classList.remove('open'));
  updateDrawerBackdrop();
  if (returnFocus && drawerReturnFocus && drawerReturnFocus.isConnected && !drawerReturnFocus.hidden) {
    drawerReturnFocus.focus({ preventScroll: true });
  }
  drawerReturnFocus = null;
}
function updateDrawerBackdrop(){
  const anyOpen = DRAWER_IDS.some(id => document.getElementById(id + '-drawer').classList.contains('open'));
  document.getElementById('drawer-backdrop').classList.toggle('show', anyOpen);
  DRAWER_IDS.forEach(id => {
    const drawer = document.getElementById(id + '-drawer');
    const open = drawer.classList.contains('open');
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.toggleAttribute('inert', !open);
    document.querySelectorAll(`[data-drawer-toggle="${id}"]`).forEach(toggle => {
      toggle.setAttribute('aria-expanded', String(open));
    });
  });
}

/* ---------------- App shell (chrome) dark mode ---------------- */
function updateShellThemeControl(){
  const control = document.getElementById('shell-theme-toggle');
  if (!control) return;
  const dark = document.documentElement.classList.contains('dark-shell');
  control.setAttribute('aria-pressed', String(dark));
  control.setAttribute('aria-label', dark ? 'Use light app appearance' : 'Use dark app appearance');
  control.title = dark ? 'Use light app appearance' : 'Use dark app appearance';
  syncReaderPalette();
}

function toggleShellTheme(){
  document.documentElement.classList.toggle('dark-shell');
  const theme = document.documentElement.classList.contains('dark-shell') ? 'dark' : 'light';
  updateShellThemeControl();
  const expectedAccountVersion = accountVersion;
  api.saveSettings({ 'shell-theme': theme }, { expectedAccountVersion }).catch(e => console.error('Could not save shell theme', e));
}

/* ---------------- Persistence (API-backed) ---------------- */

const OFFLINE_QUEUE_PREFIX = 'endpaper_offline_queue:';
const OFFLINE_QUEUE_MAX_ITEMS = 200;
const OFFLINE_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const OFFLINE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function offlineQueueKey() {
  return currentUser && currentUser.username ? OFFLINE_QUEUE_PREFIX + encodeURIComponent(currentUser.username.toLocaleLowerCase()) : null;
}

function setSyncState(state, detail = '') {
  const element = document.getElementById('sync-status');
  if (!element) return;
  element.dataset.state = state;
  element.textContent = detail || ({ saved: 'Saved', saving: 'Saving…', syncing: 'Syncing…', offline: 'Offline', pending: 'Changes pending' }[state] || '');
  element.hidden = !element.textContent;
}

function loadOfflineQueue() {
  const key = offlineQueueKey();
  if (!key) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    const cutoff = Date.now() - OFFLINE_QUEUE_TTL_MS;
    return Array.isArray(parsed) ? parsed.filter(item => item && item.ts >= cutoff && item.account === currentUser.username) : [];
  } catch (_) { return []; }
}

function storeOfflineQueue(queue) {
  const key = offlineQueueKey();
  if (!key) return;
  let bounded = queue.slice(-OFFLINE_QUEUE_MAX_ITEMS);
  while (bounded.length && new Blob([JSON.stringify(bounded)]).size > OFFLINE_QUEUE_MAX_BYTES) bounded.shift();
  if (bounded.length) localStorage.setItem(key, JSON.stringify(bounded));
  else localStorage.removeItem(key);
  setSyncState(bounded.length ? (navigator.onLine ? 'pending' : 'offline') : 'saved', bounded.length ? `${bounded.length} change${bounded.length === 1 ? '' : 's'} pending` : 'Saved');
}

async function resilientApiPost(url, body, isProgressSave = false, method = 'POST', opts = {}) {
  const operationId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  setSyncState(navigator.onLine ? 'saving' : 'offline');
  try {
    const headers = new Headers(opts.headers || {});
    headers.set('Idempotency-Key', operationId);
    const res = await api.fetch(url, {
      ...opts,
      headers,
      method,
      body: JSON.stringify(body),
    });
    generateWhenQuiet();
    setSyncState('saved');
    return await res.json().catch(() => ({ ok: true }));
  } catch (networkErr) {
    if (isAbortError(networkErr) || (networkErr && networkErr.message === 'Session expired')) {
      throw networkErr;
    }
    // HTTP failures are permanent/application errors, not evidence of being
    // offline. Queue only a genuine fetch/network failure.
    if (networkErr && networkErr.status && !networkErr.isOffline) throw networkErr;
    const queue = loadOfflineQueue();
    const item = { url, body, method, ts: Date.now(), operationId, account: currentUser.username };
    const next = isProgressSave ? queue.filter(queued => queued.url !== url).concat(item) : queue.concat(item);
    storeOfflineQueue(next);
    return { queued: true };
  }
}

async function flushOfflineQueue() {
  try {
    const queue = loadOfflineQueue();
    if (!Array.isArray(queue) || !queue.length) return;

    setSyncState('syncing');
    const failed = [];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      try {
        await api.fetch(item.url, {
          method: item.method || 'POST',
          headers: { 'Idempotency-Key': item.operationId },
          body: JSON.stringify(item.body),
        });
      } catch (e) {
        if (e && e.message === 'Session expired') {
          failed.push(...queue.slice(index));
          break;
        }
        if (!e || !e.status || e.isOffline) failed.push(item);
        else console.error('Dropping permanently failed offline change', e);
      }
    }
    storeOfflineQueue(failed);
  } catch (_) {}
}

window.addEventListener('online', flushOfflineQueue);
window.addEventListener('offline', () => setSyncState('offline', loadOfflineQueue().length ? `${loadOfflineQueue().length} changes pending` : 'Offline'));

let metaSaveTimer = null;
let metaSaveAbortController = null;
function scheduleSaveMeta(entry, request = activeReaderRequest){
  clearTimeout(metaSaveTimer);
  const expectedAccountVersion = request ? request.accountVersion : accountVersion;
  metaSaveTimer = setTimeout(() => saveBookMeta(entry, { expectedAccountVersion, request }), 1200);
}

async function saveBookMeta(entry, { expectedAccountVersion = accountVersion, request = null, allowInactiveReader = false } = {}){
  if (!entry || !isActiveAccount(expectedAccountVersion)) return false;
  if (!allowInactiveReader && !isReaderRequestCurrent(request)) return false;
  if (metaSaveAbortController) metaSaveAbortController.abort();
  const controller = new AbortController();
  metaSaveAbortController = controller;
  try {
    await resilientApiPost(`/api/books/${entry.id}`, {
      progress_percent: entry.progress,
      last_location_cfi: entry.lastLocationCfi,
      last_opened_at: new Date().toISOString(),
    }, true, 'PATCH', { signal: controller.signal, expectedAccountVersion });
    return true;
  } catch(e){
    if (!isAbortError(e) && isActiveAccount(expectedAccountVersion)) console.error('Could not save book meta', e);
    return false;
  } finally {
    if (metaSaveAbortController === controller) metaSaveAbortController = null;
  }
}

let settingsSaveTimer = null;
let settingsSaveAbortController = null;
async function saveSettings(){
  clearTimeout(settingsSaveTimer);
  const expectedAccountVersion = accountVersion;
  const settingsSnapshot = { ...settings };
  settingsSaveTimer = setTimeout(async () => {
    if (!isActiveAccount(expectedAccountVersion)) return;
    if (settingsSaveAbortController) settingsSaveAbortController.abort();
    const controller = new AbortController();
    settingsSaveAbortController = controller;
    try {
      await api.saveSettings({
        'reader-settings': settingsSnapshot,
      }, { signal: controller.signal, expectedAccountVersion });
    } catch(e){
      if (!isAbortError(e) && isActiveAccount(expectedAccountVersion)) console.error('Could not save settings', e);
    } finally {
      if (settingsSaveAbortController === controller) settingsSaveAbortController = null;
    }
  }, 500);
}

async function loadLibraryFromStorage(expectedAccountVersion = accountVersion){
  if (!isActiveAccount(expectedAccountVersion)) return false;
  const data = await api.getBooks({ expectedAccountVersion });
  if (!isActiveAccount(expectedAccountVersion)) return false;
  const books = Array.isArray(data) ? data : (data.books || []);
  library = books.map(b => ({
    id: b.id,
    name: b.title,
    author: b.author,
    series: b.series || null,
    seriesIndex: b.series_index != null && b.series_index !== '' ? b.series_index : null,
    rating: b.rating != null ? Number(b.rating) : null,
    coverColor: b.cover_color,
    coverPath: b.cover_path,
    description: b.description || '',
    isbn: b.isbn || '',
    tags: b.tags || '',
    progress: b.progress_percent || 0,
    status: b.status || 'unread',
    lastLocationCfi: b.last_location_cfi,
    fileSize: Number(b.file_size) || 0,
    addedAt: b.added_at ? new Date(b.added_at).getTime() : 0,
    lastOpenedAt: b.last_opened_at ? new Date(b.last_opened_at).getTime() : null,
    bookmarks: [],
    highlights: [],
  }));

  try {
    const serverSettings = await api.getSettings({ expectedAccountVersion });
    if (!isActiveAccount(expectedAccountVersion)) return false;
    if (serverSettings['reader-settings'] && typeof serverSettings['reader-settings'] === 'object') {
      Object.assign(settings, serverSettings['reader-settings']);
    }
    normalizeSettings();
    document.documentElement.classList.toggle('dark-shell', serverSettings['shell-theme'] === 'dark');
    updateShellThemeControl();
  } catch(e){ /* defaults are fine */ }
  return isActiveAccount(expectedAccountVersion);
}

/* ---------------- Export / Import ---------------- */
async function exportLibrary(){
  if (!requireAdmin('create a library backup')) return;
  // Native navigation lets the browser stream directly to disk instead of
  // buffering a potentially huge ZIP in JavaScript memory.
  const link = document.createElement('a');
  link.href = '/api/export';
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

document.getElementById('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!requireAdmin('restore a library backup')) {
    e.target.value = '';
    return;
  }
  const confirmed = await showConfirmDialog({
    title: 'Import Backup',
    message: 'Import this backup into the shared library? Existing books are kept and backup data is merged.',
    confirmText: 'Import Backup',
    danger: false,
  });
  if (!confirmed) {
    e.target.value = '';
    return;
  }
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await api.fetch('/api/import', {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();

    // Reload library from server
    await loadLibraryFromStorage();
    renderFontOptions();
    renderShelf();
    updateSettingsUI();
    showToast(result.restored_files ? `Backup imported (${result.restored_files} files restored).` : 'Backup imported.');
  } catch(err){
    console.error('Import failed', err);
    showToast(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

/* Keep the rendition's page size in sync with Safari's toolbar show/hide,
   keyboard, and rotation.
   R-02/R-14: resize no longer calls display(cfi), so keyboard show/hide on
   iPhone is safe. R-03: orientationchange gets a longer debounce to let layout
   settle before measuring the viewport. */
let viewportResizeDebounce = null;
function handleViewportResize(e){
  clearTimeout(viewportResizeDebounce);
  const delay = (e && e.type === 'orientationchange') ? 400 : 150;
  viewportResizeDebounce = setTimeout(resizeReaderViewport, delay);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportResize);
window.addEventListener('resize', handleViewportResize);
window.addEventListener('orientationchange', handleViewportResize);

// End reading session on page unload
window.addEventListener('beforeunload', () => {
  if (currentSessionId) {
    // Use sendBeacon for reliable delivery
    navigator.sendBeacon(`/api/sessions/${currentSessionId}/end`, '{}');
  }
});

/* ---------------- Init ---------------- */
async function boot(){
  const bootAccountVersion = accountVersion;
  if (!isActiveAccount(bootAccountVersion)) return;
  const emptyP = document.getElementById('empty-shelf-copy');
  const emptyDiv = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  const continueCard = document.getElementById('continue-card');
  const dropzone = document.getElementById('dropzone');
  const emptyImportRow = document.getElementById('empty-import-row');

  if (emptyP) emptyP.textContent = 'Loading the shared library…';
  if (emptyDiv) emptyDiv.style.display = 'block';
  if (header) header.style.display = 'none';
  if (continueCard) continueCard.style.display = 'none';
  if (dropzone) dropzone.hidden = true;
  if (emptyImportRow) emptyImportRow.hidden = true;

  try {
    const loaded = await loadLibraryFromStorage(bootAccountVersion);
    if (!loaded || !isActiveAccount(bootAccountVersion)) return;
    if (emptyP) emptyP.textContent = 'The shared shelf is empty';
    if (dropzone && isCurrentUserAdmin()) dropzone.hidden = false;
    if (emptyImportRow && isCurrentUserAdmin()) emptyImportRow.hidden = false;
  } catch (e) {
    if (!isActiveAccount(bootAccountVersion)) return;
    console.error('Boot failed:', e);
    if (emptyDiv) emptyDiv.style.display = 'block';
    if (header) header.style.display = 'none';
    if (continueCard) continueCard.style.display = 'none';
    if (emptyP) {
      emptyP.innerHTML = '<div style="color:var(--ink); font-weight:500; margin-bottom:12px;">Could not load your library.</div><button type="button" class="file-link-btn" onclick="boot()" style="margin: 0 auto; display: inline-flex;">Retry</button>';
    }
    if (dropzone) dropzone.hidden = true;
    if (emptyImportRow) emptyImportRow.hidden = true;
    return;
  }
  renderFontOptions();
  restoreShelfPreferences();
  syncGestureSettingsUI();
  renderShelf();
  updateSettingsUI();
  api.getStats({ expectedAccountVersion: bootAccountVersion }).then(stats => {
    if (!isActiveAccount(bootAccountVersion)) return;
    const measured = Number(stats.reading_bytes_per_minute);
    if (Number.isFinite(measured) && measured > 0) {
      personalReadingBytesPerMinute = Math.min(50_000, Math.max(1_500, measured));
      renderShelf();
    }
  }).catch(() => {});
  // Load collections after shelf is ready
  await loadCollections();
  if (!isActiveAccount(bootAccountVersion)) return;
  updateRoleAwareControls();
  flushOfflineQueue();
}

function abortReaderRequests() {
  readerRequestVersion += 1;
  if (readerAbortController) {
    readerAbortController.abort();
    readerAbortController = null;
  }
  activeReaderRequest = null;
}

function resetReaderPreferences() {
  Object.assign(settings, DEFAULT_READER_SETTINGS);
  document.documentElement.classList.remove('dark-shell');
  document.body.style.removeProperty('background');
  updateShellThemeControl();
}

/* Dispose immediately and without API calls. This is deliberately used by
   expiry/account-change paths, where another request could attach stale
   reader data to the wrong person. */
function discardReaderState({ clearLibrary = false, resetPreferences = false } = {}) {
  abortReaderRequests();
  searchRequestVersion += 1;
  clearTimeout(searchDebounce);
  clearTimeout(metaSaveTimer);
  clearTimeout(settingsSaveTimer);
  if (typeof metaSaveAbortController !== 'undefined' && metaSaveAbortController) metaSaveAbortController.abort();
  if (typeof settingsSaveAbortController !== 'undefined' && settingsSaveAbortController) settingsSaveAbortController.abort();
  currentSessionId = null;
  currentBookId = null;
  locationsReady = false;
  lastReaderViewportSize = { width: 0, height: 0 };
  pageTurnLock = false;
  clearTimeout(pageTurnLockTimer);
  pendingHighlightCfi = null;
  pendingHighlightContext = null;
  highlightReturnFocus = null;
  window.onkeydown = null;

  if (typeof scrollFadeObserver !== 'undefined' && scrollFadeObserver) {
    scrollFadeObserver.disconnect();
    scrollFadeObserver = null;
  }
  clearTimeout(readerChromeTimer); // R-13
  readerChromeTimer = null;

  // R-16: Revoke the Blob URL so the browser can reclaim the underlying EPUB data
  if (currentBlobUrl) {
    try { URL.revokeObjectURL(currentBlobUrl); } catch (_) {}
    currentBlobUrl = null;
  }

  const oldBook = book;
  book = null;
  rendition = null;
  try { if (oldBook) oldBook.destroy(); } catch (e) { /* already disposed */ }

  document.getElementById('viewer').replaceChildren();
  document.getElementById('loading-overlay').classList.add('hidden');
  hideHighlightPopup();
  closeShortcutsModal({ returnFocus: false });
  closeStatsModal();
  document.getElementById('collections-modal').classList.remove('show');
  closeAdminModal({ returnFocus: false });
  document.getElementById('app').classList.remove('chrome-hidden');
  syncReaderChromeAccessibility();
  exitReaderFullscreen();
  updateFullscreenControlUI();
  document.body.classList.remove('reader-active');
  document.body.style.removeProperty('background');
  syncReaderPalette();
  document.getElementById('reader-view').classList.remove('active', 'scrolled');
  document.getElementById('shelf-view').style.display = 'block';
  ['toc-toggle', 'search-toggle', 'settings-toggle', 'bookmarks-toggle', 'bookmark-toggle', 'tts-btn', 'fullscreen-btn', 'reader-more-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  stopTts();
  const ttsBtn = document.getElementById('tts-btn');
  if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'false');
  window.currentBookData = null;
  window.currentHighlights = [];
  const progressSliderEl = document.getElementById('progress-slider');
  if (progressSliderEl) {
    progressSliderEl.onchange = null;
    progressSliderEl.oninput = null;
    progressSliderEl.onpointerdown = null;
    progressSliderEl.onmousedown = null;
    progressSliderEl.ontouchstart = null;
  }
  isDraggingProgressSlider = false;
  seekLockUntil = 0;
  closeDrawers();
  document.title = 'Endpaper — an EPUB reader';

  if (clearLibrary) {
    cancelBookWarmup();
    clearReaderAssetCaches();
    library = [];
    allCollections = [];
    renderShelf();
  }
  if (resetPreferences) {
    resetReaderPreferences();
    renderFontOptions();
    updateSettingsUI();
  }
}

// Check auth before boot
(async function(){
  try {
    const session = await refreshCurrentUser();
    if (session) {
      boot();
    } else {
      showLoginGate();
    }
  } catch(e) {
    setCurrentUser(null);
    showLoginGate();
  }
})();

/* ---------------- Stats UI ---------------- */
let statsModalReturnFocus = null;

async function openStatsModal() {
  const expectedAccountVersion = accountVersion;
  if (!isActiveAccount(expectedAccountVersion)) return;
  const active = document.activeElement;
  statsModalReturnFocus = active instanceof HTMLElement ? active : null;
  try {
    const stats = await api.getStats({ expectedAccountVersion });
    if (!isActiveAccount(expectedAccountVersion)) return;
    document.getElementById('stat-streak').textContent = stats.reading_streak_days;
    document.getElementById('stat-finished').textContent = stats.books_finished;
    
    const weekHours = (stats.time_read_this_week / 3600).toFixed(1);
    document.getElementById('stat-week').textContent = weekHours.replace('.0', '') + 'h';
    
    const totalHours = (stats.time_read_total / 3600).toFixed(1);
    document.getElementById('stat-total').textContent = totalHours.replace('.0', '') + 'h';

    const chart = document.getElementById('stats-chart');
    const daily = Array.isArray(stats.daily) ? stats.daily : [];
    const maxSeconds = Math.max(60, ...daily.map(day => day.seconds || 0));
    chart.innerHTML = daily.map(day => `<div class="stats-bar" style="height:${Math.max(2, Math.round((day.seconds || 0) / maxSeconds * 100))}%" title="${Math.round((day.seconds || 0) / 60)} minutes on ${escapeHtml(day.date)}"><span>${escapeHtml(day.date.slice(8))}</span></div>`).join('');
    const change = stats.previous_7_days > 0 ? Math.round((stats.time_read_this_week - stats.previous_7_days) / stats.previous_7_days * 100) : null;
    const recentMonths = (stats.monthly || []).slice(-6).map(month => `${month.month}: ${formatMinutes(Math.round(month.seconds / 60))}`).join(' · ');
    document.getElementById('stats-comparison').textContent = `Longest streak: ${stats.longest_streak_days || 0} days · Average session: ${Math.round((stats.average_session_seconds || 0) / 60)} min${change == null ? '' : ` · ${change >= 0 ? '+' : ''}${change}% vs previous 7 days`}${recentMonths ? `\nMonthly: ${recentMonths}` : ''}`;
    document.getElementById('stats-most-read').innerHTML = stats.most_read?.length ? `<strong>Most read</strong><br>${stats.most_read.map((item, index) => `${index + 1}. ${escapeHtml(item.title)} — ${formatMinutes(Math.round(item.seconds / 60))}`).join('<br>')}` : '';
    try {
      const prefs = await api.getSettings({ expectedAccountVersion });
      const goals = prefs['reading-goals'] || {};
      document.getElementById('goal-daily').value = goals.dailyMinutes || '';
      document.getElementById('goal-weekly').value = goals.weeklyHours || '';
      document.getElementById('goal-books').value = goals.booksPerYear || '';
    } catch (_) {}

    const modal = document.getElementById('stats-modal');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      const closeBtn = modal.querySelector('.modal-close-btn') || modal.querySelector('button');
      if (closeBtn) closeBtn.focus();
    });
  } catch(e) {
    if (isActiveAccount(expectedAccountVersion) && !isAbortError(e)) console.error('Failed to load stats:', e);
  }
}

function closeStatsModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('stats-modal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  ['stat-streak', 'stat-finished', 'stat-week', 'stat-total'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  const target = statsModalReturnFocus;
  statsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

/* ---------------- Collections UI ---------------- */
let collectionsModalReturnFocus = null;

async function loadCollections() {
  try {
    allCollections = await api.getCollections();
    renderCollectionsFilter();
  } catch(e) {
    console.error('Failed to load collections:', e);
    const group = document.getElementById('shelf-filter-collections');
    if (group) {
      group.innerHTML = '<option disabled>Could not load collections</option>';
    }
  }
}

function renderCollectionsFilter() {
  const group = document.getElementById('shelf-filter-collections');
  if (!group) return;
  group.innerHTML = '';
  allCollections.forEach(c => {
    const opt = document.createElement('option');
    opt.value = 'col_' + c.id;
    opt.textContent = c.name;
    group.appendChild(opt);
  });
}

let activeOrganizeBookId = null;

async function openBookCollectionsModal(bookId) {
  if (!requireAdmin('organize shared collections')) return;
  const active = document.activeElement;
  collectionsModalReturnFocus = active instanceof HTMLElement ? active : null;
  activeOrganizeBookId = bookId;
  const book = library.find(b => b.id === bookId);
  document.getElementById('collections-title').textContent = book ? `Organize “${book.name}”` : 'Organize Collections';
  const list = document.getElementById('collection-list');
  list.innerHTML = '';
  
  if (book) {
    const ratingRow = document.createElement('div');
    ratingRow.style.cssText = 'padding: 8px 4px 12px; margin-bottom: 12px; border-bottom: 1px solid var(--border-soft); display: flex; align-items: center; justify-content: space-between;';
    ratingRow.innerHTML = `
      <span style="font-size:13px; font-weight:600; color:var(--ink);">Your Rating</span>
      ${renderRatingHtml(book.id, book.rating)}
    `;
    list.appendChild(ratingRow);
  }

  if (allCollections.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'color:var(--ink-soft); font-size:13px; font-style:italic; padding: 4px;';
    emptyMsg.textContent = 'No collections yet.';
    list.appendChild(emptyMsg);
  } else {
    allCollections.forEach(c => {
      const isChecked = c.book_ids.includes(bookId);
      const row = document.createElement('label');
      row.className = 'collection-item';
      row.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleBookCollection('${c.id}', this.checked)"> <span>${escapeHtml(c.name)}</span>`;
      list.appendChild(row);
    });
  }
  
  const modal = document.getElementById('collections-modal');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('new-collection-input').value = '';
  requestAnimationFrame(() => {
    const firstInput = modal.querySelector('input, button');
    if (firstInput) firstInput.focus();
  });
}

async function openCollectionsManager() {
  if (!requireAdmin('manage shared collections')) return;
  const active = document.activeElement;
  collectionsModalReturnFocus = active instanceof HTMLElement ? active : document.getElementById('library-tools-btn');
  activeOrganizeBookId = null;
  document.getElementById('collections-title').textContent = 'Manage Collections';
  const list = document.getElementById('collection-list');
  list.innerHTML = '<div style="color:var(--ink-soft); font-size:13px; padding:6px 0;">Loading collections…</div>';
  const modal = document.getElementById('collections-modal');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('new-collection-input').value = '';

  try {
    allCollections = await api.getCollections();
    renderCollectionsFilter();
    list.innerHTML = '';
    if (allCollections.length === 0) {
      list.innerHTML = '<div style="color:var(--ink-soft); font-size:13px; font-style:italic; padding:4px 0;">No collections yet. Create one below.</div>';
    } else {
      allCollections.forEach(collection => {
        const row = document.createElement('div');
        row.className = 'collection-item collection-item-manage';
        const name = document.createElement('span');
        name.textContent = `${collection.name} (${collection.book_ids.length})`;
        const actions = document.createElement('div');
        actions.className = 'collection-actions';
        const rename = document.createElement('button');
        rename.className = 'collection-delete';
        rename.textContent = 'Rename';
        rename.onclick = () => renameCollection(collection.id, collection.name);
        const remove = document.createElement('button');
        remove.className = 'collection-delete';
        remove.textContent = 'Delete';
        remove.onclick = () => deleteCollection(collection.id, collection.name);
        actions.append(rename, remove);
        row.append(name, actions);
        list.appendChild(row);
      });
    }
    requestAnimationFrame(() => {
      const input = document.getElementById('new-collection-input');
      if (input) input.focus();
    });
  } catch (e) {
    console.error('Failed to load collections in manager:', e);
    list.innerHTML = `
      <div style="color:#C14B4B; font-size:13px; margin-bottom:8px;">Could not load collections: ${escapeHtml(e.message)}</div>
      <button type="button" class="file-link-btn" onclick="openCollectionsManager()">Retry</button>
    `;
  }
}

function closeCollectionsModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('collections-modal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  activeOrganizeBookId = null;
  renderShelf();
  const target = collectionsModalReturnFocus;
  collectionsModalReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

function toggleLibraryToolsMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('library-tools-menu');
  const btn = document.getElementById('library-tools-btn');
  if (!menu) return;
  const isShown = menu.classList.contains('show');
  menu.classList.toggle('show', !isShown);
  if (btn) btn.setAttribute('aria-expanded', String(!isShown));
}

function closeLibraryToolsMenu() {
  const menu = document.getElementById('library-tools-menu');
  const btn = document.getElementById('library-tools-btn');
  if (menu) menu.classList.remove('show');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-wrap')) {
    closeLibraryToolsMenu();
  }
});

async function toggleBookCollection(collectionId, isChecked) {
  if (!requireAdmin('organize shared collections')) return;
  if (!activeOrganizeBookId) return;
  try {
    if (isChecked) {
      await api.addBookToCollection(activeOrganizeBookId, collectionId);
    } else {
      await api.removeBookFromCollection(activeOrganizeBookId, collectionId);
    }
    await loadCollections();
  } catch(e) { console.error('Failed to toggle collection:', e); showToast(`Could not update collection: ${e.message}`); }
}

async function deleteCollection(id, name) {
  if (!requireAdmin('manage shared collections')) return;
  const confirmed = await showConfirmDialog({
    title: 'Delete Collection',
    message: `Delete the “${name}” collection? Its books will remain in your library.`,
    confirmText: 'Delete Collection',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteCollection(id);
    await loadCollections();
    openCollectionsManager();
    showToast('Collection deleted.');
  } catch (e) {
    console.error('Failed to delete collection:', e);
    showToast(`Could not delete collection: ${e.message}`);
  }
}

async function renameCollection(id, currentName) {
  if (!requireAdmin('manage shared collections')) return;
  const name = prompt('Collection name', currentName);
  if (name === null || name.trim() === currentName) return;
  try {
    await api.renameCollection(id, name.trim());
    await loadCollections();
    openCollectionsManager();
    showToast('Collection renamed.');
  } catch (e) {
    console.error('Failed to rename collection:', e);
    showToast(`Could not rename collection: ${e.message}`);
  }
}

async function createCollection() {
  if (!requireAdmin('manage shared collections')) return;
  const input = document.getElementById('new-collection-input');
  const name = input.value.trim();
  if (!name) return;
  try {
    const col = await api.createCollection(name);
    await loadCollections();
    if (activeOrganizeBookId) {
      await api.addBookToCollection(activeOrganizeBookId, col.id);
      await loadCollections();
      openBookCollectionsModal(activeOrganizeBookId); // refresh
    } else {
      openCollectionsManager();
    }
  } catch(e) { console.error('Failed to create collection:', e); showToast(`Could not create collection: ${e.message}`); }
}

async function openAdminModal() {
  if (!requireAdmin('manage users')) return;
  const modal = document.getElementById('admin-modal');
  const activeElement = document.activeElement;
  adminModalReturnFocus = activeElement instanceof HTMLElement
    ? activeElement
    : document.getElementById('admin-toggle');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  await renderAdminUsers();
  if (modal.classList.contains('show')) {
    document.getElementById('new-user-username').focus({ preventScroll: true });
  }
}

function closeAdminModal({ returnFocus = true } = {}) {
  const modal = document.getElementById('admin-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  const returnTarget = adminModalReturnFocus;
  adminModalReturnFocus = null;
  if (returnFocus && returnTarget && returnTarget.isConnected && !returnTarget.hidden) {
    returnTarget.focus({ preventScroll: true });
  }
}

function getAdminModalFocusableElements() {
  const modal = document.getElementById('admin-modal');
  return Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(el => el.getClientRects().length > 0 && !el.hasAttribute('hidden'));
}

function handleAdminModalKeydown(event) {
  const modal = document.getElementById('admin-modal');
  if (!modal.classList.contains('show')) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeAdminModal();
    return;
  }

  if (event.key !== 'Tab') return;
  const focusable = getAdminModalFocusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function renderAdminUsers() {
  if (!requireAdmin('manage users')) return;
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  try {
    const users = await api.getUsers();
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'No accounts yet.';
      list.appendChild(empty);
      return;
    }
    users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'collection-item collection-item-manage admin-user-item';
      row.setAttribute('role', 'listitem');

      const identity = document.createElement('div');
      identity.className = 'admin-user-identity';
      const name = document.createElement('span');
      name.className = 'admin-user-name';
      name.textContent = u.username;
      const role = document.createElement('span');
      role.className = `role-badge ${u.is_admin ? 'admin' : 'reader'}`;
      role.textContent = u.is_admin ? 'Admin' : 'Reader';
      identity.append(name, role);

      const isCurrentUser = Boolean(currentUser && currentUser.username === u.username);
      if (isCurrentUser) {
        const current = document.createElement('span');
        current.className = 'current-user-badge';
        current.textContent = 'You';
        identity.appendChild(current);
      }
      row.appendChild(identity);

      const actions = document.createElement('div');
      actions.className = 'collection-actions';

      if (!isCurrentUser) {
        const roleBtn = document.createElement('button');
        roleBtn.type = 'button';
        roleBtn.className = 'admin-btn-sm';
        roleBtn.textContent = u.is_admin ? 'Make Reader' : 'Make Admin';
        roleBtn.setAttribute('aria-label', `Change ${u.username} to ${u.is_admin ? 'Reader' : 'Admin'}`);
        roleBtn.onclick = () => toggleUserRole(u.id, !u.is_admin);
        actions.appendChild(roleBtn);
      }

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'admin-btn-sm';
      resetBtn.textContent = 'Reset passphrase';
      resetBtn.setAttribute('aria-label', `Reset passphrase for ${u.username}`);
      resetBtn.onclick = () => openResetPassphraseModal(u.id, u.username);
      actions.appendChild(resetBtn);

      if (isCurrentUser) {
        const protectedNote = document.createElement('span');
        protectedNote.className = 'admin-self-note';
        protectedNote.textContent = 'Current account';
        actions.appendChild(protectedNote);
      } else {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'collection-delete';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${u.username}`);
        remove.onclick = () => deleteUser(u.id, u.username);
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  } catch (e) {
    const error = document.createElement('div');
    error.style.cssText = 'color:#C14B4B; font-size:13px; padding:8px 0;';
    error.innerHTML = `Could not load accounts: ${escapeHtml(e.message)} <button type="button" class="file-link-btn" style="margin-left:8px; display:inline-flex; vertical-align:middle;" onclick="renderAdminUsers()">Retry</button>`;
    list.appendChild(error);
  }
}

async function toggleUserRole(userId, newIsAdmin) {
  if (!requireAdmin('manage users')) return;
  const roleName = newIsAdmin ? 'Admin' : 'Reader';
  const confirmed = await showConfirmDialog({
    title: 'Change User Role',
    message: `Are you sure you want to change this account's role to ${roleName}?`,
    confirmText: 'Change Role',
    danger: false,
  });
  if (!confirmed) return;
  try {
    await api.updateUser(userId, { is_admin: newIsAdmin });
    await renderAdminUsers();
    showToast(`Role updated to ${roleName}.`);
  } catch(e) {
    console.error('Role change failed:', e);
    showToast(`Could not change role: ${e.message}`);
  }
}

let resetPassphraseTargetId = null;
let resetPassphraseReturnFocus = null;

function openResetPassphraseModal(userId, username) {
  const active = document.activeElement;
  resetPassphraseReturnFocus = active instanceof HTMLElement ? active : null;
  resetPassphraseTargetId = userId;
  const modal = document.getElementById('reset-passphrase-modal');
  const label = document.getElementById('reset-passphrase-user-label');
  const input = document.getElementById('reset-passphrase-input');
  label.textContent = `Set a new passphrase for “${username}”.`;
  input.value = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  input.focus();
}

function closeResetPassphraseModal({ returnFocus = true } = {}) {
  resetPassphraseTargetId = null;
  const modal = document.getElementById('reset-passphrase-modal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  const target = resetPassphraseReturnFocus;
  resetPassphraseReturnFocus = null;
  if (returnFocus && target && target.isConnected && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

async function handleResetPassphraseSubmit(event) {
  if (event) event.preventDefault();
  if (!resetPassphraseTargetId) return;
  const input = document.getElementById('reset-passphrase-input');
  const passphrase = input.value.trim();
  if (!passphrase || passphrase.length < 12) {
    showToast('Passphrase must be at least 12 characters.');
    input.focus();
    return;
  }
  try {
    await api.updateUser(resetPassphraseTargetId, { passphrase });
    closeResetPassphraseModal();
    showToast('Passphrase updated successfully.');
  } catch (e) {
    console.error('Failed to reset passphrase:', e);
    showToast(`Could not reset passphrase: ${e.message}`);
  }
}

async function createUser(event) {
  if (event) event.preventDefault();
  if (!requireAdmin('manage users')) return;
  const userIn = document.getElementById('new-user-username');
  const passIn = document.getElementById('new-user-passphrase');
  const username = userIn.value.trim();
  const passphrase = passIn.value.trim();
  const isAdmin = document.getElementById('new-user-isadmin').checked;
  if (!username || !passphrase) {
    showToast('Please enter a username and passphrase.');
    (!username ? userIn : passIn).focus();
    return false;
  }
  try {
    await api.createUser({ username, passphrase, is_admin: isAdmin });
    userIn.value = '';
    passIn.value = '';
    document.getElementById('new-user-isadmin').checked = false;
    await renderAdminUsers();
    userIn.focus();
    showToast('User added.');
  } catch(e) {
    console.error('Failed to create user:', e);
    showToast(`Could not create user: ${e.message}`);
  }
  return false;
}

async function deleteUser(id, username) {
  if (!requireAdmin('manage users')) return;
  const accountName = username ? `“${username}”` : 'this account';
  const confirmed = await showConfirmDialog({
    title: 'Remove User',
    message: `Remove ${accountName} from Endpaper? Their reading progress, bookmarks, highlights, and preferences will be permanently deleted. The shared library and everyone else’s data will remain. This cannot be undone.`,
    confirmText: 'Remove User',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteUser(id);
    await renderAdminUsers();
    showToast(username ? `${username} was removed.` : 'User removed.');
  } catch(e) {
    console.error('Failed to delete user:', e);
    showToast(`Could not delete user: ${e.message}`);
  }
}

/* ---------------- Reusable Confirmation Modal ---------------- */
let confirmDialogResolver = null;
const confirmQueue = [];
let isConfirmDialogOpen = false;

function showConfirmDialog({ title = 'Confirm Action', message = 'Are you sure?', confirmText = 'Confirm', cancelText = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    confirmQueue.push({ options: { title, message, confirmText, cancelText, danger }, resolve });
    processConfirmQueue();
  });
}

function processConfirmQueue() {
  if (isConfirmDialogOpen || confirmQueue.length === 0) return;
  isConfirmDialogOpen = true;
  const current = confirmQueue[0];
  const { options, resolve } = current;
  confirmDialogResolver = resolve;

  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  if (titleEl) titleEl.textContent = options.title;
  if (msgEl) msgEl.textContent = options.message;
  if (okBtn) {
    okBtn.textContent = options.confirmText;
    okBtn.className = options.danger ? 'new-collection-btn danger-btn' : 'new-collection-btn';
  }
  if (cancelBtn) cancelBtn.textContent = options.cancelText;

  if (modal) {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
  if (okBtn) okBtn.focus();
}

function closeConfirmDialog(result = false) {
  const modal = document.getElementById('confirm-modal');
  if (modal && modal.classList.contains('show')) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  const current = confirmQueue.shift();
  isConfirmDialogOpen = false;
  confirmDialogResolver = null;
  if (current && current.resolve) {
    current.resolve(result);
  }
  if (confirmQueue.length > 0) {
    setTimeout(processConfirmQueue, 50);
  }
}

if (document.getElementById('confirm-ok-btn')) {
  document.getElementById('confirm-ok-btn').addEventListener('click', () => closeConfirmDialog(true));
}
if (document.getElementById('confirm-cancel-btn')) {
  document.getElementById('confirm-cancel-btn').addEventListener('click', () => closeConfirmDialog(false));
}
if (document.getElementById('confirm-x-btn')) {
  document.getElementById('confirm-x-btn').addEventListener('click', () => closeConfirmDialog(false));
}
if (document.getElementById('confirm-modal')) {
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirmDialog(false);
  });
}
function trapFocus(event, container) {
  if (event.key !== 'Tab' || !container) return;
  const focusable = Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.hidden && el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (e) => {
  const confirmModal = document.getElementById('confirm-modal');
  if (confirmModal && confirmModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirmDialog(false);
      return;
    } else if (e.key === 'Enter' && e.target && !e.target.matches('button')) {
      e.preventDefault();
      closeConfirmDialog(true);
      return;
    }
    trapFocus(e, confirmModal);
    return;
  }

  const resetModal = document.getElementById('reset-passphrase-modal');
  if (resetModal && resetModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeResetPassphraseModal();
      return;
    }
    trapFocus(e, resetModal);
    return;
  }

  const statsModal = document.getElementById('stats-modal');
  if (statsModal && statsModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStatsModal();
      return;
    }
    trapFocus(e, statsModal);
    return;
  }

  const collectionsModal = document.getElementById('collections-modal');
  if (collectionsModal && collectionsModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCollectionsModal();
      return;
    }
    trapFocus(e, collectionsModal);
    return;
  }

  const openDrawerId = DRAWER_IDS.find(id => {
    const el = document.getElementById(id + '-drawer');
    return el && el.classList.contains('open');
  });
  if (openDrawerId) {
    const openDrawer = document.getElementById(openDrawerId + '-drawer');
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawers();
      return;
    }
    trapFocus(e, openDrawer);
    return;
  }
});

document.getElementById('admin-modal').addEventListener('mousedown', (event) => {
  if (event.target === event.currentTarget) closeAdminModal();
});
document.addEventListener('keydown', handleAdminModalKeydown);
if (document.getElementById('empty-upload-btn')) {
  document.getElementById('empty-upload-btn').addEventListener('click', () => {
    document.getElementById('upload-btn').click();
  });
}


/* ---------------- Read Aloud / Text-to-Speech (TTS) Engine ---------------- */
let ttsQueue = [];           // Array of { text: string, element: HTMLElement, doc: Document }
let ttsIndex = 0;
let ttsUtterance = null;
let ttsIsPaused = false;
let ttsRate = 1.0;
let ttsPitch = 1.0;
let ttsVoiceURI = '';
let ttsSleepTimer = null;
const TTS_RATES = [0.75, 1.0, 1.25, 1.5, 2.0];

function splitIntoSentences(text) {
  if (!text) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = Array.from(segmenter.segment(text));
      return segments.map(s => s.segment.trim()).filter(s => s.length > 0);
    } catch (_) {}
  }
  const raw = text.match(/[^.!?\n\r]+[.!?]+(?:\s+|$)|[^.!?\n\r]+$/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}

function clearTtsHighlights() {
  try {
    const iframes = document.querySelectorAll('#viewer iframe');
    iframes.forEach(iframe => {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        doc.querySelectorAll('.endpaper-tts-active').forEach(el => el.classList.remove('endpaper-tts-active'));
      }
    });
  } catch (_) {}
}

function highlightTtsElement(element, doc) {
  clearTtsHighlights();
  if (!element) return;
  element.classList.add('endpaper-tts-active');
  try {
    const isScrolled = settings.layout === 'scrolled';

    if (isScrolled) {
      // In scrolled layout, smooth auto-scroll to keep active spoken sentence in comfortable view
      const scrollContainer = (rendition && rendition.manager && rendition.manager.container) ||
                              document.getElementById('epub-scroll-container') ||
                              document.querySelector('#viewer > div');
      const iframe = (doc && doc.defaultView && doc.defaultView.frameElement) || document.querySelector('#viewer iframe');

      if (scrollContainer && iframe) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();

        // Calculate the element's position relative to the scroll container viewport
        const elTopInContainer = (iframeRect.top - containerRect.top) + elRect.top;
        const elCenterInContainer = elTopInContainer + (elRect.height / 2);
        const targetLine = containerRect.height * 0.38; // Target ~38% from top for optimal reading position

        const diff = elCenterInContainer - targetLine;
        // If active sentence deviates by more than 35px from the target reading line, scroll smoothly
        if (Math.abs(diff) > 35) {
          scrollContainer.scrollBy({
            top: diff,
            behavior: 'smooth'
          });
        }
      } else {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      // In paginated mode, detect whether element is off-screen using viewer coordinates
      const viewer = document.getElementById('viewer');
      const iframe = (doc && doc.defaultView && doc.defaultView.frameElement) || document.querySelector('#viewer iframe');
      if (viewer && iframe) {
        const viewerRect = viewer.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();

        const screenLeft = iframeRect.left + elRect.left;
        const screenRight = iframeRect.left + elRect.right;

        // If the element is to the right of the visible screen (next spread)
        if (screenLeft >= viewerRect.right - 20) {
          turnPage('next');
        } else if (screenRight <= viewerRect.left + 20) {
          // If the element is to the left of the visible screen (previous spread)
          turnPage('prev');
        }
      }
    }
  } catch (_) {}
}

function updateTtsPlayerUI() {
  const bar = document.getElementById('tts-player-bar');
  const ttsBtn = document.getElementById('tts-btn');
  const playIcon = document.getElementById('tts-play-icon');
  const pauseIcon = document.getElementById('tts-pause-icon');
  const activeTextEl = document.getElementById('tts-active-text');
  const rateLabel = document.getElementById('tts-rate-label');

  if (!bar) return;

  if (ttsQueue.length > 0 && ttsIndex < ttsQueue.length) {
    bar.classList.remove('hidden');
    if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'true');
    const current = ttsQueue[ttsIndex];
    if (activeTextEl) activeTextEl.textContent = current ? current.text : '';
    if (playIcon && pauseIcon) {
      playIcon.style.display = ttsIsPaused ? 'block' : 'none';
      pauseIcon.style.display = ttsIsPaused ? 'none' : 'block';
    }
    if (rateLabel) rateLabel.textContent = ttsRate + '×';
  } else {
    bar.classList.add('hidden');
    if (ttsBtn) ttsBtn.setAttribute('aria-pressed', 'false');
    clearTtsHighlights();
  }
}

function speakCurrentTtsItem() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  if (ttsIndex >= ttsQueue.length || ttsIndex < 0) {
    stopTts();
    return;
  }

  const item = ttsQueue[ttsIndex];
  if (!item || !item.text) {
    ttsIndex++;
    speakCurrentTtsItem();
    return;
  }

  ttsIsPaused = false;
  highlightTtsElement(item.element, item.doc);
  updateTtsPlayerUI();

  ttsUtterance = new SpeechSynthesisUtterance(item.text);
  ttsUtterance.rate = ttsRate;
  ttsUtterance.pitch = ttsPitch;
  const selectedVoice = speechSynthesis.getVoices().find(voice => voice.voiceURI === ttsVoiceURI);
  if (selectedVoice) ttsUtterance.voice = selectedVoice;

  ttsUtterance.onend = () => {
    if (!ttsIsPaused) {
      ttsIndex++;
      if (ttsIndex < ttsQueue.length) {
        speakCurrentTtsItem();
      } else {
        // Reached end of current chapter queue. Advance to the next chapter!
        if (rendition && rendition.next) {
          // Route through page-turn mutex so TTS cannot race with user input (R-09)
          if (pageTurnLock) { stopTts(); showToast('Finished reading aloud'); return; }
          pageTurnLock = true;
          clearTimeout(pageTurnLockTimer);
          let ttsAdvancePromise;
          try { ttsAdvancePromise = rendition.next(); } catch (_) {}
          const unlockTts = () => { pageTurnLock = false; };
          pageTurnLockTimer = setTimeout(unlockTts, 600);
          (ttsAdvancePromise || Promise.resolve()).then(() => {
            unlockTts();
            clearTimeout(pageTurnLockTimer);
            setTimeout(async () => {
              // Match active section via currentLocation() rather than blindly
              // taking getContents()[0] which may be a preloaded prior section (R-11)
              let targetDoc = null;
              try {
                const loc = await getCurrentLocationSafe(rendition);
                const activeHref = loc && loc.start && loc.start.href;
                const contents = (rendition.getContents && rendition.getContents()) || [];
                if (activeHref && contents.length > 0) {
                  const normalizeHref = value => decodeURIComponent(String(value || '').split('#')[0].split('?')[0]).replace(/^\.\//, '');
                  const activePath = normalizeHref(activeHref);
                  const exact = contents.filter(c => {
                    const candidate = normalizeHref(c.href || (c.section && c.section.href));
                    return candidate === activePath || candidate.endsWith('/' + activePath) || activePath.endsWith('/' + candidate);
                  });
                  if (exact.length === 1) targetDoc = exact[0].document;
                  if (!targetDoc) {
                    const activeBase = activePath.split('/').pop();
                    const basenameMatches = contents.filter(c => normalizeHref(c.href || (c.section && c.section.href)).split('/').pop() === activeBase);
                    if (basenameMatches.length === 1) targetDoc = basenameMatches[0].document;
                  }
                }
              } catch (_) {}
              if (!targetDoc) {
                const iframes = document.querySelectorAll('#viewer iframe');
                if (iframes.length === 1) targetDoc = iframes[0].contentDocument || (iframes[0].contentWindow && iframes[0].contentWindow.document);
              }
              if (targetDoc) {
                const nextQueue = collectReadableItemsFromNode(null, targetDoc);
                if (nextQueue.length > 0) { startTtsWithQueue(nextQueue, 0); return; }
              }
              stopTts();
              showToast('Finished reading aloud');
            }, 350);
          }).catch(() => {
            unlockTts();
            clearTimeout(pageTurnLockTimer);
            stopTts();
            showToast('Finished reading aloud');
          });
        } else {
          stopTts();
          showToast('Finished reading aloud');
        }
      }
    }
  };

  ttsUtterance.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.error('TTS error:', e);
      stopTts();
    }
  };

  window.speechSynthesis.speak(ttsUtterance);
}

function startTtsWithQueue(items, startIndex = 0) {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis not supported on this browser', 'error');
    return;
  }
  if (!items || items.length === 0) {
    showToast('No readable text found on current page', 'error');
    return;
  }
  window.speechSynthesis.cancel();
  ttsQueue = items;
  ttsIndex = Math.max(0, Math.min(items.length - 1, startIndex));
  ttsIsPaused = false;
  speakCurrentTtsItem();
}

function stopTts() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  ttsQueue = [];
  ttsIndex = 0;
  ttsUtterance = null;
  ttsIsPaused = false;
  if (ttsSleepTimer) clearTimeout(ttsSleepTimer);
  ttsSleepTimer = null;
  clearTtsHighlights();
  updateTtsPlayerUI();
}

function toggleTtsPause() {
  if (!('speechSynthesis' in window) || ttsQueue.length === 0) return;
  if (ttsIsPaused) {
    ttsIsPaused = false;
    speakCurrentTtsItem();
  } else {
    ttsIsPaused = true;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }
  updateTtsPlayerUI();
}

function ttsNextSentence() {
  if (ttsIndex + 1 < ttsQueue.length) {
    ttsIndex++;
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    } else {
      const item = ttsQueue[ttsIndex];
      if (item) highlightTtsElement(item.element, item.doc);
      updateTtsPlayerUI();
    }
  } else {
    stopTts();
  }
}

function ttsPrevSentence() {
  if (ttsIndex > 0) {
    ttsIndex--;
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    } else {
      const item = ttsQueue[ttsIndex];
      if (item) highlightTtsElement(item.element, item.doc);
      updateTtsPlayerUI();
    }
  } else {
    if (!ttsIsPaused) {
      speakCurrentTtsItem();
    }
  }
}

function cycleTtsRate() {
  const currentIndex = TTS_RATES.indexOf(ttsRate);
  const nextIndex = (currentIndex + 1) % TTS_RATES.length;
  ttsRate = TTS_RATES[nextIndex];
  const rateLabel = document.getElementById('tts-rate-label');
  if (rateLabel) rateLabel.textContent = ttsRate + '×';
  if (!ttsIsPaused && ttsQueue.length > 0) {
    speakCurrentTtsItem();
  }
}

function collectReadableItemsFromNode(startNode, doc) {
  if (!doc) return [];
  const isScrolled = settings.layout === 'scrolled';
  const allDocs = [];

  if (isScrolled) {
    // In continuous scrolled mode, collect from current iframe document and all subsequent chapter iframes
    const iframes = Array.from(document.querySelectorAll('#viewer iframe'));
    let foundCurrent = false;
    iframes.forEach(iframe => {
      try {
        const d = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (d === doc) foundCurrent = true;
        if (foundCurrent && d && !allDocs.includes(d)) allDocs.push(d);
      } catch (_) {}
    });
  }
  if (allDocs.length === 0) allDocs.push(doc);

  const items = [];
  allDocs.forEach((d, docIndex) => {
    const allBlocks = Array.from(d.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
    let startIndex = 0;
    if (docIndex === 0 && startNode) {
      const parentBlock = (startNode.closest && startNode.closest('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd')) ||
                          (startNode.parentElement && startNode.parentElement.closest && startNode.parentElement.closest('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
      if (parentBlock) {
        const idx = allBlocks.indexOf(parentBlock);
        if (idx >= 0) startIndex = idx;
      }
    }

    for (let i = startIndex; i < allBlocks.length; i++) {
      const block = allBlocks[i];
      const text = block.innerText || block.textContent || '';
      const cleanText = text.replace(/\s+/g, ' ').trim();
      if (cleanText) {
        const sentences = splitIntoSentences(cleanText);
        sentences.forEach(s => {
          items.push({ text: s, element: block, doc: d });
        });
      }
    }
  });

  return items;
}

function readAloudFromSelection() {
  if (!rendition) return;
  hideHighlightPopup();

  let startNode = null;
  let doc = null;

  const contents = (rendition.getContents && rendition.getContents()) || [];
  for (const content of contents) {
    const win = content.window || (content.document && content.document.defaultView);
    if (win && win.getSelection) {
      const sel = win.getSelection();
      if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
        const range = sel.getRangeAt(0);
        startNode = range.startContainer;
        doc = content.document || win.document;
        break;
      }
    }
  }

  if (!doc && contents.length > 0) {
    doc = contents[0].document;
  }
  if (!doc) {
    const iframe = document.querySelector('#viewer iframe');
    if (iframe) doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
  }

  if (doc) {
    const queue = collectReadableItemsFromNode(startNode, doc);
    if (queue.length > 0) {
      startTtsWithQueue(queue, 0);
      return;
    }
  }

  startTtsFromVisible();
}

function startTtsFromVisible() {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis not supported on this browser', 'error');
    return;
  }

  if (ttsQueue.length > 0 && !ttsIsPaused) {
    toggleTtsPause();
    return;
  }
  if (ttsQueue.length > 0 && ttsIsPaused) {
    toggleTtsPause();
    return;
  }

  if (!rendition) return;

  const contents = (rendition.getContents && rendition.getContents()) || [];
  let startNode = null;
  let targetDoc = null;

  // 1. Check user text selection first
  for (const content of contents) {
    const win = content.window || (content.document && content.document.defaultView);
    if (win && win.getSelection) {
      const sel = win.getSelection();
      if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
        const range = sel.getRangeAt(0);
        startNode = range.startContainer;
        targetDoc = content.document || win.document;
        break;
      }
    }
  }

  // 2. If no selection, find the topmost visible paragraph in viewport
  if (!startNode) {
    for (const content of contents) {
      const doc = content.document || (content.content && content.content.document);
      const win = content.window || (doc && doc.defaultView);
      if (doc) {
        const blocks = Array.from(doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li, dt, dd'));
        for (const block of blocks) {
          const rect = block.getBoundingClientRect();
          if (rect.bottom > 20 && rect.top < (win ? win.innerHeight : window.innerHeight) * 0.6) {
            startNode = block;
            targetDoc = doc;
            break;
          }
        }
        if (startNode) break;
      }
    }
  }

  if (!targetDoc && contents.length > 0) {
    targetDoc = contents[0].document;
  }
  if (!targetDoc) {
    const iframe = document.querySelector('#viewer iframe');
    if (iframe) targetDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
  }

  if (targetDoc) {
    const queue = collectReadableItemsFromNode(startNode, targetDoc);
    if (queue.length > 0) {
      startTtsWithQueue(queue, 0);
      return;
    }
  }

  showToast('No readable text found on current page', 'error');
}

if (document.getElementById('tts-btn')) {
  document.getElementById('tts-btn').addEventListener('click', () => {
    startTtsFromVisible();
  });
}

function showDictionaryUI(word, data, status, x, y) {
  const tooltip = document.getElementById('dict-tooltip');
  if (!tooltip) return;
  if (status === 'offline') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition available offline.</p>';
  } else if (status === 'not_found') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition found for \'' + escapeHtml(word) + '\'.</p>';
  } else if (status === 'error') {
    tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>Definition lookup failed. Try again.</p>';
  } else if (status === 'success' && data) {
    try {
      const meaning = data[0].meanings[0].definitions[0].definition;
      tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>' + escapeHtml(meaning) + '</p>';
    } catch (e) {
      tooltip.innerHTML = '<h4>' + escapeHtml(word) + '</h4><p>No definition found for \'' + escapeHtml(word) + '\'.</p>';
    }
  }
  if (x !== undefined && y !== undefined) {
    tooltip.style.left = Math.max(10, x) + 'px';
    tooltip.style.top = Math.max(10, y + 20) + 'px';
  }
  tooltip.classList.remove('hidden');
}

async function lookupDictionary(word, x, y) {
  const tooltip = document.getElementById('dict-tooltip');
  if (!word || word.length < 2) {
    if (tooltip) tooltip.classList.add('hidden');
    return;
  }
  const cacheKey = 'endpaper_dictionary_cache';
  let dictionaryCache = {};
  try { dictionaryCache = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch (_) {}
  const normalizedWord = word.toLocaleLowerCase();
  if (!navigator.onLine) {
    if (dictionaryCache[normalizedWord]) showDictionaryUI(word, dictionaryCache[normalizedWord].data, 'success', x, y);
    else showDictionaryUI(word, null, 'offline', x, y);
    return;
  }
  try {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!res.ok) {
      showDictionaryUI(word, null, res.status === 404 ? 'not_found' : 'error', x, y);
      return;
    }
    const data = await res.json();
    try {
      dictionaryCache[normalizedWord] = { data, ts: Date.now() };
      const entries = Object.entries(dictionaryCache).sort((a,b) => b[1].ts - a[1].ts).slice(0, 200);
      localStorage.setItem(cacheKey, JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {}
    showDictionaryUI(word, data, 'success', x, y);
  } catch (_) {
    showDictionaryUI(word, null, 'offline', x, y);
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#dict-tooltip')) {
    const t = document.getElementById('dict-tooltip');
    if (t) t.classList.add('hidden');
  }
});

if (document.getElementById('export-highlights-btn')) {
  document.getElementById('export-highlights-btn').addEventListener('click', () => {
    if (!window.currentHighlights || window.currentHighlights.length === 0) return;
    let md = '# Highlights for ' + window.currentBookData.title + '\n\n';
    window.currentHighlights.forEach(h => {
      md += '> ' + h.excerpt + '\n\n';
      if (h.note) md += '**Note:** ' + h.note + '\n\n';
      md += '---\n\n';
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = window.currentBookData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_highlights.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ---------------- Product experience extensions (R-24–R-55) ---------------- */
let shelfRenderTimer = null;
let bulkMode = false;
const bulkSelection = new Set();
let notebookItems = [];
let notebookTagFilter = '';

function shelfPreferenceKey() {
  return currentUser?.username ? `endpaper_shelf:${currentUser.username.toLocaleLowerCase()}` : null;
}

function saveShelfPreferences() {
  const key = shelfPreferenceKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    search: document.getElementById('shelf-search')?.value || '',
    filter: document.getElementById('shelf-filter')?.value || 'all',
    sort: document.getElementById('shelf-sort')?.value || 'recent',
    density: document.getElementById('shelf-density')?.value || 'comfortable',
  }));
}

function restoreShelfPreferences() {
  const key = shelfPreferenceKey();
  if (!key) return;
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    if (document.getElementById('shelf-search')) document.getElementById('shelf-search').value = value.search || '';
    if (document.getElementById('shelf-filter') && [...document.getElementById('shelf-filter').options].some(option => option.value === value.filter)) document.getElementById('shelf-filter').value = value.filter;
    if (document.getElementById('shelf-sort') && [...document.getElementById('shelf-sort').options].some(option => option.value === value.sort)) document.getElementById('shelf-sort').value = value.sort;
    if (document.getElementById('shelf-density') && ['comfortable', 'compact'].includes(value.density)) document.getElementById('shelf-density').value = value.density;
  } catch (_) {}
}

function scheduleShelfRender() {
  clearTimeout(shelfRenderTimer);
  shelfRenderTimer = setTimeout(renderShelf, 130);
}

function estimatedBookMinutes(entry, remainingOnly = false) {
  const total = Math.max(10, Math.round((entry.fileSize || 1_000_000) / personalReadingBytesPerMinute));
  return remainingOnly ? Math.max(0, Math.round(total * (1 - (entry.progress || 0) / 100))) : total;
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ''}`;
}

function coverMarkup(entry, className = 'cover-img') {
  return entry.coverPath
    ? `<img class="${className}" src="/api/books/${entry.id}/cover" alt="" loading="lazy" decoding="async">`
    : `<span class="spine-title">${escapeHtml(entry.name)}</span><span class="spine-author">${escapeHtml(entry.author || '')}</span>`;
}

function renderContinueCard(){
  const rail = document.getElementById('continue-card');
  const candidates = library.filter(entry => entry.lastOpenedAt && entry.progress > 0 && entry.progress < 98)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 4);
  rail.replaceChildren();
  if (!candidates.length) { rail.style.display = 'none'; return; }
  const fragment = document.createDocumentFragment();
  candidates.forEach(entry => {
    const item = document.createElement('article');
    item.className = 'continue-item';
    item.tabIndex = 0;
    item.innerHTML = `<div class="spine" style="background:${entry.coverColor}">${coverMarkup(entry)}</div><div><div class="kicker">Continue reading</div><h3>${escapeHtml(entry.name)}</h3><div class="author">${escapeHtml(entry.author || 'Unknown author')}</div><div class="progress-text">${Math.round(entry.progress)}% · about ${formatMinutes(estimatedBookMinutes(entry, true))} left</div><div class="book-progress-bar"><div class="book-progress-fill" style="width:${entry.progress}%"></div></div></div>`;
    item.onclick = () => openBook(entry.id);
    item.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBook(entry.id); } };
    fragment.appendChild(item);
  });
  rail.appendChild(fragment);
  rail.style.display = 'flex';
  scheduleBookWarmup(candidates[0]);
}

function smartBook(entry, subtitle) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'smart-book';
  item.innerHTML = `<strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(subtitle || entry.author || 'Unknown author')}</span>`;
  item.onclick = () => openBook(entry.id);
  return item;
}

function renderSmartSections(searchQuery, filterValue) {
  const root = document.getElementById('smart-sections');
  root.replaceChildren();
  if (searchQuery || filterValue !== 'all' || !library.length) { root.style.display = 'none'; return; }
  const sections = [];
  sections.push(['Recently added', [...library].sort((a,b) => b.addedAt - a.addedAt).slice(0,8), entry => entry.author]);
  const unread = library.filter(entry => entry.progress === 0).slice(0,8);
  if (unread.length) sections.push(['Unread', unread, entry => entry.author]);
  const finished = library.filter(entry => entry.progress >= 98).slice(0,8);
  if (finished.length) sections.push(['Finished', finished, entry => entry.author]);
  const series = new Map();
  library.filter(entry => entry.series).forEach(entry => {
    if (!series.has(entry.series)) series.set(entry.series, []);
    series.get(entry.series).push(entry);
  });
  if (series.size) {
    const seriesEntries = [...series.entries()].slice(0,8).map(([name, entries]) => ({ ...entries[0], name, __subtitle: `${entries.length} book${entries.length === 1 ? '' : 's'}` }));
    sections.splice(1, 0, ['Your series', seriesEntries, entry => entry.__subtitle]);
  }
  for (const [title, entries, subtitle] of sections) {
    if (!entries.length) continue;
    const section = document.createElement('section');
    section.className = 'smart-section';
    const heading = document.createElement('h3'); heading.textContent = title;
    const rail = document.createElement('div'); rail.className = 'smart-rail';
    entries.forEach(entry => rail.appendChild(smartBook(entry, subtitle(entry))));
    section.append(heading, rail); root.appendChild(section);
  }
  root.style.display = root.childElementCount ? 'grid' : 'none';
}

function createShelfCard(entry) {
  const card = document.createElement('article');
  card.className = `book-card${bulkMode ? ' bulk-mode' : ''}${bulkSelection.has(entry.id) ? ' selected' : ''}`;
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${entry.name} by ${entry.author || 'Unknown author'}`);
  const seriesBadge = entry.series ? `<div class="series-tag">${escapeHtml(formatSeriesText(entry.series, entry.seriesIndex))}</div>` : '';
  card.innerHTML = `${bulkMode ? `<input class="book-select" type="checkbox" aria-label="Select ${escapeHtml(entry.name)}" ${bulkSelection.has(entry.id) ? 'checked' : ''}>` : ''}<div class="spine" style="background:${entry.coverColor}">${coverMarkup(entry)}${entry.progress > 0 ? `<span class="spine-badge">${Math.round(entry.progress)}%</span>` : ''}<button type="button" class="book-menu-btn" aria-label="Details and actions for ${escapeHtml(entry.name)}">⋯</button></div><div class="book-meta-under">${seriesBadge}<div class="title" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div><div class="author">${escapeHtml(entry.author || 'Unknown')}</div><div class="shelf-rating-widget">${renderRatingHtml(entry.id, entry.rating)}</div><div class="book-progress-bar"><div class="book-progress-fill" style="width:${entry.progress}%"></div></div></div>`;
  const activate = event => {
    if (event.target.closest('.book-menu-btn,.star-btn')) return;
    if (bulkMode) {
      bulkSelection.has(entry.id) ? bulkSelection.delete(entry.id) : bulkSelection.add(entry.id);
      updateBulkToolbar(); renderShelf();
    } else openBook(entry.id);
  };
  card.onclick = activate;
  card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); } };
  card.querySelector('.book-menu-btn').onclick = event => { event.stopPropagation(); openBookDetails(entry.id); };
  return card;
}

function renderShelf(){
  const shelf = document.getElementById('shelf');
  shelf.classList.toggle('compact', document.getElementById('shelf-density')?.value === 'compact');
  const empty = document.getElementById('shelf-empty');
  const header = document.getElementById('shelf-header');
  shelf.replaceChildren();
  renderContinueCard();
  if (!library.length) {
    empty.style.display = 'block'; header.style.display = 'none'; document.getElementById('continue-card').style.display = 'none'; document.getElementById('smart-sections').style.display = 'none'; return;
  }
  empty.style.display = 'none'; header.style.display = 'flex';
  const searchQuery = document.getElementById('shelf-search').value.trim().toLocaleLowerCase();
  const filterValue = document.getElementById('shelf-filter').value;
  const searchable = entry => `${entry.name || ''} ${entry.author || ''} ${entry.series || ''} ${entry.description || ''} ${entry.tags || ''} ${entry.isbn || ''}`.toLocaleLowerCase();
  let filtered = searchQuery ? library.filter(entry => searchable(entry).includes(searchQuery)) : [...library];
  if (filterValue === 'unread') filtered = filtered.filter(entry => entry.progress === 0);
  else if (filterValue === 'finished') filtered = filtered.filter(entry => entry.progress >= 98);
  else if (filterValue.startsWith('col_')) {
    const collection = allCollections.find(item => item.id === filterValue.slice(4));
    if (collection) filtered = filtered.filter(entry => collection.book_ids.includes(entry.id));
  }
  const sortValue = document.getElementById('shelf-sort').value;
  filtered.sort((a,b) => {
    if (sortValue === 'opened') return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
    if (sortValue === 'title') return a.name.localeCompare(b.name);
    if (sortValue === 'author') return (a.author || '').localeCompare(b.author || '');
    if (sortValue === 'progress') return b.progress - a.progress;
    if (sortValue === 'series') return (a.series || '\uffff').localeCompare(b.series || '\uffff') || (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0);
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  document.getElementById('shelf-count').textContent = filtered.length === library.length ? `${library.length} book${library.length === 1 ? '' : 's'}` : `${filtered.length} of ${library.length} books`;
  renderSmartSections(searchQuery, filterValue);
  const fragment = document.createDocumentFragment();
  filtered.forEach(entry => fragment.appendChild(createShelfCard(entry)));
  shelf.appendChild(fragment);
  saveShelfPreferences();
}

function toggleReaderMoreMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('reader-more-menu');
  const button = document.getElementById('reader-more-btn');
  menu.hidden = !menu.hidden;
  button?.setAttribute('aria-expanded', String(!menu.hidden));
}

function toggleBulkMode(force) {
  bulkMode = typeof force === 'boolean' ? force : !bulkMode;
  if (!bulkMode) bulkSelection.clear();
  updateBulkToolbar(); renderShelf();
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulk-toolbar');
  toolbar.hidden = !bulkMode;
  document.getElementById('bulk-count').textContent = `${bulkSelection.size} selected`;
  updateRoleAwareControls();
}

async function downloadBookOffline(id) {
  setSyncState('saving', 'Downloading…');
  const [fileResponse, coverResponse] = await Promise.all([
    api.fetch(`/api/books/${id}/file`, { headers: {} }),
    api.fetch(`/api/books/${id}/cover`, { headers: {} }).catch(() => null),
  ]);
  // Fully consume the responses so the service worker can finish its cache put.
  await fileResponse.blob();
  if (coverResponse?.ok) await coverResponse.blob();
  setSyncState('saved', 'Available offline');
}

async function removeOfflineBook(id) {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map(async name => {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    await Promise.all(requests.filter(request => new URL(request.url).pathname.includes(`/api/books/${id}/`)).map(request => cache.delete(request)));
  }));
  showToast('Offline download removed.');
}

async function bulkDownloadOffline() {
  for (const id of bulkSelection) await downloadBookOffline(id);
  showToast(`${bulkSelection.size} book${bulkSelection.size === 1 ? '' : 's'} available offline.`); toggleBulkMode(false);
}

async function bulkAddToCollection() {
  if (!requireAdmin('organize books')) return;
  const name = prompt(`Collection name (${allCollections.map(item => item.name).join(', ')})`);
  if (!name) return;
  let collection = allCollections.find(item => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!collection) collection = await api.createCollection(name.trim());
  for (const id of bulkSelection) await api.addBookToCollection(id, collection.id);
  await loadCollections(); showToast('Books added to collection.'); toggleBulkMode(false);
}

async function bulkRemoveFromCollection() {
  if (!requireAdmin('organize books')) return;
  const name = prompt(`Remove from collection (${allCollections.map(item => item.name).join(', ')})`);
  if (!name) return;
  const collection = allCollections.find(item => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!collection) { showToast('Collection not found.'); return; }
  for (const id of bulkSelection) await api.removeBookFromCollection(id, collection.id);
  await loadCollections(); showToast('Books removed from collection.'); toggleBulkMode(false);
}

async function bulkEditSeries() {
  if (!requireAdmin('edit shared book metadata')) return;
  const series = prompt('Series name (leave blank to clear)');
  if (series == null) return;
  const ordered = [...bulkSelection].map(id => library.find(entry => entry.id === id)).filter(Boolean);
  const startText = series.trim() ? prompt('Starting series number (optional; increments in shelf order)', '') : '';
  if (startText == null) return;
  const parsedStart = startText.trim() === '' ? null : Number(startText);
  if (parsedStart != null && !Number.isFinite(parsedStart)) { showToast('Series number must be numeric.'); return; }
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    const updated = await api.updateBook(entry.id, {
      series: series.trim() || null,
      series_index: parsedStart == null ? null : parsedStart + index,
    });
    entry.series = updated.series || '';
    entry.seriesIndex = updated.series_index;
  }
  showToast('Series details updated.'); toggleBulkMode(false); renderShelf();
}

async function bulkDeleteBooks() {
  if (!requireAdmin('remove books')) return;
  const confirmed = await showConfirmDialog({ title: 'Remove selected books', message: `Remove ${bulkSelection.size} selected books and their reading data?`, confirmText: 'Remove books', danger: true });
  if (!confirmed) return;
  for (const id of [...bulkSelection]) await api.deleteBook(id);
  library = library.filter(entry => !bulkSelection.has(entry.id)); showToast('Selected books removed.'); toggleBulkMode(false);
}

async function openBookDetails(id) {
  const entry = library.find(item => item.id === id);
  if (!entry) return;
  const modal = document.getElementById('book-details-modal');
  document.getElementById('book-details-title').textContent = entry.name;
  document.getElementById('book-details-content').innerHTML = `<div class="book-details-layout"><div class="book-details-cover" style="background:${entry.coverColor}">${coverMarkup(entry, 'book-details-cover')}</div><div><div class="book-detail-meta">${escapeHtml(entry.author || 'Unknown author')}<br>${entry.series ? escapeHtml(formatSeriesText(entry.series, entry.seriesIndex)) + '<br>' : ''}${(entry.fileSize / 1024 / 1024).toFixed(1)} MB · about ${formatMinutes(estimatedBookMinutes(entry))}<br>${entry.progress ? `${Math.round(entry.progress)}% read · ${formatMinutes(estimatedBookMinutes(entry, true))} remaining` : 'Unread'}${entry.isbn ? `<br>ISBN ${escapeHtml(entry.isbn)}` : ''}${entry.tags ? `<br>${escapeHtml(entry.tags)}` : ''}</div><p class="book-description">${escapeHtml(entry.description || 'No description available.')}</p></div></div>`;
  const actions = document.getElementById('book-details-actions');
  actions.innerHTML = `<button type="button" onclick="closeBookDetails(); openBook('${id}')">${entry.progress ? 'Continue reading' : 'Read'}</button><button type="button" onclick="downloadBookOffline('${id}').then(()=>showToast('Book is available offline.'))">Download for offline</button><button type="button" onclick="removeOfflineBook('${id}')">Remove download</button>${isCurrentUserAdmin() ? `<button type="button" onclick="openBookCollectionsModal('${id}')">Collections</button><button type="button" onclick="editBookMetadata('${id}')">Edit details</button><button type="button" onclick="closeBookDetails(); removeBook('${id}')">Remove book</button>` : ''}`;
  modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); modal.querySelector('button')?.focus();
}

function closeBookDetails() { const modal = document.getElementById('book-details-modal'); modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }

async function editBookMetadata(id) {
  const entry = library.find(item => item.id === id); if (!entry) return;
  const title = prompt('Title', entry.name); if (title == null) return;
  const author = prompt('Author', entry.author || ''); if (author == null) return;
  const description = prompt('Description', entry.description || ''); if (description == null) return;
  const tags = prompt('Tags', entry.tags || ''); if (tags == null) return;
  const updated = await api.updateBook(id, { title, author, description, tags });
  Object.assign(entry, { name: updated.title, author: updated.author, description: updated.description || '', tags: updated.tags || '' });
  closeBookDetails(); renderShelf(); showToast('Book details updated.');
}

async function openNotebookModal() {
  const modal = document.getElementById('notebook-modal'); modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false');
  notebookItems = await api.getAllHighlights(); notebookTagFilter = ''; renderNotebook(); document.getElementById('notebook-search').focus();
}

function closeNotebookModal() { const modal = document.getElementById('notebook-modal'); modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }

function renderNotebook() {
  const query = (document.getElementById('notebook-search')?.value || '').trim().toLocaleLowerCase();
  const tags = [...new Set(notebookItems.flatMap(item => item.tags || []))].sort();
  document.getElementById('notebook-tags').innerHTML = tags.map(tag => `<button class="tag-chip" type="button" onclick="notebookTagFilter='${escapeHtml(tag)}'; renderNotebook()">#${escapeHtml(tag)}</button>`).join('');
  const filtered = notebookItems.filter(item => (!query || `${item.excerpt || ''} ${item.note || ''} ${item.book_title || ''} ${(item.tags || []).join(' ')}`.toLocaleLowerCase().includes(query)) && (!notebookTagFilter || (item.tags || []).includes(notebookTagFilter)));
  document.getElementById('notebook-list').innerHTML = filtered.length ? filtered.map(item => `<article class="notebook-item"><small>${escapeHtml(item.book_title)} · ${escapeHtml(item.chapter || '')}</small><blockquote>${escapeHtml(item.excerpt || '')}</blockquote>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}<div>${(item.tags || []).map(tag => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join(' ')} <button class="file-link-btn" onclick="editHighlightTags('${item.id}')">Edit tags</button> <button class="file-link-btn" onclick="closeNotebookModal(); openBook('${item.book_id}')">Open</button></div></article>`).join('') : '<p class="bookmark-empty">No matching highlights.</p>';
}

async function editHighlightTags(id) {
  const item = notebookItems.find(value => value.id === id); if (!item) return;
  const value = prompt('Comma-separated tags', (item.tags || []).join(', ')); if (value == null) return;
  const updated = await api.updateHighlight(id, { tags: value.split(',') }); item.tags = updated.tags || []; renderNotebook();
}

function selectionText() { return pendingHighlightContext?.excerpt || ''; }
async function copySelectionText() { const text = selectionText(); if (text) await navigator.clipboard.writeText(text); hideHighlightPopup(); showToast('Copied selection.'); }
async function shareSelectionText() { const text = selectionText(); if (!text) return; if (navigator.share) await navigator.share({ text }); else await navigator.clipboard.writeText(text); hideHighlightPopup(); }
function lookupSelectedWord() { const word = selectionText().trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, ''); hideHighlightPopup(); if (word) lookupDictionary(word, window.innerWidth / 2, 100); }
async function addNoteToSelection() {
  const context = pendingHighlightContext; if (!context) return;
  const note = prompt('Add a note'); if (note == null) return;
  const saved = await resilientApiPost(`/api/books/${context.entry.id}/highlights`, { cfi_range: context.cfi, color: '#F2D94E', excerpt: context.excerpt, note, chapter: '' }, false, 'POST', context.requestOptions);
  context.entry.highlights.push({ id: saved.id, cfi: context.cfi, color: '#F2D94E', excerpt: context.excerpt, note, tags: [] });
  try { context.targetRendition.annotations.add('highlight', context.cfi, {}, null, 'epub-highlight', highlightStyle('#F2D94E')); } catch (_) {}
  finishPendingHighlight(context); renderHighlights();
}

function updateGestureSettings() {
  settings.gestures = { swipe: document.getElementById('gesture-swipe').checked, edge: document.getElementById('gesture-edge').checked, center: document.getElementById('gesture-center').checked };
  saveSettings();
}

function syncGestureSettingsUI() {
  const gestures = settings.gestures || {};
  if (document.getElementById('gesture-swipe')) document.getElementById('gesture-swipe').checked = gestures.swipe !== false;
  if (document.getElementById('gesture-edge')) document.getElementById('gesture-edge').checked = gestures.edge !== false;
  if (document.getElementById('gesture-center')) document.getElementById('gesture-center').checked = gestures.center !== false;
}

function updateProgressEstimate() {
  const entry = getCurrentEntry(); const target = document.getElementById('progress-remaining');
  if (entry && target) target.textContent = `${formatMinutes(estimatedBookMinutes(entry, true))} left`;
}

function populateTtsVoices() {
  const select = document.getElementById('tts-voice-select'); if (!select || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices(); select.replaceChildren(...voices.map(voice => new Option(`${voice.name} (${voice.lang})`, voice.voiceURI, false, voice.voiceURI === ttsVoiceURI)));
}

function applyAppUpdate() { window.__pendingServiceWorker?.postMessage({ type: 'SKIP_WAITING' }); }
function dismissInstallTip() { localStorage.setItem('endpaper_install_tip_dismissed', '1'); document.getElementById('install-tip').hidden = true; }

async function saveReadingGoals() {
  const goals = { dailyMinutes: Number(document.getElementById('goal-daily').value) || 0, weeklyHours: Number(document.getElementById('goal-weekly').value) || 0, booksPerYear: Number(document.getElementById('goal-books').value) || 0 };
  await api.saveSettings({ 'reading-goals': goals }); showToast('Reading goals saved.');
}

document.getElementById('shelf-search')?.setAttribute('oninput', 'scheduleShelfRender()');
document.getElementById('shelf-filter')?.setAttribute('onchange', 'renderShelf()');
document.getElementById('shelf-sort')?.setAttribute('onchange', 'renderShelf()');
document.addEventListener('click', event => { if (!event.target.closest('#reader-more-menu,#reader-more-btn,#reader-bottom-actions')) { document.getElementById('reader-more-menu').hidden = true; document.getElementById('reader-more-btn')?.setAttribute('aria-expanded','false'); } });
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const modal = document.querySelector('.modal.show[aria-modal="true"]'); if (!modal) return;
  const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(item => !item.hidden);
  if (!focusable.length) return;
  if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
  else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
});

document.getElementById('tts-voice-select')?.addEventListener('change', event => { ttsVoiceURI = event.target.value; if (ttsQueue.length && !ttsIsPaused) speakCurrentTtsItem(); });
document.getElementById('tts-pitch')?.addEventListener('input', event => { ttsPitch = Number(event.target.value); if (ttsQueue.length && !ttsIsPaused) speakCurrentTtsItem(); });
document.getElementById('tts-sleep')?.addEventListener('change', event => { if (ttsSleepTimer) clearTimeout(ttsSleepTimer); const minutes = Number(event.target.value); if (minutes) ttsSleepTimer = setTimeout(() => { stopTts(); showToast('Sleep timer ended.'); }, minutes * 60_000); });
if ('speechSynthesis' in window) { populateTtsVoices(); speechSynthesis.addEventListener?.('voiceschanged', populateTtsVoices); }
new MutationObserver(updateProgressEstimate).observe(document.getElementById('progress-pct'), { childList: true, characterData: true, subtree: true });

window.addEventListener('load', () => {
  const isIosSafari = /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
  if (isIosSafari && !localStorage.getItem('endpaper_install_tip_dismissed')) document.getElementById('install-tip').hidden = false;
  restoreShelfPreferences(); syncGestureSettingsUI();
});

````

---

## File: `server/src/index.js`

*Relative Path: `server/src/index.js` | Size: 36.5 KB | Total Lines: 892*

````javascript
'use strict';

const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { isUuid, isBookFilename, isCoverFilename } = require('./lib/validation');

// Initialize database (runs schema migration on require)
const db = require('./db');

// ---------- Startup: clean stale tmp files ----------
const DATA_DIR = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
try {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const file of fs.readdirSync(TMP_DIR)) {
    const filePath = path.join(TMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > ONE_HOUR) {
        fs.unlinkSync(filePath);
      }
    } catch (e) { /* skip */ }
  }
} catch (e) { /* tmp dir may not exist yet */ }

// Middleware
const { authMiddleware } = require('./middleware/auth');
const { requireAdmin } = require('./routes/users');

// Routes
const authRoutes = require('./routes/auth');
const booksRoutes = require('./routes/books');
const bookmarksRoutes = require('./routes/bookmarks');
const highlightsRoutes = require('./routes/highlights');
const sessionsRoutes = require('./routes/sessions');
const collectionsRoutes = require('./routes/collections');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');

const app = express();
const trustProxyVal = process.env.TRUST_PROXY;
if (trustProxyVal !== undefined) {
  app.set('trust proxy', isNaN(Number(trustProxyVal)) ? (trustProxyVal === 'true' ? true : (trustProxyVal === 'false' ? false : trustProxyVal)) : Number(trustProxyVal));
} else {
  // Direct deployments must not trust spoofable forwarding headers. The
  // supplied Docker/Caddy deployment sets TRUST_PROXY=1 explicitly.
  app.set('trust proxy', false);
}
const PORT = process.env.PORT || 3001;
const MAX_IMPORT_BYTES = Math.min(Math.max(Number(process.env.IMPORT_MAX_BYTES) || 500 * 1024 * 1024, 1), 2 * 1024 * 1024 * 1024);
const MAX_IMPORT_ENTRIES = 5000;

app.disable('x-powered-by');

// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Request logging
app.use(pinoHttp({ 
  logger, 
  autoLogging: { ignore: req => req.url.startsWith('/healthz') } 
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://api.dictionaryapi.dev; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Useful for container orchestrators and intentionally unauthenticated so a
// reverse proxy can tell a sleeping process from a logged-out user.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Auth middleware on all /api/* routes (auth route handler skips /api/login internally)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', authMiddleware);

// Deduplicate replayed offline writes after an uncertain network outcome.
// The frontend sends a stable UUID for every queued mutation.
app.use('/api', (req, res, next) => {
  if (!req.user_id || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const operationId = req.get('Idempotency-Key');
  if (!operationId) return next();
  if (!isUuid(operationId)) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
  const existing = db.prepare('SELECT response_json FROM client_operations WHERE user_id = ? AND operation_id = ?').get(req.user_id, operationId);
  if (existing) return res.json(existing.response_json ? JSON.parse(existing.response_json) : { ok: true, replayed: true });
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        db.prepare('INSERT OR IGNORE INTO client_operations (user_id, operation_id, response_json) VALUES (?, ?, ?)')
          .run(req.user_id, operationId, JSON.stringify(payload == null ? { ok: true } : payload));
      } catch (error) {
        logger.warn({ err: error }, 'Could not persist idempotency receipt');
      }
    }
    return originalJson(payload);
  };
  next();
});

// ---------- API Routes ----------
app.use(authRoutes);
app.use(booksRoutes);
app.use(bookmarksRoutes);
app.use(highlightsRoutes);
app.use(sessionsRoutes);
app.use(collectionsRoutes);
app.use(settingsRoutes);
app.use(usersRoutes);

// ---------- Export / Import endpoints ----------
const archiver = require('archiver');
const createZipArchive = (opts) => typeof archiver === 'function' ? archiver('zip', opts) : new archiver.ZipArchive(opts);

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function assertArray(value, name) {
  if (value !== undefined && !Array.isArray(value)) throw importError(`${name} must be an array`);
  return value || [];
}

const SETTING_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SENSITIVE_SETTING_KEYS = new Set(['passphrase_hash', 'session_token']);
const HIGHLIGHT_COLORS = new Set(['gold', '#F2D94E', '#8FD19E', '#8FC1E3', '#E8A0BF']);
const READING_STATUSES = new Set(['unread', 'reading', 'finished']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw importError(`Invalid ${name} in backup`);
  }
  return value;
}

function backupText(value, name, { required = false, max = 10000 } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw importError(`Invalid ${name} in backup`);
  }
  const normalized = value.trim();
  if (required && !normalized) throw importError(`Invalid ${name} in backup`);
  return normalized || null;
}

function backupNumber(value, name, {
  required = false,
  min = -Infinity,
  max = Infinity,
  integer = false,
  fallback = null,
} = {}) {
  if (value == null) {
    if (required) throw importError(`Invalid ${name} in backup`);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw importError(`Invalid ${name} in backup`);
  }
  return value;
}

function backupTimestamp(value, name, { required = false, fallback = null } = {}) {
  const timestamp = backupText(value, name, { required, max: 64 });
  if (timestamp == null) return fallback;
  if (Number.isNaN(Date.parse(timestamp))) throw importError(`Invalid ${name} in backup`);
  return new Date(timestamp).toISOString();
}

function optionalUserId(value, name) {
  if (value == null) return null;
  if (!isUuid(value)) throw importError(`Invalid ${name} in backup`);
  return value;
}

function assertUnique(values, key, name) {
  const seen = new Set();
  for (const value of values) {
    const item = key(value);
    if (seen.has(item)) throw importError(`Duplicate ${name} in backup`);
    seen.add(item);
  }
}

function normalizeBackupUser(value) {
  assertObject(value, 'user');
  if (!isUuid(value.id)) throw importError('Invalid user in backup');
  return { id: value.id, username: backupText(value.username, 'username', { required: true, max: 255 }) };
}

function normalizeBackupBook(value) {
  assertObject(value, 'book');
  if (!isUuid(value.id) || !isBookFilename(value.filename)) throw importError('Invalid book in backup');
  const fileFormat = backupText(value.file_format, 'book format', { max: 16 }) || 'epub';
  if (fileFormat.toLowerCase() !== 'epub') throw importError('Invalid book format in backup');
  if (value.cover_path != null && !isCoverFilename(value.cover_path)) throw importError('Invalid book cover in backup');

  return {
    id: value.id,
    title: backupText(value.title, 'book title', { required: true, max: 500 }),
    author: backupText(value.author, 'book author', { max: 500 }),
    series: backupText(value.series, 'book series', { max: 500 }),
    series_index: backupNumber(value.series_index, 'book series index', { min: -1_000_000, max: 1_000_000 }),
    description: backupText(value.description, 'book description', { max: 5000 }),
    isbn: backupText(value.isbn, 'book ISBN', { max: 500 }),
    tags: backupText(value.tags, 'book tags', { max: 500 }),
    filename: value.filename,
    file_format: 'epub',
    file_size: backupNumber(value.file_size, 'book file size', { min: 0, max: MAX_IMPORT_BYTES, integer: true }),
    cover_path: value.cover_path || null,
    cover_color: backupText(value.cover_color, 'book cover color', { max: 32 }),
    added_at: backupTimestamp(value.added_at, 'book added time', { fallback: new Date().toISOString() }),
  };
}

function normalizeUserBook(value) {
  assertObject(value, 'user_book');
  if (!isUuid(value.book_id)) throw importError('Invalid user_book in backup');
  const status = backupText(value.status, 'book status', { max: 16 }) || 'unread';
  if (!READING_STATUSES.has(status)) throw importError('Invalid book status in backup');
  return {
    user_id: optionalUserId(value.user_id, 'user_book user'),
    book_id: value.book_id,
    status,
    rating: backupNumber(value.rating, 'book rating', { min: 1, max: 5, integer: true }),
    progress_percent: backupNumber(value.progress_percent, 'book progress', { min: 0, max: 100, fallback: 0 }),
    last_location_cfi: backupText(value.last_location_cfi, 'book location', { max: 10000 }),
    last_opened_at: backupTimestamp(value.last_opened_at, 'book last-opened time'),
  };
}

function normalizeBookmark(value) {
  assertObject(value, 'bookmark');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid bookmark in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'bookmark user'),
    book_id: value.book_id,
    cfi: backupText(value.cfi, 'bookmark CFI', { required: true, max: 10000 }),
    label: backupText(value.label, 'bookmark label', { max: 500 }),
    chapter: backupText(value.chapter, 'bookmark chapter', { max: 500 }),
    progress_percent: backupNumber(value.progress_percent, 'bookmark progress', { min: 0, max: 100, fallback: 0 }),
    created_at: backupTimestamp(value.created_at, 'bookmark created time', { fallback: new Date().toISOString() }),
  };
}

function normalizeHighlight(value) {
  assertObject(value, 'highlight');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid highlight in backup');
  const color = backupText(value.color, 'highlight color', { max: 16 }) || 'gold';
  if (!HIGHLIGHT_COLORS.has(color)) throw importError('Invalid highlight color in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'highlight user'),
    book_id: value.book_id,
    cfi_range: backupText(value.cfi_range, 'highlight CFI', { required: true, max: 10000 }),
    excerpt: backupText(value.excerpt, 'highlight excerpt', { max: 1000 }),
    note: backupText(value.note, 'highlight note', { max: 2000 }),
    color,
    chapter: backupText(value.chapter, 'highlight chapter', { max: 500 }),
    tags: backupText(value.tags, 'highlight tags', { max: 2000 }),
    created_at: backupTimestamp(value.created_at, 'highlight created time', { fallback: new Date().toISOString() }),
  };
}

function normalizeReadingSession(value) {
  assertObject(value, 'reading session');
  if (!isUuid(value.id) || !isUuid(value.book_id)) throw importError('Invalid reading session in backup');
  return {
    id: value.id,
    user_id: optionalUserId(value.user_id, 'reading session user'),
    book_id: value.book_id,
    started_at: backupTimestamp(value.started_at, 'session start time', { required: true }),
    ended_at: backupTimestamp(value.ended_at, 'session end time'),
    duration_seconds: backupNumber(value.duration_seconds, 'session duration', { min: 0, max: 2_147_483_647, integer: true }),
    client_id: backupText(value.client_id, 'session client', { max: 100 }),
  };
}

function normalizeCollection(value) {
  assertObject(value, 'collection');
  if (!isUuid(value.id)) throw importError('Invalid collection in backup');
  return { id: value.id, name: backupText(value.name, 'collection name', { required: true, max: 80 }) };
}

function normalizeBookCollection(value) {
  assertObject(value, 'collection membership');
  if (!isUuid(value.book_id) || !isUuid(value.collection_id)) {
    throw importError('Invalid collection membership in backup');
  }
  return { book_id: value.book_id, collection_id: value.collection_id };
}

function normalizeSetting(value) {
  assertObject(value, 'setting');
  const key = backupText(value.key, 'setting key', { required: true, max: 80 });
  if (!SETTING_KEY_RE.test(key) || typeof value.value !== 'string' || value.value.length > 100_000) {
    throw importError('Invalid setting in backup');
  }
  return { user_id: optionalUserId(value.user_id, 'setting user'), key, value: value.value };
}

function validateBackupDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw importError('Backup database is invalid');
  const users = assertArray(dump.users, 'users').map(normalizeBackupUser);
  const userBooks = assertArray(dump.user_books, 'user_books').map(normalizeUserBook);
  const books = assertArray(dump.books, 'books').map(normalizeBackupBook);
  const bookmarks = assertArray(dump.bookmarks, 'bookmarks').map(normalizeBookmark);
  const highlights = assertArray(dump.highlights, 'highlights').map(normalizeHighlight);
  const sessions = assertArray(dump.reading_sessions, 'reading_sessions').map(normalizeReadingSession);
  const collections = assertArray(dump.collections, 'collections').map(normalizeCollection);
  const bookCollections = assertArray(dump.book_collections, 'book_collections').map(normalizeBookCollection);
  const settings = assertArray(dump.settings, 'settings').map(normalizeSetting);

  assertUnique(users, user => user.id, 'user ID');
  assertUnique(users, user => user.username, 'username');
  assertUnique(books, book => book.id, 'book ID');
  assertUnique(books, book => book.filename, 'book filename');
  assertUnique(bookmarks, bookmark => bookmark.id, 'bookmark ID');
  assertUnique(highlights, highlight => highlight.id, 'highlight ID');
  assertUnique(sessions, session => session.id, 'reading session ID');
  assertUnique(collections, collection => collection.id, 'collection ID');
  assertUnique(collections, collection => collection.name.toLowerCase(), 'collection name');
  assertUnique(bookCollections, membership => `${membership.book_id}:${membership.collection_id}`, 'collection membership');
  assertUnique(userBooks, row => `${row.user_id || 'missing'}:${row.book_id}`, 'user book');
  assertUnique(settings, row => `${row.user_id || 'missing'}:${row.key}`, 'setting');

  const bookIds = new Set(books.map(book => book.id));
  const collectionIds = new Set(collections.map(collection => collection.id));
  for (const membership of bookCollections) {
    if (!bookIds.has(membership.book_id) || !collectionIds.has(membership.collection_id)) {
      throw importError('Collection membership references a missing book or collection');
    }
  }

  return { users, userBooks, books, bookmarks, highlights, sessions, collections, bookCollections, settings };
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function validateArchiveAssets(files, backup, booksDir, coversDir) {
  const archiveFiles = new Map(files.map(file => [`${file.directory}/${file.filename}`, file]));
  const expectedAssets = new Set();

  for (const book of backup.books) {
    const bookKey = `books/${book.filename}`;
    const archivedBook = archiveFiles.get(bookKey);
    expectedAssets.add(bookKey);
    if (!archivedBook && !isRegularFile(path.join(booksDir, book.filename))) {
      throw importError(`Backup is missing the EPUB for "${book.title}"`);
    }
    if (archivedBook && book.file_size != null && archivedBook.size !== book.file_size) {
      throw importError(`Backup EPUB size does not match metadata for "${book.title}"`);
    }

    if (book.cover_path) {
      const coverKey = `covers/${book.cover_path}`;
      expectedAssets.add(coverKey);
      if (!archiveFiles.has(coverKey) && !isRegularFile(path.join(coversDir, book.cover_path))) {
        throw importError(`Backup is missing the cover for "${book.title}"`);
      }
    }
  }

  for (const file of files) {
    if (!expectedAssets.has(`${file.directory}/${file.filename}`)) {
      throw importError('Backup contains an unreferenced library asset');
    }
  }
}

function addLibraryAsset(archive, assetDir, filename, seenAssets) {
  const assetPath = path.join(DATA_DIR, assetDir, filename);
  if (!isRegularFile(assetPath)) {
    throw new Error(`Cannot export: library asset ${assetDir}/${filename} is missing`);
  }
  const assetKey = `${assetDir}/${filename}`;
  if (!seenAssets.has(assetKey)) {
    archive.file(assetPath, { name: `${assetDir}/${filename}` });
    seenAssets.add(assetKey);
  }
}

function createUserIdMap(backupUsers) {
  // Only match identities that already exist locally. Import never inserts a
  // user or accepts a password hash/admin flag from a backup.
  const localUsers = new Map(
    db.prepare('SELECT id, username FROM users').all().map(user => [user.username, user.id])
  );
  const userIds = new Map();
  let unmatchedUsers = 0;
  for (const user of backupUsers) {
    const localUserId = localUsers.get(user.username);
    if (localUserId) userIds.set(user.id, localUserId);
    else unmatchedUsers++;
  }
  return { userIds, unmatchedUsers };
}

function importBackupData(backup, backupUserIds, unmatchedUsers) {
  const insertBook = db.prepare(`
    INSERT INTO books (id, title, author, series, series_index, description, isbn, tags, filename, file_format,
                       file_size, cover_path, cover_color, added_at)
    VALUES (@id, @title, @author, @series, @series_index, @description, @isbn, @tags, @filename, @file_format,
            @file_size, @cover_path, @cover_color, @added_at)
  `);
  const getBookById = db.prepare('SELECT id, filename FROM books WHERE id = ?');
  const getBookByFilename = db.prepare('SELECT id FROM books WHERE filename = ?');
  const insertCollection = db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)');
  const getCollectionById = db.prepare('SELECT id, name FROM collections WHERE id = ?');
  const getCollectionByName = db.prepare('SELECT id, name FROM collections WHERE lower(name) = lower(?)');
  const insertBookCollection = db.prepare(`
    INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)
  `);
  const listBookIds = db.prepare('SELECT id FROM books');
  const insertUserBook = db.prepare(`
    INSERT INTO user_books (user_id, book_id, status, rating, progress_percent, last_location_cfi, last_opened_at)
    VALUES (@user_id, @book_id, @status, @rating, @progress_percent, @last_location_cfi, @last_opened_at)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      status = excluded.status,
      rating = excluded.rating,
      progress_percent = excluded.progress_percent,
      last_location_cfi = excluded.last_location_cfi,
      last_opened_at = excluded.last_opened_at
    WHERE excluded.last_opened_at > user_books.last_opened_at OR user_books.last_opened_at IS NULL
  `);
  const insertBookmark = db.prepare(`
    INSERT OR IGNORE INTO bookmarks (id, user_id, book_id, cfi, label, chapter, progress_percent, created_at)
    VALUES (@id, @user_id, @book_id, @cfi, @label, @chapter, @progress_percent, @created_at)
  `);
  const insertHighlight = db.prepare(`
    INSERT OR IGNORE INTO highlights (id, user_id, book_id, cfi_range, excerpt, note, color, chapter, tags, created_at)
    VALUES (@id, @user_id, @book_id, @cfi_range, @excerpt, @note, @color, @chapter, @tags, @created_at)
  `);
  const insertReadingSession = db.prepare(`
    INSERT OR IGNORE INTO reading_sessions (id, user_id, book_id, started_at, ended_at, duration_seconds, client_id)
    VALUES (@id, @user_id, @book_id, @started_at, @ended_at, @duration_seconds, @client_id)
  `);
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (@user_id, @key, @value)
  `);

  return db.transaction(() => {
    const imported = {
      books: 0,
      collections: 0,
      book_collections: 0,
      user_books: 0,
      bookmarks: 0,
      highlights: 0,
      reading_sessions: 0,
      settings: 0,
    };
    const skipped = {
      users: unmatchedUsers,
      user_books: 0,
      bookmarks: 0,
      highlights: 0,
      reading_sessions: 0,
      settings: 0,
    };

    for (const book of backup.books) {
      const existingById = getBookById.get(book.id);
      const existingByFilename = getBookByFilename.get(book.filename);
      if (existingById && existingById.filename !== book.filename) {
        throw importError('Backup book ID conflicts with an existing library book');
      }
      if (existingByFilename && existingByFilename.id !== book.id) {
        throw importError('Backup book file conflicts with an existing library book');
      }
      if (!existingById) imported.books += insertBook.run(book).changes;
    }

    const collectionIds = new Map();
    for (const collection of backup.collections) {
      const existingById = getCollectionById.get(collection.id);
      const existingByName = getCollectionByName.get(collection.name);
      if (existingById && existingById.name.toLowerCase() !== collection.name.toLowerCase()) {
        throw importError('Backup collection ID conflicts with an existing collection');
      }
      if (existingById && existingByName && existingById.id !== existingByName.id) {
        throw importError('Backup collection conflicts with existing collection identities');
      }
      if (existingById) {
        collectionIds.set(collection.id, existingById.id);
      } else if (existingByName) {
        collectionIds.set(collection.id, existingByName.id);
      } else {
        imported.collections += insertCollection.run(collection.id, collection.name).changes;
        collectionIds.set(collection.id, collection.id);
      }
    }

    for (const membership of backup.bookCollections) {
      imported.book_collections += insertBookCollection.run(
        membership.book_id,
        collectionIds.get(membership.collection_id)
      ).changes;
    }

    const localBookIds = new Set(listBookIds.all().map(book => book.id));
    const mappedPrivateRow = (row, section, requiresBook = true) => {
      const localUserId = row.user_id && backupUserIds.get(row.user_id);
      if (!localUserId || (requiresBook && !localBookIds.has(row.book_id))) {
        skipped[section]++;
        return null;
      }
      return { ...row, user_id: localUserId };
    };

    for (const row of backup.userBooks) {
      const mapped = mappedPrivateRow(row, 'user_books');
      if (mapped) imported.user_books += insertUserBook.run(mapped).changes;
    }
    for (const row of backup.bookmarks) {
      const mapped = mappedPrivateRow(row, 'bookmarks');
      if (mapped) imported.bookmarks += insertBookmark.run(mapped).changes;
    }
    for (const row of backup.highlights) {
      const mapped = mappedPrivateRow(row, 'highlights');
      if (mapped) imported.highlights += insertHighlight.run(mapped).changes;
    }
    for (const row of backup.sessions) {
      const mapped = mappedPrivateRow(row, 'reading_sessions');
      if (mapped) imported.reading_sessions += insertReadingSession.run(mapped).changes;
    }
    for (const row of backup.settings) {
      if (SENSITIVE_SETTING_KEYS.has(row.key)) {
        skipped.settings++;
        continue;
      }
      const mapped = mappedPrivateRow(row, 'settings', false);
      if (mapped) imported.settings += insertSetting.run(mapped).changes;
    }

    return { imported, skipped };
  })();
}

/**
 * POST /api/export
 * Streams a zip of the shared library plus user data. User records intentionally contain
 * identities only, so passphrase hashes, roles, and auth sessions never leave
 * this server.
 */
app.all('/api/export', requireAdmin, (req, res) => {
  try {
    const books = db.prepare('SELECT * FROM books').all();

    // Pre-flight validation: ensure all referenced book and cover files exist before streaming
    for (const book of books) {
      const bookPath = path.join(DATA_DIR, 'books', book.filename);
      if (!isRegularFile(bookPath)) {
        return res.status(500).json({
          error: `Cannot export: book file for "${book.title || book.id}" (${book.filename}) is missing on disk`
        });
      }
      if (book.cover_path) {
        const coverPath = path.join(DATA_DIR, 'covers', book.cover_path);
        if (!isRegularFile(coverPath)) {
          return res.status(500).json({
            error: `Cannot export: cover file for "${book.title || book.id}" (${book.cover_path}) is missing on disk`
          });
        }
      }
    }

    const filename = `endpaper-backup-${new Date().toISOString().slice(0, 10)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = createZipArchive({ zlib: { level: 9 } });

    archive.on('error', (err) => {
      logger.error('Export archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Export failed' });
      } else {
        res.destroy(err);
      }
    });

    archive.pipe(res);

    const exportedAssets = new Set();
    for (const book of books) {
      addLibraryAsset(archive, 'books', book.filename, exportedAssets);
      if (book.cover_path) addLibraryAsset(archive, 'covers', book.cover_path, exportedAssets);
    }

    const dump = {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      // Identity mapping is used on import; never export a hash or role.
      users: db.prepare('SELECT id, username FROM users').all(),
      user_books: db.prepare('SELECT * FROM user_books').all(),
      books,
      bookmarks: db.prepare('SELECT * FROM bookmarks').all(),
      highlights: db.prepare('SELECT * FROM highlights').all(),
      reading_sessions: db.prepare('SELECT * FROM reading_sessions').all(),
      collections: db.prepare('SELECT * FROM collections').all(),
      book_collections: db.prepare('SELECT * FROM book_collections').all(),
      settings: db.prepare(`
        SELECT user_id, key, value
        FROM settings
        WHERE key NOT IN ('passphrase_hash', 'session_token')
      `).all(),
    };
    archive.append(JSON.stringify(dump, null, 2), { name: 'database.json' });
    archive.finalize();
  } catch (err) {
    logger.error('Export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    } else {
      res.destroy(err);
    }
  }
});

/**
 * POST /api/import
 * Accepts a zip file (from /api/export) and restores the shared library. User
 * state is restored only for matching, pre-existing local usernames.
 */
const multer = require('multer');
const yauzl = require('yauzl');
const importUpload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) return callback(importError('Only .zip backup files are allowed'));
    callback(null, true);
  },
});

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = new Map();
      let totalBytes = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        reject(error);
      };
      zipfile.on('entry', entry => {
        totalBytes += entry.uncompressedSize || 0;
        if (entries.size + 1 > MAX_IMPORT_ENTRIES) return fail(importError('Backup contains too many files'));
        if (totalBytes > MAX_IMPORT_BYTES) return fail(importError('Backup is too large to import'));
        const ratio = (entry.uncompressedSize || 0) / Math.max(1, entry.compressedSize || 0);
        if (ratio > 200) return fail(importError('Backup contains an unsafe compressed entry'));
        entries.set(entry.fileName, entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ zipfile, entries });
      });
      zipfile.on('error', fail);
      zipfile.readEntry();
    });
  });
}

function readEntry(zipfile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) return reject(new Error('Entry too large'));
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const chunks = [];
      readStream.on('data', chunk => chunks.push(chunk));
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function streamEntryToFile(zipfile, entry, destination, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) return reject(importError('Backup entry is too large'));
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) return reject(error);
      let observed = 0;
      const writeStream = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      const fail = failure => {
        readStream.destroy();
        writeStream.destroy();
        fs.promises.unlink(destination).catch(() => {}).finally(() => reject(failure));
      };
      readStream.on('data', chunk => {
        observed += chunk.length;
        if (observed > maxBytes || observed > entry.uncompressedSize + 1024) fail(importError('Backup entry exceeded its declared size'));
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    });
  });
}

app.post('/api/import', requireAdmin, importUpload.single('file'), async (req, res) => {
  let zipfile = null;
  let stageDir = null;
  const promotedFiles = [];
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const BOOKS_DIR = path.join(DATA_DIR, 'books');
    const COVERS_DIR = path.join(DATA_DIR, 'covers');
    
    const zipData = await openZip(req.file.path);
    zipfile = zipData.zipfile;
    const entries = zipData.entries;
    
    if (entries.size > MAX_IMPORT_ENTRIES) throw importError('Backup contains too many files');
    
    const dbEntry = entries.get('database.json');
    if (!dbEntry) throw importError('Backup is missing database.json');
    
    const dbData = await readEntry(zipfile, dbEntry, 10 * 1024 * 1024);
    let dump;
    try {
      dump = validateBackupDump(JSON.parse(dbData.toString('utf8')));
    } catch (err) {
      if (err.status) throw err;
      throw importError('Backup database is not valid JSON');
    }

    // Prepare files list
    const files = [];
    let totalSize = 0;
    for (const [name, entry] of entries.entries()) {
      if (entry.fileName === 'database.json' || entry.fileName.endsWith('/')) continue;
      
      const size = entry.uncompressedSize;
      totalSize += size;
      if (totalSize > MAX_IMPORT_BYTES) throw importError('Backup is too large to import');
      
      const bookMatch = /^books\/([0-9a-f-]+\.epub)$/i.exec(entry.fileName);
      const coverMatch = /^covers\/([0-9a-f-]+\.(?:jpe?g|png|gif|webp))$/i.exec(entry.fileName);
      if (bookMatch && isBookFilename(bookMatch[1])) files.push({ entry, directory: 'books', filename: bookMatch[1], size });
      else if (coverMatch && isCoverFilename(coverMatch[1])) files.push({ entry, directory: 'covers', filename: coverMatch[1], size });
      else throw importError('Backup contains an unsupported file');
    }

    validateArchiveAssets(files, dump, BOOKS_DIR, COVERS_DIR);
    const { userIds, unmatchedUsers } = createUserIdMap(dump.users);

    // Extract assets into an isolated stage first. No live library path is
    // modified until every archive entry has streamed and validated.
    stageDir = await fs.promises.mkdtemp(path.join(DATA_DIR, 'tmp', 'import-'));
    let restoredFiles = 0;
    for (const file of files) {
      const destination = path.join(file.directory === 'books' ? BOOKS_DIR : COVERS_DIR, file.filename);
      if (fs.existsSync(destination)) {
        if (!isRegularFile(destination)) throw importError('A local library asset is not a regular file');
        continue;
      }
      const stagedPath = path.join(stageDir, `${file.directory}-${file.filename}`);
      await streamEntryToFile(zipfile, file.entry, stagedPath, MAX_IMPORT_BYTES);
      file.stagedPath = stagedPath;
    }

    // Promote staged files with exclusive renames, then compensate if the DB
    // transaction fails. Existing files are deliberately left untouched.
    for (const file of files) {
      if (!file.stagedPath) continue;
      const destination = path.join(file.directory === 'books' ? BOOKS_DIR : COVERS_DIR, file.filename);
      if (fs.existsSync(destination)) continue;
      await fs.promises.rename(file.stagedPath, destination);
      promotedFiles.push(destination);
      restoredFiles++;
    }

    let results;
    try {
      results = importBackupData(dump, userIds, unmatchedUsers);
    } catch (error) {
      await Promise.all(promotedFiles.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
      throw error;
    }
    
    zipfile.close();
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    if (stageDir && path.resolve(stageDir).startsWith(path.resolve(path.join(DATA_DIR, 'tmp')) + path.sep)) {
      await fs.promises.rm(stageDir, { recursive: true, force: true });
      stageDir = null;
    }

    res.json({ ok: true, restored_files: restoredFiles, ...results });
  } catch (err) {
    if (zipfile) zipfile.close();
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (stageDir && path.resolve(stageDir).startsWith(path.resolve(path.join(DATA_DIR, 'tmp')) + path.sep)) {
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
    logger.error('Import error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Import failed' });
  }
});

// ---------- Static files (frontend) ----------
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback: serve index.html for any non-API route (Express 4 syntax; change to '/*splat' if upgrading to Express 5)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Keep errors from middleware (notably Multer) in the same JSON shape as the
// rest of the API instead of returning Express's default HTML error page.
app.use((err, req, res, next) => {
  logger.error('Request error:', err);
  if (res.headersSent) return next(err);
  const isUploadError = err instanceof multer.MulterError;
  const status = err.status || (isUploadError ? 400 : 500);
  const message = err.message === 'File too large'
    ? 'Uploaded file is too large'
    : (status < 500 ? err.message : 'Internal server error');
  res.status(status).json({ error: message });
});

// ---------- Start ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Endpaper server listening on http://0.0.0.0:${PORT}`);
});

// ---------- Graceful shutdown ----------
function gracefulShutdown(signal) {
  logger.info(`\\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      logger.info('Database closed and WAL checkpointed.');
    } catch (e) {
      logger.error('Error closing database:', e);
    }
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    logger.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

````

---

## File: `server/src/db.js`

*Relative Path: `server/src/db.js` | Size: 23.2 KB | Total Lines: 586*

````javascript
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'endpaper.db');

// Ensure data directories exist
fs.mkdirSync(path.join(DATA_DIR, 'books'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'covers'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enable foreign keys on every connection
db.pragma('foreign_keys = ON');
// Give concurrent readers and writers a chance to finish instead of failing immediately.
db.pragma('busy_timeout = 5000');

// Back up an existing database before the first structural change in this
// process. PRAGMA user_version is the ordered migration marker; older builds
// inferred state solely from columns, which made partial upgrades difficult to
// reason about and could mutate data before a safety copy existed.
const TARGET_SCHEMA_VERSION = 3;
const startingSchemaVersion = Number(db.pragma('user_version', { simple: true })) || 0;
const existingTableCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
if (existingTableCount > 0 && startingSchemaVersion < TARGET_SCHEMA_VERSION && fs.existsSync(DB_PATH)) {
  const earlyBackupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(earlyBackupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_PATH, path.join(earlyBackupDir, `endpaper-pre-migration-v${startingSchemaVersion}-to-v${TARGET_SCHEMA_VERSION}-${stamp}.db`));
}

// ---------- Schema migration ----------

// Check if we need to run the multi-user migration
const settingsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
let needsMigration = false;
let oldPassphrase = null;
let oldSession = null;

if (settingsTableExists) {
  oldPassphrase = db.prepare("SELECT value FROM settings WHERE key = 'passphrase_hash'").get();
  oldSession = db.prepare("SELECT value FROM settings WHERE key = 'session_token'").get();
  if (oldPassphrase) {
    needsMigration = true;
  }
}

if (needsMigration) {
  console.log("Migrating database to multi-user schema...");
  // 1. Add user_id column to existing tables. Guard each ALTER TABLE with a
  // column-existence check so this step is safe to re-run if the process is
  // killed after this point but before the data migration below commits —
  // otherwise a retry would hit "duplicate column name" and the app would
  // never start again.
  for (const table of ['bookmarks', 'highlights', 'reading_sessions']) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some(c => c.name === 'user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT;`);
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passphrase_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    series TEXT,
    series_index REAL,
    filename TEXT NOT NULL,
    file_format TEXT DEFAULT 'epub',
    file_size INTEGER,
    file_hash TEXT,
    cover_path TEXT,
    cover_color TEXT,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_books (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'unread',
    rating INTEGER,
    progress_percent REAL DEFAULT 0,
    last_location_cfi TEXT,
    last_opened_at TEXT,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    label TEXT,
    chapter TEXT,
    progress_percent REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi_range TEXT NOT NULL,
    excerpt TEXT,
    note TEXT,
    color TEXT DEFAULT 'gold',
    chapter TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    client_id TEXT
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS book_collections (
    book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
    collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, collection_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS client_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    response_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, operation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_books_user ON user_books(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_books_opened ON user_books(user_id, last_opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book_progress ON bookmarks(book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_book_created ON highlights(book_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON reading_sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON reading_sessions(ended_at);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user_book_progress ON bookmarks(user_id, book_id, progress_percent);
  CREATE INDEX IF NOT EXISTS idx_highlights_user_book_created ON highlights(user_id, book_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_book_started ON reading_sessions(user_id, book_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_client_operations_created ON client_operations(created_at);
`);

function addColumnIfMissing(table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  const columns = db.pragma(`table_info(${table})`);
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

addColumnIfMissing('books', 'description TEXT');
addColumnIfMissing('books', 'isbn TEXT');
addColumnIfMissing('books', 'tags TEXT');
addColumnIfMissing('highlights', 'tags TEXT');
addColumnIfMissing('reading_sessions', 'client_id TEXT');

// Authentication sessions are server-side records as well as browser cookies.
// Older databases did not record an expiry, so add and backfill the column
// before any route can validate a session. A NULL/invalid expiry is treated as
// expired below rather than leaving an indefinitely valid legacy token behind.
const sessionCols = db.pragma('table_info(sessions)');
if (!sessionCols.some(column => column.name === 'expires_at')) {
  console.log('Migrating sessions table to add server-side expiry...');
  db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT;');
}
db.prepare(`
  UPDATE sessions
  SET expires_at = datetime(COALESCE(created_at, CURRENT_TIMESTAMP), '+90 days')
  WHERE expires_at IS NULL OR datetime(expires_at) IS NULL
`).run();
db.prepare(`
  DELETE FROM sessions
  WHERE expires_at IS NULL
     OR datetime(expires_at) IS NULL
     OR datetime(expires_at) <= CURRENT_TIMESTAMP
`).run();
db.exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON sessions(expires_at);');

if (needsMigration) {
  const crypto = require('crypto');
  db.transaction(() => {
    const defaultUserId = crypto.randomUUID();
    // 1. Create admin user
    db.prepare("INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, 'admin', ?, 1)").run(defaultUserId, oldPassphrase.value);
    
    // 2. Migrate session
    if (oldSession) {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (token, user_id, expires_at)
        VALUES (?, ?, datetime('now', '+90 days'))
      `).run(oldSession.value, defaultUserId);
    }
    
    // 3. Migrate user books. Extract progress etc. from books.
    try {
      db.prepare(`
        INSERT INTO user_books (user_id, book_id, status, rating, progress_percent, last_location_cfi, last_opened_at)
        SELECT ?, id, status, rating, progress_percent, last_location_cfi, last_opened_at FROM books
      `).run(defaultUserId);
    } catch (e) {
      console.error("Migration warning on user_books", e);
    }
    
    // 4. Update other tables
    db.prepare("UPDATE bookmarks SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    db.prepare("UPDATE highlights SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    db.prepare("UPDATE reading_sessions SET user_id = ? WHERE user_id IS NULL").run(defaultUserId);
    
    // 5. Clean up old settings
    db.prepare("DELETE FROM settings WHERE key IN ('passphrase_hash', 'session_token')").run();
  })();
}

// 2. Settings table migration (add user_id)
const settingsCols = db.pragma('table_info(settings)');
const settingsHasUserId = settingsCols.some(c => c.name === 'user_id');

if (!settingsHasUserId) {
  console.log("Migrating settings table to user-scoped schema...");
  db.transaction(() => {
    // Read existing global settings
    const globalSettings = db.prepare('SELECT key, value FROM settings').all();
    
    // Create new table
    db.exec(`
      CREATE TABLE settings_new (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(user_id, key)
      );
    `);
    
    // Apply global settings to all users
    if (globalSettings.length > 0) {
      const users = db.prepare('SELECT id FROM users').all();
      const insertStmt = db.prepare('INSERT INTO settings_new (user_id, key, value) VALUES (?, ?, ?)');
      for (const user of users) {
        for (const setting of globalSettings) {
          insertStmt.run(user.id, setting.key, setting.value);
        }
      }
    }
    
    db.exec(`
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  })();
}

// 3. Collections table migration (remove user_id)
const collectionsCols = db.pragma('table_info(collections)');
const collectionsHasUserId = collectionsCols.some(c => c.name === 'user_id');

if (collectionsHasUserId) {
  console.log("Migrating collections table back to global schema...");
  db.transaction(() => {
    const legacyCollections = db.prepare('SELECT id, name FROM collections ORDER BY id').all();
    const canonicalByName = new Map();
    for (const collection of legacyCollections) {
      const key = collection.name.toLocaleLowerCase();
      const canonical = canonicalByName.get(key);
      if (!canonical) {
        canonicalByName.set(key, collection);
        continue;
      }
      const memberships = db.prepare('SELECT book_id FROM book_collections WHERE collection_id = ?').all(collection.id);
      for (const membership of memberships) {
        db.prepare('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)').run(membership.book_id, canonical.id);
      }
      db.prepare('DELETE FROM book_collections WHERE collection_id = ?').run(collection.id);
      db.prepare('DELETE FROM collections WHERE id = ?').run(collection.id);
    }
    db.exec(`
      CREATE TABLE collections_global (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
    `);
    
    db.exec(`
      INSERT OR IGNORE INTO collections_global (id, name)
      SELECT id, name FROM collections;
    `);
    
    db.exec(`
      DROP TABLE collections;
      ALTER TABLE collections_global RENAME TO collections;
    `);
  })();
}

// ---------- 4. Books table migration (add file_hash) ----------
const bookCols = db.pragma('table_info(books)');
if (!bookCols.some(c => c.name === 'file_hash')) {
  console.log('Migrating books table to add file_hash column...');
  db.exec('ALTER TABLE books ADD COLUMN file_hash TEXT;');
}
// Function to create a pre-migration backup before any structural data changes
function backupDatabaseBeforeMigration(label) {
  try {
    const BACKUP_DIR = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupTarget = path.join(BACKUP_DIR, `endpaper-pre-migration-${label}-${timestamp}.db`);
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, backupTarget);
      console.log(`[Migration] Safety backup created at ${backupTarget}`);
    }
  } catch (e) {
    console.error(`[Migration] Warning: Pre-migration backup failed:`, e);
  }
}

// Consolidate historical duplicate entries safely before unique index creation
const duplicateHashes = db.prepare(`
  SELECT file_hash FROM books 
  WHERE file_hash IS NOT NULL 
  GROUP BY file_hash 
  HAVING count(*) > 1
`).all();

if (duplicateHashes.length > 0) {
  console.log(`[Migration] Found ${duplicateHashes.length} duplicate book group(s). Consolidating dependent data...`);
  backupDatabaseBeforeMigration('books-deduplication');

  db.transaction(() => {
    for (const dup of duplicateHashes) {
      const booksInGroup = db.prepare(`
        SELECT id, title, filename, cover_path, added_at FROM books 
        WHERE file_hash = ? 
        ORDER BY added_at ASC
      `).all(dup.file_hash);

      const targetBook = booksInGroup[0];
      const duplicateBooks = booksInGroup.slice(1);

      for (const dupBook of duplicateBooks) {
        // 1. Repoint bookmarks to canonical book
        db.prepare('UPDATE bookmarks SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 2. Repoint highlights to canonical book
        db.prepare('UPDATE highlights SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 3. Repoint reading sessions to canonical book
        db.prepare('UPDATE reading_sessions SET book_id = ? WHERE book_id = ?').run(targetBook.id, dupBook.id);

        // 4. Repoint book_collections
        const dupCollections = db.prepare('SELECT collection_id FROM book_collections WHERE book_id = ?').all(dupBook.id);
        for (const col of dupCollections) {
          db.prepare('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)').run(targetBook.id, col.collection_id);
        }
        db.prepare('DELETE FROM book_collections WHERE book_id = ?').run(dupBook.id);

        // 5. Consolidate user_books progress
        const dupUserBooks = db.prepare('SELECT * FROM user_books WHERE book_id = ?').all(dupBook.id);
        for (const dupUb of dupUserBooks) {
          const targetUb = db.prepare('SELECT * FROM user_books WHERE user_id = ? AND book_id = ?').get(dupUb.user_id, targetBook.id);
          if (targetUb) {
            const mergedProgress = Math.max(targetUb.progress_percent || 0, dupUb.progress_percent || 0);
            const mergedStatus = (mergedProgress >= 95) ? 'finished' : (targetUb.status === 'reading' || dupUb.status === 'reading' ? 'reading' : (targetUb.status || dupUb.status || 'unread'));
            const mergedRating = targetUb.rating || dupUb.rating || null;
            const mergedOpened = (targetUb.last_opened_at && dupUb.last_opened_at) 
              ? (new Date(targetUb.last_opened_at) > new Date(dupUb.last_opened_at) ? targetUb.last_opened_at : dupUb.last_opened_at)
              : (targetUb.last_opened_at || dupUb.last_opened_at);
            const dupProgress = dupUb.progress_percent || 0;
            const targetProgress = targetUb.progress_percent || 0;
            let mergedCfi = targetUb.last_location_cfi;
            if (dupProgress > targetProgress && dupUb.last_location_cfi) {
              mergedCfi = dupUb.last_location_cfi;
            } else if (dupProgress === targetProgress) {
              const dupTime = dupUb.last_opened_at ? new Date(dupUb.last_opened_at).getTime() : 0;
              const targetTime = targetUb.last_opened_at ? new Date(targetUb.last_opened_at).getTime() : 0;
              if (dupTime > targetTime && dupUb.last_location_cfi) {
                mergedCfi = dupUb.last_location_cfi;
              }
            }

            db.prepare(`
              UPDATE user_books 
              SET status = ?, rating = ?, progress_percent = ?, last_location_cfi = ?, last_opened_at = ?
              WHERE user_id = ? AND book_id = ?
            `).run(mergedStatus, mergedRating, mergedProgress, mergedCfi, mergedOpened, dupUb.user_id, targetBook.id);

            db.prepare('DELETE FROM user_books WHERE user_id = ? AND book_id = ?').run(dupUb.user_id, dupBook.id);
          } else {
            db.prepare('UPDATE user_books SET book_id = ? WHERE user_id = ? AND book_id = ?').run(targetBook.id, dupUb.user_id, dupBook.id);
          }
        }

        // 6. Safely remove now-orphaned duplicate book row
        db.prepare('DELETE FROM books WHERE id = ?').run(dupBook.id);

        // 7. Clean duplicate disk assets if distinct from canonical
        if (dupBook.filename && dupBook.filename !== targetBook.filename) {
          const f = path.join(DATA_DIR, 'books', dupBook.filename);
          if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (e) {} }
        }
        if (dupBook.cover_path && dupBook.cover_path !== targetBook.cover_path) {
          const c = path.join(DATA_DIR, 'covers', dupBook.cover_path);
          if (fs.existsSync(c)) { try { fs.unlinkSync(c); } catch (e) {} }
        }

        console.log(`[Migration] Safely merged duplicate book "${dupBook.title}" (${dupBook.id}) into "${targetBook.title}" (${targetBook.id}) with all annotations preserved.`);
      }
    }
  })();
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);');

// ---------- 5. Users table case-insensitive uniqueness migration ----------
const duplicateUsers = db.prepare(`
  SELECT lower(username) as lower_name, count(*) as count 
  FROM users 
  GROUP BY lower(username) 
  HAVING count > 1
`).all();

if (duplicateUsers.length > 0) {
  console.log(`[Migration] Found ${duplicateUsers.length} case-collision user group(s). Backing up and renaming...`);
  backupDatabaseBeforeMigration('users-uniqueness');
}

for (const dup of duplicateUsers) {
  const usersWithCase = db.prepare(`
    SELECT id, username FROM users 
    WHERE lower(username) = ? 
    ORDER BY created_at ASC
  `).all(dup.lower_name);
  for (let i = 1; i < usersWithCase.length; i++) {
    const newName = `${usersWithCase[i].username}_${usersWithCase[i].id.slice(0, 8)}_${i}`;
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newName, usersWithCase[i].id);
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);');

// ---------- 6. Collections table case-insensitive uniqueness migration ----------
const duplicateCollections = db.prepare(`
  SELECT lower(name) as lower_name, count(*) as count 
  FROM collections 
  GROUP BY lower(name) 
  HAVING count > 1
`).all();

if (duplicateCollections.length > 0) {
  console.log(`[Migration] Found ${duplicateCollections.length} case-collision collection group(s). Backing up and renaming...`);
  backupDatabaseBeforeMigration('collections-uniqueness');
}

for (const dup of duplicateCollections) {
  const collectionsWithCase = db.prepare(`
    SELECT id, name FROM collections 
    WHERE lower(name) = ? 
    ORDER BY id ASC
  `).all(dup.lower_name);
  for (let i = 1; i < collectionsWithCase.length; i++) {
    const newName = `${collectionsWithCase[i].name}_${collectionsWithCase[i].id.slice(0, 8)}_${i}`;
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(newName, collectionsWithCase[i].id);
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name_nocase ON collections(name COLLATE NOCASE);');
db.pragma(`user_version = ${TARGET_SCHEMA_VERSION}`);

// Hash legacy files without blocking startup or reading whole EPUBs into RAM.
// One file is processed at a time and the unique index resolves races safely.
setImmediate(async () => {
  const crypto = require('crypto');
  const missing = db.prepare('SELECT id, filename FROM books WHERE file_hash IS NULL').all();
  const updateHash = db.prepare('UPDATE books SET file_hash = ? WHERE id = ? AND file_hash IS NULL');
  for (const item of missing) {
    const filePath = path.join(DATA_DIR, 'books', item.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      updateHash.run(hash.digest('hex'), item.id);
    } catch (error) {
      console.error('Could not hash book', item.filename, error);
    }
  }
});

// ---------- Periodic session pruning ----------
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
function runSessionPruning() {
  try {
    const result = db.prepare(`
      DELETE FROM sessions
      WHERE expires_at IS NULL
         OR datetime(expires_at) IS NULL
         OR datetime(expires_at) <= CURRENT_TIMESTAMP
    `).run();
    if (result.changes > 0) {
      console.log(`Pruned ${result.changes} expired session(s).`);
    }
  } catch (e) {
    console.error('Session pruning error:', e);
  }
}
runSessionPruning();
setInterval(runSessionPruning, PRUNE_INTERVAL_MS);

// ---------- Automatic daily backup ----------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function runBackup() {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const backupFile = path.join(BACKUP_DIR, `endpaper-${dateStr}.db`);
    if (fs.existsSync(backupFile)) return; // already backed up today
    db.backup(backupFile)
      .then(() => {
        console.log(`Database backed up to ${backupFile}`);
        // Rotate: keep only the newest MAX_BACKUPS files
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith('endpaper-') && f.endsWith('.db'))
          .sort()
          .reverse();
        for (const old of files.slice(MAX_BACKUPS)) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { /* skip */ }
        }
      })
      .catch(err => console.error('Database backup failed:', err));
  } catch (e) {
    console.error('Database backup error:', e);
  }
}

// Run backup on startup (non-blocking) and schedule daily
runBackup();
setInterval(runBackup, BACKUP_INTERVAL_MS);

module.exports = db;

````

---

## File: `server/src/middleware/auth.js`

*Relative Path: `server/src/middleware/auth.js` | Size: 1.9 KB | Total Lines: 69*

````javascript
'use strict';

const db = require('../db');

const findValidSession = db.prepare(`
  SELECT user_id
  FROM sessions
  WHERE token = ?
    AND expires_at IS NOT NULL
    AND datetime(expires_at) > CURRENT_TIMESTAMP
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

function clearSessionCookie(res) {
  res.clearCookie('endpaper_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Auth middleware: checks for a valid session cookie on all /api/* routes
 * except /api/login and /api/session. The session token is a high-entropy,
 * server-stored UUID; no additional signing secret is required.
 */
function authMiddleware(req, res, next) {
  // When mounted at /api via app.use('/api', ...), req.path is relative to the mount.
  // Use req.originalUrl for absolute path matching.
  const fullPath = req.originalUrl.split('?')[0]; // strip query string

  // Skip auth for login endpoint
  if (fullPath === '/api/login') return next();

  const token = req.cookies && req.cookies['endpaper_session'];

  if (!token) {
    // For /api/session, return 401 cleanly (used to check auth status)
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  let row;
  try {
    row = findValidSession.get(token);
  } catch (err) {
    return next(err);
  }

  if (!row) {
    // Avoid repeatedly sending an unusable token after expiry or logout.
    try { deleteSession.run(token); } catch (err) { return next(err); }
    clearSessionCookie(res);
    if (fullPath === '/api/session') {
      return res.status(401).json({ error: 'Invalid session' });
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user_id = row.user_id;

  next();
}

module.exports = { authMiddleware };

````

---

## File: `server/src/lib/epubMeta.js`

*Relative Path: `server/src/lib/epubMeta.js` | Size: 9.1 KB | Total Lines: 225*

````javascript
'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const sharp = require('sharp');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'reference', 'meta', 'dc:creator', 'dc:identifier'].includes(name),
});

const MAX_XML_BYTES = 1 * 1024 * 1024;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_COVER_PIXELS = 40 * 1024 * 1024;

function openZip(epubPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = new Map();
      let entryCount = 0;
      let totalBytes = 0;
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        try { zipfile.close(); } catch (_) {}
        reject(error);
      };
      zipfile.on('entry', entry => {
        entryCount++;
        totalBytes += entry.uncompressedSize || 0;
        const compressed = Math.max(1, entry.compressedSize || 0);
        if (entryCount > MAX_ARCHIVE_ENTRIES) return fail(new Error('EPUB contains too many files'));
        if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) return fail(new Error('EPUB expands to too much data'));
        if ((entry.uncompressedSize || 0) / compressed > MAX_COMPRESSION_RATIO) return fail(new Error('EPUB entry compression ratio is unsafe'));
        entries.set(entry.fileName.toLowerCase(), entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (finished) return;
        finished = true;
        resolve({ zipfile, entries });
      });
      zipfile.on('error', fail);
      zipfile.readEntry();
    });
  });
}

function readEntry(zipfile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!entry) return reject(new Error('Entry not found'));
    if (entry.uncompressedSize > maxBytes) return reject(new Error('Entry too large'));
    
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) return reject(err);
      const chunks = [];
      readStream.on('data', chunk => chunks.push(chunk));
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function validateEpub(epubPath) {
  const { zipfile, entries } = await openZip(epubPath);
  try {
    const mimetypeEntry = entries.get('mimetype');
    const containerEntry = entries.get('meta-inf/container.xml');
    
    if (!mimetypeEntry || !containerEntry) {
      throw new Error('The uploaded file is not a valid EPUB');
    }
    
    const mimetypeData = await readEntry(zipfile, mimetypeEntry, 128);
    if (mimetypeData.toString('utf8').trim() !== 'application/epub+zip') {
      throw new Error('The uploaded file is not a valid EPUB');
    }
    
    const containerData = await readEntry(zipfile, containerEntry, MAX_XML_BYTES);
    const container = parser.parse(containerData.toString('utf8'));
    const rootfile = container?.container?.rootfiles?.rootfile;
    const root = Array.isArray(rootfile) ? rootfile[0] : rootfile;
    const opfPath = root && root['@_full-path'];
    if (!opfPath || !entries.has(String(opfPath).toLowerCase())) throw new Error('The EPUB package document is missing');
    const opfData = await readEntry(zipfile, entries.get(String(opfPath).toLowerCase()), MAX_XML_BYTES);
    const opf = parser.parse(opfData.toString('utf8'));
    const pkg = opf.package || opf['opf:package'];
    const manifestItems = pkg?.manifest?.item;
    const spineItems = pkg?.spine?.itemref;
    if (!pkg || !manifestItems || !spineItems) throw new Error('The EPUB package has no readable manifest or spine');
  } finally {
    zipfile.close();
  }
}

async function extractMeta(epubPath, coverId, coversDir) {
  const { zipfile, entries } = await openZip(epubPath);
  const result = { title: '', author: '', series: null, seriesIndex: null, description: null, isbn: null, tags: null, coverPath: null };

  try {
    const containerEntry = entries.get('meta-inf/container.xml');
    if (!containerEntry) return result;

    const containerData = await readEntry(zipfile, containerEntry, MAX_XML_BYTES);
    const container = parser.parse(containerData.toString('utf8'));

    let opfPath = '';
    try {
      const rootfile = container.container.rootfiles.rootfile;
      opfPath = Array.isArray(rootfile) ? rootfile[0]['@_full-path'] : rootfile['@_full-path'];
    } catch (e) {
      return result;
    }

    const opfEntry = entries.get(opfPath.toLowerCase());
    if (!opfEntry) return result;

    const opfData = await readEntry(zipfile, opfEntry, MAX_XML_BYTES);
    const opf = parser.parse(opfData.toString('utf8'));
    const pkg = opf['package'] || opf['opf:package'] || {};
    const metadata = pkg.metadata || pkg['opf:metadata'] || {};
    const manifest = pkg.manifest || {};
    const items = Array.isArray(manifest.item) ? manifest.item : (manifest.item ? [manifest.item] : []);

    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    const dcTitle = metadata['dc:title'];
    if (dcTitle) {
      result.title = typeof dcTitle === 'string' ? dcTitle : (dcTitle['#text'] || dcTitle.toString());
    }

    const dcCreator = metadata['dc:creator'];
    if (dcCreator) {
      if (Array.isArray(dcCreator)) {
        result.author = dcCreator.map(c => typeof c === 'string' ? c : (c['#text'] || '')).filter(Boolean).join(', ');
      } else {
        result.author = typeof dcCreator === 'string' ? dcCreator : (dcCreator['#text'] || '');
      }
    }
    const description = metadata['dc:description'];
    if (description) result.description = typeof description === 'string' ? description : (description['#text'] || null);
    const subjects = metadata['dc:subject'];
    if (subjects) {
      const subjectList = Array.isArray(subjects) ? subjects : [subjects];
      result.tags = subjectList.map(subject => typeof subject === 'string' ? subject : subject['#text']).filter(Boolean).join(', ') || null;
    }
    const identifiers = Array.isArray(metadata['dc:identifier']) ? metadata['dc:identifier'] : (metadata['dc:identifier'] ? [metadata['dc:identifier']] : []);
    const isbn = identifiers.map(identifier => typeof identifier === 'string' ? identifier : identifier['#text']).find(value => /(?:97[89])?\d{9}[\dX]/i.test(String(value || '').replace(/[-\s]/g, '')));
    result.isbn = isbn ? String(isbn).trim() : null;

    const metas = Array.isArray(metadata.meta) ? metadata.meta : (metadata.meta ? [metadata.meta] : []);
    for (const m of metas) {
      if (m['@_name'] === 'calibre:series') result.series = m['@_content'] || null;
      if (m['@_name'] === 'calibre:series_index') {
        const parsed = parseFloat(m['@_content']);
        result.seriesIndex = Number.isFinite(parsed) ? parsed : null;
      }
    }

    let coverHref = null;
    const coverMeta = metas.find(m => m['@_name'] === 'cover');
    if (coverMeta) {
      const covItem = items.find(i => i['@_id'] === coverMeta['@_content']);
      if (covItem) coverHref = covItem['@_href'];
    }
    if (!coverHref) {
      const covItem = items.find(i => (i['@_properties'] || '').includes('cover-image'));
      if (covItem) coverHref = covItem['@_href'];
    }
    if (!coverHref) {
      const covItem = items.find(i => {
        const href = (i['@_href'] || '').toLowerCase();
        const mediaType = (i['@_media-type'] || '').toLowerCase();
        return mediaType.startsWith('image/') && (href.includes('cover') || href.includes('frontcover'));
      });
      if (covItem) coverHref = covItem['@_href'];
    }

    if (coverHref) {
      // url decode href in case it has spaces
      coverHref = decodeURI(coverHref);
      const coverZipPath = opfDir + coverHref;
      const coverEntry = entries.get(coverZipPath.toLowerCase());
      if (coverEntry) {
        const coverData = await readEntry(zipfile, coverEntry, MAX_COVER_BYTES);
        
        // Use sharp to process the image to a WebP
        const coverFilename = coverId + '.webp';
        const coverOutPath = path.join(coversDir, coverFilename);
        
        try {
          const image = sharp(coverData, { limitInputPixels: MAX_COVER_PIXELS, failOn: 'error' });
          const imageMeta = await image.metadata();
          if (imageMeta.width && imageMeta.height && imageMeta.width * imageMeta.height > MAX_COVER_PIXELS) {
            throw new Error('Cover image dimensions are too large');
          }
          await image
            .resize({ width: 400, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(coverOutPath);
            
          result.coverPath = coverFilename;
        } catch (e) {
          console.error('Could not process/save cover image with sharp:', e.message);
        }
      }
    }

  } finally {
    zipfile.close();
  }
  return result;
}

module.exports = { extractMeta, validateEpub };

````

---

## File: `server/src/lib/epubWorker.js`

*Relative Path: `server/src/lib/epubWorker.js` | Size: 1.4 KB | Total Lines: 45*

````javascript
const { parentPort, workerData } = require('worker_threads');
const { extractMeta, validateEpub } = require('./epubMeta');
const fs = require('fs');
const crypto = require('crypto');

(async () => {
  try {
    await validateEpub(workerData.tmpPath);
  } catch (e) {
    parentPort.postMessage({ success: false, validationError: true, error: e.message });
    process.exit(0);
  }

  let fileHash;
  try {
    fileHash = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(workerData.tmpPath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  } catch (e) {
    parentPort.postMessage({ success: false, validationError: false, error: e.message });
    process.exit(0);
  }

  try {
    fs.renameSync(workerData.tmpPath, workerData.destPath);
  } catch (e) {
    parentPort.postMessage({ success: false, validationError: false, error: e.message });
    process.exit(0);
  }

  let meta;
  try {
    meta = await extractMeta(workerData.destPath, workerData.id, workerData.coversDir);
  } catch (e) {
    meta = { _extractError: e.message, title: '', author: '', series: null, seriesIndex: null, coverPath: null };
  }

  meta.file_hash = fileHash;
  parentPort.postMessage({ success: true, meta });
})();

````

---

## File: `server/src/lib/passphrase.js`

*Relative Path: `server/src/lib/passphrase.js` | Size: 2.2 KB | Total Lines: 70*

````javascript
#!/usr/bin/env node
'use strict';

/**
 * CLI tool to create the first admin account, or reset an existing user's
 * passphrase (e.g. after a lockout), in Endpaper's multi-user schema.
 *
 * Usage:
 *   node src/lib/passphrase.js --set "my secret phrase" [username]
 *
 * If [username] is omitted, defaults to "admin". If that user doesn't exist
 * yet, it is created as an admin. If it already exists, its passphrase is
 * reset in place (its admin status is left untouched).
 */

const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const SALT_ROUNDS = 10;

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== '--set' || !args[1]) {
    console.error('Usage: node src/lib/passphrase.js --set "<passphrase>" [username]');
    process.exit(1);
  }

  const passphrase = args[1];
  const username = (args[2] || 'admin').trim();

  if (passphrase.length < 12) {
    console.error('Error: Passphrase must be at least 12 characters.');
    process.exit(1);
  }
  if (!username) {
    console.error('Error: Username cannot be blank.');
    process.exit(1);
  }

  // Import db here so it creates the data dir / schema (and runs migrations) if needed
  const db = require('../db');

  const hash = await bcrypt.hash(passphrase, SALT_ROUNDS);
  const existing = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(username);

  if (existing) {
    db.transaction(() => {
      db.prepare('UPDATE users SET passphrase_hash = ? WHERE id = ?').run(hash, existing.id);
      // A reset is commonly used to revoke access, so invalidate every
      // browser session for this account rather than leaving it usable until
      // its normal expiry.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    })();
    console.log(`✓ Passphrase reset for existing user "${username}".`);
  } else {
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, ?, ?, 1)').run(id, username, hash);
    console.log(`✓ Admin user "${username}" created.`);
  }

  console.log('  You can now log in to Endpaper with this username and passphrase.');

  process.exit(0);
}

main().catch(err => {
  console.error('Failed to set passphrase:', err);
  process.exit(1);
});

````

---

## File: `server/src/lib/validation.js`

*Relative Path: `server/src/lib/validation.js` | Size: 1.8 KB | Total Lines: 52*

````javascript
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COVER_FILE_RE = new RegExp(`^${UUID_RE.source.slice(1, -1)}\\.(?:jpe?g|png|gif|webp)$`, 'i');
const BOOK_FILE_RE = new RegExp(`^${UUID_RE.source.slice(1, -1)}\\.epub$`, 'i');

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isBookFilename(value) {
  return typeof value === 'string' && BOOK_FILE_RE.test(value);
}

function isCoverFilename(value) {
  return typeof value === 'string' && COVER_FILE_RE.test(value);
}

function text(value, { required = false, max = 500, field = 'value' } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result || null;
}

function number(value, { min = -Infinity, max = Infinity, field = 'value', nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Express middleware factory: validates that the named route param is a UUID.
 * Usage: router.get('/api/books/:id', validateUuidParam('id'), handler)
 */
function validateUuidParam(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      if (req.params[name] && !isUuid(req.params[name])) {
        return res.status(400).json({ error: `Invalid ${name} format` });
      }
    }
    next();
  };
}

module.exports = { isUuid, isBookFilename, isCoverFilename, text, number, validateUuidParam };

````

---

## File: `server/src/routes/auth.js`

*Relative Path: `server/src/routes/auth.js` | Size: 4.1 KB | Total Lines: 127*

````javascript
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();
const SESSION_TTL_DAYS = 90;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const pruneExpiredSessions = db.prepare(`
  DELETE FROM sessions
  WHERE expires_at IS NULL
     OR datetime(expires_at) IS NULL
     OR datetime(expires_at) <= CURRENT_TIMESTAMP
`);
const createSession = db.prepare(`
  INSERT INTO sessions (token, user_id, expires_at)
  VALUES (?, ?, datetime('now', '+90 days'))
`);
const createSessionAndPrune = db.transaction((token, userId) => {
  pruneExpiredSessions.run();
  createSession.run(token, userId);
});

// Rate limit failed login attempts without blocking a household that shares
// one public IP and signs in successfully from several devices.
const normalizeLoginName = (req) => String((req.body && req.body.username) || '').trim().toLocaleLowerCase('en-US');
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many login attempts from this network. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip + ':' + normalizeLoginName(req),
});

/**
 * POST /api/login
 * Body: { username: "...", passphrase: "..." }
 * On success: sets httpOnly session cookie (90-day expiry)
 */
router.post('/api/login', loginIpLimiter, loginLimiter, async (req, res) => {
  try {
    const { username, passphrase } = req.body || {};
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    if (!trimmedUsername || trimmedUsername.length > 255) {
      return res.status(400).json({ error: 'A valid username is required' });
    }
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase is required' });
    }

    const user = db.prepare("SELECT id, passphrase_hash FROM users WHERE lower(username) = lower(?)").get(trimmedUsername);

    if (!user) {
      return res.status(401).json({ error: 'Incorrect username or passphrase' });
    }

    const match = await bcrypt.compare(passphrase, user.passphrase_hash);

    if (!match) {
      return res.status(401).json({ error: 'Incorrect username or passphrase' });
    }

    // Generate a token with a matching server-side and browser-side 90-day
    // expiry. Pruning here keeps unused records bounded even on low traffic.
    const token = randomUUID();
    createSessionAndPrune(token, user.id);

    // Set httpOnly, SameSite=Strict cookie with 90-day expiry
    res.cookie('endpaper_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/logout
 * Invalidates the current session and removes its cookie.
 */
router.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.endpaper_session;
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
  res.clearCookie('endpaper_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.json({ ok: true });
});

/**
 * GET /api/session
 * Returns 200 if the session cookie is valid (middleware already checked it).
 * We will return whether the current user is an admin.
 */
router.get('/api/session', (req, res) => {
  const user = db.prepare("SELECT is_admin, username FROM users WHERE id = ?").get(req.user_id);
  res.json({ ok: true, is_admin: !!(user && user.is_admin), username: user ? user.username : null });
});

module.exports = router;

````

---

## File: `server/src/routes/books.js`

*Relative Path: `server/src/routes/books.js` | Size: 23.4 KB | Total Lines: 575*

````javascript
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { randomUUID } = crypto;
const { Worker } = require('worker_threads');
const db = require('../db');
const { extractMeta, validateEpub } = require('../lib/epubMeta');
const { isBookFilename, isCoverFilename, text, number, validateUuidParam } = require('../lib/validation');
const { requireAdmin } = require('./users');

const router = express.Router();

const DATA_DIR = process.env.ENDPAPER_DATA_DIR
  ? path.resolve(process.env.ENDPAPER_DATA_DIR)
  : path.resolve(__dirname, '../../../data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const MAX_WORKERS = Math.max(1, Math.min(4, Number(process.env.EPUB_WORKERS) || 2));
const WORKER_TIMEOUT_MS = Math.max(10_000, Number(process.env.EPUB_WORKER_TIMEOUT_MS) || 120_000);
let activeWorkers = 0;
const workerQueue = [];

function drainWorkerQueue() {
  while (activeWorkers < MAX_WORKERS && workerQueue.length) {
    const job = workerQueue.shift();
    activeWorkers++;
    let settled = false;
    const worker = new Worker(path.join(__dirname, '../lib/epubWorker.js'), { workerData: job.workerData });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeWorkers--;
      if (error) job.reject(error); else job.resolve(value);
      drainWorkerQueue();
    };
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('EPUB processing timed out'));
    }, WORKER_TIMEOUT_MS);
    worker.on('message', message => {
      if (message.success) finish(null, message.meta);
      else {
        const error = new Error(message.error);
        error.validationError = message.validationError;
        finish(error);
      }
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (code !== 0) finish(new Error(`Worker stopped with exit code ${code}`)); });
  }
}

function runEpubWorker(workerData) {
  return new Promise((resolve, reject) => {
    workerQueue.push({ workerData, resolve, reject });
    drainWorkerQueue();
  });
}

// Spine colors for books without covers (matches frontend)
const SPINE_COLORS = ['#3F5D4C','#7A3B32','#3B4A6B','#6B4C3B','#5B3F5D','#2C4237','#8A6A2F','#43506B'];

// Multer config: store uploaded EPUBs temporarily
const upload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 }, // 100MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.epub')) {
      cb(null, true);
    } else {
      cb(new Error('Only .epub files are allowed'));
    }
  },
});

/**
 * GET /api/books
 * Returns the full library listing (metadata only, no file content).
 */
router.get('/api/books', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const sort = req.query.sort || 'recent';
  const filter = req.query.filter || 'all';
  const search = req.query.search ? req.query.search.trim() : '';

  let whereClauses = [];
  let queryParams = [req.user_id]; // for user_books LEFT JOIN
  let whereParams = [];

  // Filter
  if (filter === 'unread') {
    whereClauses.push('IFNULL(ub.progress_percent, 0) = 0');
  } else if (filter === 'finished') {
    whereClauses.push('IFNULL(ub.progress_percent, 0) >= 98');
  } else if (filter.startsWith('col_')) {
    const colId = filter.substring(4);
    whereClauses.push('b.id IN (SELECT book_id FROM book_collections WHERE collection_id = ?)');
    whereParams.push(colId);
  }

  // Search
  if (search) {
    const literalSearch = search.replace(/[\\%_]/g, '\\$&');
    whereClauses.push("(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.series LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\' OR b.isbn LIKE ? ESCAPE '\\')");
    for (let index = 0; index < 6; index++) whereParams.push(`%${literalSearch}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Order
  let orderSql = 'ORDER BY b.added_at DESC';
  if (sort === 'opened') orderSql = 'ORDER BY ub.last_opened_at DESC NULLS LAST';
  else if (sort === 'title') orderSql = 'ORDER BY b.title COLLATE NOCASE ASC';
  else if (sort === 'author') orderSql = 'ORDER BY b.author COLLATE NOCASE ASC';
  else if (sort === 'series') orderSql = 'ORDER BY CASE WHEN b.series IS NULL OR b.series = \'\' THEN 1 ELSE 0 END, b.series COLLATE NOCASE ASC, b.series_index ASC NULLS LAST, b.title COLLATE NOCASE ASC';
  else if (sort === 'progress') orderSql = 'ORDER BY IFNULL(ub.progress_percent, 0) DESC';

  const countSql = `
    SELECT COUNT(b.id) as n
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    ${whereSql}
  `;
  const total = db.prepare(countSql).get(...queryParams, ...whereParams).n;

  const dataSql = `
    SELECT b.id, b.title, b.author, b.series, b.series_index, b.description, b.isbn, b.tags, b.cover_path, b.cover_color,
           IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi,
           b.added_at, ub.last_opened_at, b.file_size
     FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `;
  
  const books = db.prepare(dataSql).all(...queryParams, ...whereParams, limit, offset);

  // Continue reading book (always fetch latest opened globally for the user)
  let continueBooks = [];
  if (page === 1 && !search && filter === 'all') {
    continueBooks = db.prepare(`
      SELECT b.id, b.title, b.author, b.series, b.series_index, b.description, b.isbn, b.tags, b.cover_path, b.cover_color,
             IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi,
             b.added_at, ub.last_opened_at, b.file_size
      FROM books b
      JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
      WHERE ub.last_opened_at IS NOT NULL AND ub.progress_percent > 0 AND ub.progress_percent < 98
      ORDER BY ub.last_opened_at DESC
      LIMIT 4
    `).all(req.user_id);
  }

  res.json({
    books,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    continueBooks,
    continueBook: continueBooks[0] || null
  });
});

/**
 * POST /api/books
 * Multipart upload of an EPUB file.
 * Parses metadata + extracts cover, inserts DB row, returns the book object.
 */
// Books are shared by everyone.
router.post('/api/books', upload.single('file'), async (req, res) => {
  let destPath = null;
  let coverPath = null;
  let uploadedFileHash = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = randomUUID();
    const ext = '.epub';
    const filename = id + ext;
    destPath = path.join(BOOKS_DIR, filename);

    // Verify, move, hash, and extract metadata in a background worker
    let meta;
    try {
      meta = await runEpubWorker({ tmpPath: req.file.path, destPath, id, coversDir: COVERS_DIR });
      
      if (meta._extractError) {
        console.error('Metadata extraction error:', meta._extractError);
        delete meta._extractError;
      }
      coverPath = meta.coverPath;
    } catch (e) {
      if (e.validationError) {
        throw e; 
      } else {
        throw e;
      }
    }

    // Check for duplicate uploads via off-thread computed SHA-256 hash
    const fileHash = meta.file_hash;
    uploadedFileHash = fileHash;
    if (fileHash) {
      const existingBook = db.prepare('SELECT id, title FROM books WHERE file_hash = ?').get(fileHash);
      if (existingBook) {
        try { if (destPath && fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
        try { if (coverPath && fs.existsSync(path.join(COVERS_DIR, coverPath))) fs.unlinkSync(path.join(COVERS_DIR, coverPath)); } catch (e) {}
        return res.status(409).json({
          error: 'This book is already in the library',
          book_id: existingBook.id,
          title: existingBook.title
        });
      }
    }

    const fileSize = fs.statSync(destPath).size;

    // Fallback title from filename
    const fallbackTitle = req.file.originalname.replace(/\.epub$/i, '').replace(/[_]+/g, ' ').trim();
    const title = text(meta.title || fallbackTitle || 'Untitled book', { required: true, max: 500, field: 'title' });

    // Pick a spine color
    const bookCount = db.prepare('SELECT COUNT(*) as n FROM books').get().n;
    const coverColor = SPINE_COLORS[bookCount % SPINE_COLORS.length];

    const book = {
      id,
      title,
      author: text(meta.author, { max: 500, field: 'author' }),
      series: text(meta.series, { max: 500, field: 'series' }),
      series_index: Number.isFinite(meta.seriesIndex) ? meta.seriesIndex : null,
      description: meta.description || null,
      isbn: meta.isbn || null,
      tags: meta.tags || null,
      filename,
      file_format: 'epub',
      file_size: fileSize,
      file_hash: fileHash,
      cover_path: meta.coverPath || null,
      cover_color: coverColor,
      status: 'unread',
      rating: null,
      progress_percent: 0,
      last_location_cfi: null,
    };

    db.transaction(() => {
      db.prepare(`
        INSERT INTO books (id, title, author, series, series_index, description, isbn, tags, filename, file_format,
                           file_size, file_hash, cover_path, cover_color)
        VALUES (@id, @title, @author, @series, @series_index, @description, @isbn, @tags, @filename, @file_format,
                @file_size, @file_hash, @cover_path, @cover_color)
      `).run(book);
      db.prepare(`INSERT INTO user_books (user_id, book_id, status, progress_percent) VALUES (?, ?, 'unread', 0)`).run(req.user_id, id);
    })();

    // Return the full book row
    const inserted = db.prepare(`
      SELECT b.*, ub.status, ub.rating, ub.progress_percent, ub.last_location_cfi, ub.last_opened_at
      FROM books b
      LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
      WHERE b.id = ?
    `).get(req.user_id, id);
    res.status(201).json(inserted);
  } catch (err) {
    // Clean up whichever stage received the file on error.
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    if (destPath && fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch (e) {}
    }
    if (coverPath && isCoverFilename(coverPath)) {
      const createdCoverPath = path.join(COVERS_DIR, coverPath);
      if (fs.existsSync(createdCoverPath)) {
        try { fs.unlinkSync(createdCoverPath); } catch (e) {}
      }
    }
    console.error('Upload error:', err);
    if (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: books.file_hash/.test(err.message || ''))) {
      const existing = uploadedFileHash ? db.prepare('SELECT id, title FROM books WHERE file_hash = ?').get(uploadedFileHash) : null;
      return res.status(409).json({ error: 'This book is already in the library', book_id: existing && existing.id, title: existing && existing.title });
    }
    const isClientError = /valid EPUB|must be|too many|too large|compression ratio|timed out/i.test(err.message);
    res.status(isClientError ? 400 : 500).json({ error: isClientError ? err.message : 'Upload failed' });
  }
});

/**
 * GET /api/books/:id
 * Returns metadata for a single book.
 */
router.get('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare(`
    SELECT b.*, IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi, ub.last_opened_at
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);
  
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

/**
 * GET /api/books/:id/file
 * Streams the EPUB file with Cache-Control, Content-Length, and Range support.
 */
router.get('/api/books/:id/file', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT filename FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  if (!isBookFilename(book.filename)) return res.status(500).json({ error: 'Invalid book file record' });
  const filePath = path.join(BOOKS_DIR, book.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return res.status(500).json({ error: 'Could not access book file' });
  }

  const totalSize = stat.size;
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `inline; filename="${book.filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    if (!/^bytes=\d*-\d*$/.test(range) || range.includes(',')) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
    const parts = range.slice(6).split('-');
    let start;
    let end;
    if (parts[0] === '') {
      const suffixLength = parseInt(parts[1], 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      start = Math.max(0, totalSize - suffixLength);
      end = totalSize - 1;
    } else {
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    }

    if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).json({ error: 'Requested range not satisfiable' });
    }

    const clampedEnd = Math.min(end, totalSize - 1);
    const chunkSize = (clampedEnd - start) + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);

    const stream = fs.createReadStream(filePath, { start, end: clampedEnd });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read book file' });
      else res.destroy();
    });
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', totalSize);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read book file' });
      else res.destroy();
    });
    stream.pipe(res);
  }
});

/**
 * GET /api/books/:id/cover
 * Streams the cover image, or returns a 204 if no cover exists.
 */
router.get('/api/books/:id/cover', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (!book.cover_path) return res.status(204).end();
  if (!isCoverFilename(book.cover_path)) return res.status(500).json({ error: 'Invalid cover file record' });

  const coverPath = path.join(COVERS_DIR, book.cover_path);
  if (!fs.existsSync(coverPath)) return res.status(204).end();

  const ext = path.extname(book.cover_path).toLowerCase();
  const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const stream = fs.createReadStream(coverPath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not read cover image' });
    else res.destroy();
  });
  stream.pipe(res);
});

/**
 * PATCH /api/books/:id
 * Update mutable fields: progress_percent, last_location_cfi, status, rating, last_opened_at, title, author.
 */
router.patch('/api/books/:id', validateUuidParam('id'), (req, res) => {
  const book = db.prepare(`
    SELECT b.id, IFNULL(ub.status, 'unread') as status, IFNULL(ub.progress_percent, 0) as progress_percent
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(req.user_id);
  const isAdmin = !!(user && user.is_admin);
  const changesSharedMetadata = ['title', 'author', 'series', 'series_index', 'description', 'isbn', 'tags'].some(key => req.body[key] !== undefined);
  if (changesSharedMetadata && !isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required to edit shared book metadata' });
  }

  const bookUpdates = [];
  const bookValues = {};
  const userBookUpdates = [];
  const userBookValues = {};

  try {
    if (req.body.progress_percent !== undefined) {
      userBookValues.progress_percent = number(req.body.progress_percent, { min: 0, max: 100, field: 'progress_percent' });
      userBookUpdates.push('progress_percent = @progress_percent');
    }
    if (req.body.last_location_cfi !== undefined) {
      userBookValues.last_location_cfi = text(req.body.last_location_cfi, { max: 10000, field: 'last_location_cfi' });
      userBookUpdates.push('last_location_cfi = @last_location_cfi');
    }
    if (req.body.status !== undefined) {
      if (!['unread', 'reading', 'finished'].includes(req.body.status)) throw new Error('status is invalid');
      userBookValues.status = req.body.status;
      userBookUpdates.push('status = @status');
    }
    if (req.body.rating !== undefined) {
      userBookValues.rating = number(req.body.rating, { min: 1, max: 5, nullable: true, field: 'rating' });
      userBookUpdates.push('rating = @rating');
    }
    if (req.body.last_opened_at !== undefined) {
      const date = new Date(req.body.last_opened_at);
      if (typeof req.body.last_opened_at !== 'string' || Number.isNaN(date.getTime())) throw new Error('last_opened_at is invalid');
      userBookValues.last_opened_at = date.toISOString();
      userBookUpdates.push('last_opened_at = @last_opened_at');
    }
    if (req.body.title !== undefined) {
      bookValues.title = text(req.body.title, { required: true, max: 500, field: 'title' });
      bookUpdates.push('title = @title');
    }
    if (req.body.author !== undefined) {
      bookValues.author = text(req.body.author, { max: 500, field: 'author' });
      bookUpdates.push('author = @author');
    }
    for (const field of ['series', 'description', 'isbn', 'tags']) {
      if (req.body[field] !== undefined) {
        bookValues[field] = text(req.body[field], { max: field === 'description' ? 5000 : 500, field });
        bookUpdates.push(`${field} = @${field}`);
      }
    }
    if (req.body.series_index !== undefined) {
      bookValues.series_index = number(req.body.series_index, { min: -1000000, max: 1000000, nullable: true, field: 'series_index' });
      bookUpdates.push('series_index = @series_index');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (bookUpdates.length === 0 && userBookUpdates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  db.transaction(() => {
    if (bookUpdates.length > 0) {
      bookValues.id = req.params.id;
      db.prepare(`UPDATE books SET ${bookUpdates.join(', ')} WHERE id = @id`).run(bookValues);
    }
    
    if (userBookUpdates.length > 0) {
      // Auto-update status based on progress
      const newProgress = userBookValues.progress_percent !== undefined ? userBookValues.progress_percent : book.progress_percent;
      const currentStatus = userBookValues.status || book.status;
      if (newProgress >= 98 && currentStatus !== 'finished') {
        userBookValues.status = 'finished';
        if (!userBookUpdates.includes('status = @status')) userBookUpdates.push('status = @status');
      } else if (newProgress > 0 && currentStatus === 'unread') {
        userBookValues.status = 'reading';
        if (!userBookUpdates.includes('status = @status')) userBookUpdates.push('status = @status');
      }
      
      userBookValues.book_id = req.params.id;
      userBookValues.user_id = req.user_id;

      // Ensure user_books row exists before updating, or use INSERT ON CONFLICT
      // SQLite INSERT ON CONFLICT requires all NOT NULL fields to be provided
      const currentUb = db.prepare('SELECT 1 FROM user_books WHERE user_id = ? AND book_id = ?').get(req.user_id, req.params.id);
      if (currentUb) {
        db.prepare(`UPDATE user_books SET ${userBookUpdates.join(', ')} WHERE user_id = @user_id AND book_id = @book_id`).run(userBookValues);
      } else {
        // Insert a new row. Set default values for omitted fields.
        userBookValues.status = userBookValues.status || 'unread';
        userBookValues.progress_percent = userBookValues.progress_percent || 0;
        
        const cols = Object.keys(userBookValues);
        const placeholders = cols.map(c => '@' + c);
        db.prepare(`INSERT INTO user_books (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`).run(userBookValues);
      }
    }
  })();

  const updated = db.prepare(`
    SELECT b.*, IFNULL(ub.status, 'unread') as status, ub.rating, IFNULL(ub.progress_percent, 0) as progress_percent, ub.last_location_cfi, ub.last_opened_at
    FROM books b
    LEFT JOIN user_books ub ON b.id = ub.book_id AND ub.user_id = ?
    WHERE b.id = ?
  `).get(req.user_id, req.params.id);
  res.json(updated);
});

/**
 * DELETE /api/books/:id
 * Removes the book for EVERYONE (Endpaper has a single shared library — a
 * book isn't "yours" to unsubscribe from, it's a shelf everyone reads from).
 * Deleting a shared resource is destructive for every other user's
 * bookmarks, highlights, and progress on it, so this is admin-only.
 * DB row deletion cascades to user_books/bookmarks/highlights/book_collections
 * via ON DELETE CASCADE, so we only need to also clean up the files on disk.
 */
router.delete('/api/books/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const book = db.prepare('SELECT id, filename, cover_path FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const staged = [];
  try {
    const stage = (source, label) => {
      if (!source || !fs.existsSync(source)) return;
      const destination = path.join(DATA_DIR, 'tmp', `delete-${book.id}-${label}-${randomUUID()}`);
      fs.renameSync(source, destination);
      staged.push({ source, destination });
    };
    if (isBookFilename(book.filename)) stage(path.join(BOOKS_DIR, book.filename), 'book');
    if (book.cover_path && isCoverFilename(book.cover_path)) stage(path.join(COVERS_DIR, book.cover_path), 'cover');
    db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  } catch (error) {
    for (const item of staged.reverse()) {
      try { if (fs.existsSync(item.destination)) fs.renameSync(item.destination, item.source); } catch (_) {}
    }
    console.error('Error staging book deletion:', error);
    return res.status(500).json({ error: 'Could not remove book files safely' });
  }
  for (const item of staged) fs.promises.unlink(item.destination).catch(error => console.error('Error finalizing book deletion:', error));

  res.json({ ok: true });
});

module.exports = router;

````

---

## File: `server/src/routes/bookmarks.js`

*Relative Path: `server/src/routes/bookmarks.js` | Size: 2.1 KB | Total Lines: 59*

````javascript
'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, number, validateUuidParam } = require('../lib/validation');

const router = express.Router();

/**
 * GET /api/books/:id/bookmarks
 * Returns all bookmarks for a book, sorted by progress_percent.
 */
router.get('/api/books/:id/bookmarks', validateUuidParam('id'), (req, res) => {
  const bookmarks = db.prepare(
    'SELECT * FROM bookmarks WHERE book_id = ? AND user_id = ? ORDER BY progress_percent ASC'
  ).all(req.params.id, req.user_id);
  res.json(bookmarks);
});

/**
 * POST /api/books/:id/bookmarks
 * Body: { cfi, label, chapter, progress_percent }
 */
router.post('/api/books/:id/bookmarks', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  let cfi, safeLabel, safeChapter, progress;
  try {
    cfi = text(req.body.cfi, { required: true, max: 10000, field: 'cfi' });
    safeLabel = text(req.body.label, { max: 500, field: 'label' });
    safeChapter = text(req.body.chapter, { max: 500, field: 'chapter' });
    progress = req.body.progress_percent === undefined ? 0 : number(req.body.progress_percent, { min: 0, max: 100, field: 'progress_percent' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO bookmarks (id, user_id, book_id, cfi, label, chapter, progress_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user_id, req.params.id, cfi, safeLabel, safeChapter, progress);

  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  res.status(201).json(bookmark);
});

/**
 * DELETE /api/bookmarks/:id
 */
router.delete('/api/bookmarks/:id', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ ok: true });
});

module.exports = router;

````

---

## File: `server/src/routes/collections.js`

*Relative Path: `server/src/routes/collections.js` | Size: 4.9 KB | Total Lines: 138*

````javascript
'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, validateUuidParam } = require('../lib/validation');
const { requireAdmin } = require('./users');

const router = express.Router();

/**
 * GET /api/collections
 * Returns all collections, each with an array of book IDs.
 */
router.get('/api/collections', (req, res) => {
  const collections = db.prepare('SELECT * FROM collections ORDER BY name ASC').all();

  const memberships = db.prepare('SELECT collection_id, book_id FROM book_collections').all();
  const bookIdsByCollection = new Map(collections.map(collection => [collection.id, []]));
  for (const membership of memberships) {
    const bookIds = bookIdsByCollection.get(membership.collection_id);
    if (bookIds) bookIds.push(membership.book_id);
  }
  const result = collections.map(collection => ({
    ...collection,
    book_ids: bookIdsByCollection.get(collection.id),
  }));

  res.json(result);
});

/**
 * POST /api/collections
 * Body: { name }
 */
// Collections and their memberships are global shared-library metadata.
// Only admins may change them; every authenticated user can still browse and
// filter by them.
router.post('/api/collections', requireAdmin, (req, res) => {
  let name;
  try {
    name = text(req.body.name, { required: true, max: 80, field: 'Collection name' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  try {
    const existing = db.prepare('SELECT id FROM collections WHERE lower(name) = lower(?)').get(name);
    if (existing) return res.status(409).json({ error: 'A collection with that name already exists' });
    db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run(id, name);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A collection with that name already exists' });
    }
    throw err;
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  res.status(201).json({ ...collection, book_ids: [] });
});

/**
 * PATCH /api/collections/:id
 * Rename a collection without changing its memberships.
 */
router.patch('/api/collections/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(req.params.id);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  let name;
  try {
    name = text(req.body.name, { required: true, max: 80, field: 'Collection name' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const duplicate = db.prepare('SELECT id FROM collections WHERE lower(name) = lower(?) AND id != ?').get(name, req.params.id);
  if (duplicate) return res.status(409).json({ error: 'A collection with that name already exists' });
  try {
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, req.params.id);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A collection with that name already exists' });
    }
    throw err;
  }
  res.json(db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id));
});

/**
 * DELETE /api/collections/:id
 * Deleting a collection only removes its grouping, never the books in it.
 */
router.delete('/api/collections/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Collection not found' });
  res.json({ ok: true });
});

/**
 * POST /api/books/:id/collections/:collectionId
 * Add a book to a collection.
 */
router.post('/api/books/:id/collections/:collectionId', validateUuidParam('id', 'collectionId'), requireAdmin, (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(req.params.collectionId);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  try {
    db.prepare(
      'INSERT INTO book_collections (book_id, collection_id) VALUES (?, ?)'
    ).run(req.params.id, req.params.collectionId);
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('PRIMARY')) {
      return res.json({ ok: true, message: 'Already in collection' });
    }
    throw err;
  }

  res.status(201).json({ ok: true });
});

/**
 * DELETE /api/books/:id/collections/:collectionId
 * Remove a book from a collection.
 */
router.delete('/api/books/:id/collections/:collectionId', validateUuidParam('id', 'collectionId'), requireAdmin, (req, res) => {
  db.prepare(
    'DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?'
  ).run(req.params.id, req.params.collectionId);
  res.json({ ok: true });
});

module.exports = router;

````

---

## File: `server/src/routes/highlights.js`

*Relative Path: `server/src/routes/highlights.js` | Size: 5.0 KB | Total Lines: 131*

````javascript
'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { text, validateUuidParam } = require('../lib/validation');

const HIGHLIGHT_COLORS = new Set(['gold', '#F2D94E', '#8FD19E', '#8FC1E3', '#E8A0BF']);

function color(value) {
  const result = value || 'gold';
  if (typeof result !== 'string' || !HIGHLIGHT_COLORS.has(result)) throw new Error('color is invalid');
  return result;
}

const router = express.Router();

function tags(value) {
  if (value == null || value === '') return null;
  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > 12 || normalized.some(item => item.length > 40)) throw new Error('tags are invalid');
  return JSON.stringify(normalized);
}

router.get('/api/highlights', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase() : '';
  let rows = db.prepare(`
    SELECT h.*, b.title AS book_title, b.author AS book_author
    FROM highlights h JOIN books b ON b.id = h.book_id
    WHERE h.user_id = ? ORDER BY h.created_at DESC
  `).all(req.user_id);
  rows = rows.map(row => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] }));
  if (query) rows = rows.filter(row => `${row.excerpt || ''} ${row.note || ''} ${row.chapter || ''} ${row.book_title || ''}`.toLowerCase().includes(query));
  if (tag) rows = rows.filter(row => row.tags.includes(tag));
  res.json(rows);
});

/**
 * GET /api/books/:id/highlights
 * Returns all highlights for a book.
 */
router.get('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const highlights = db.prepare(
    'SELECT * FROM highlights WHERE book_id = ? AND user_id = ? ORDER BY created_at ASC'
  ).all(req.params.id, req.user_id);
  res.json(highlights.map(item => ({ ...item, tags: item.tags ? JSON.parse(item.tags) : [] })));
});

/**
 * POST /api/books/:id/highlights
 * Body: { cfi_range, excerpt, note, color, chapter }
 */
router.post('/api/books/:id/highlights', validateUuidParam('id'), (req, res) => {
  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  let cfiRange, safeExcerpt, safeNote, safeColor, safeChapter, safeTags;
  try {
    cfiRange = text(req.body.cfi_range, { required: true, max: 10000, field: 'cfi_range' });
    safeExcerpt = text(req.body.excerpt, { max: 1000, field: 'excerpt' });
    safeNote = text(req.body.note, { max: 2000, field: 'note' });
    safeColor = color(req.body.color);
    safeChapter = text(req.body.chapter, { max: 500, field: 'chapter' });
    safeTags = tags(req.body.tags);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO highlights (id, user_id, book_id, cfi_range, excerpt, note, color, chapter, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user_id, req.params.id, cfiRange, safeExcerpt, safeNote, safeColor, safeChapter, safeTags);

  const highlight = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
  res.status(201).json({ ...highlight, tags: highlight.tags ? JSON.parse(highlight.tags) : [] });
});

/**
 * PATCH /api/highlights/:id
 * Body: { color, note }
 */
router.patch('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const existing = db.prepare('SELECT id FROM highlights WHERE id = ? AND user_id = ?').get(req.params.id, req.user_id);
  if (!existing) return res.status(404).json({ error: 'Highlight not found' });

  const updates = [];
  const values = {};

  try {
    if (req.body.color !== undefined) {
      values.color = color(req.body.color);
      updates.push('color = @color');
    }
    if (req.body.note !== undefined) {
      values.note = text(req.body.note, { max: 2000, field: 'note' });
      updates.push('note = @note');
    }
    if (req.body.tags !== undefined) {
      values.tags = tags(req.body.tags);
      updates.push('tags = @tags');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.id = req.params.id;
  values.user_id = req.user_id;
  db.prepare(`UPDATE highlights SET ${updates.join(', ')} WHERE id = @id AND user_id = @user_id`).run(values);

  const updated = db.prepare('SELECT * FROM highlights WHERE id = ?').get(req.params.id);
  res.json({ ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] });
});

/**
 * DELETE /api/highlights/:id
 */
router.delete('/api/highlights/:id', validateUuidParam('id'), (req, res) => {
  const result = db.prepare('DELETE FROM highlights WHERE id = ? AND user_id = ?').run(req.params.id, req.user_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Highlight not found' });
  res.json({ ok: true });
});

module.exports = router;

````

---

## File: `server/src/routes/sessions.js`

*Relative Path: `server/src/routes/sessions.js` | Size: 8.7 KB | Total Lines: 232*

````javascript
'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { validateUuidParam } = require('../lib/validation');

const router = express.Router();

function closeSession(session, endedAt) {
  if (session.ended_at) return session;
  const duration = Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000));
  db.prepare(`UPDATE reading_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?`)
    .run(endedAt, duration, session.id);
  return { ...session, ended_at: endedAt, duration_seconds: duration };
}

/**
 * POST /api/sessions/start
 * Body: { book_id }
 * Creates a new reading session, returns the session object.
 */
router.post('/api/sessions/start', (req, res) => {
  const { book_id } = req.body;
  const clientId = typeof req.body.client_id === 'string' && req.body.client_id.length <= 100
    ? req.body.client_id
    : 'legacy-client';
  if (!book_id) return res.status(400).json({ error: 'book_id is required' });

  const book = db.prepare('SELECT id FROM books WHERE id = ?').get(book_id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const started_at = new Date().toISOString();
  const id = randomUUID();

  // A browser can be closed mid-read or a user can open a second book. Close
  // any abandoned single-user sessions before starting the new one so stats do
  // not silently lose that reading time.
  db.transaction(() => {
    const openSessions = db.prepare('SELECT * FROM reading_sessions WHERE ended_at IS NULL AND user_id = ? AND COALESCE(client_id, ?) = ?').all(req.user_id, clientId, clientId);
    for (const session of openSessions) closeSession(session, started_at);
    db.prepare('INSERT INTO reading_sessions (id, user_id, book_id, started_at, client_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.user_id, book_id, started_at, clientId);
  })();

  res.status(201).json({ id, book_id, started_at, client_id: clientId });
});

/**
 * POST /api/sessions/:id/end
 * Closes a reading session and computes duration.
 */
router.post('/api/sessions/:id/end', validateUuidParam('id'), (req, res) => {
  const session = db.prepare('SELECT * FROM reading_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // This endpoint is intentionally idempotent: sendBeacon and a normal close
  // can race during page unload.
  res.json(closeSession(session, new Date().toISOString()));
});

/**
 * GET /api/stats
 * Aggregate reading statistics:
 * - time read this week (seconds)
 * - current streak (days)
 * - total books finished
 * - average reading pace (seconds per book)
 */
router.get('/api/stats', (req, res) => {
  // Rolling seven days (the UI labels this precisely rather than “this week”).
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total
    FROM reading_sessions WHERE started_at >= ? AND user_id = ?
  `).get(weekAgo, req.user_id);

  // Total time read all-time
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total FROM reading_sessions WHERE user_id = ?
  `).get(req.user_id);

  // Books finished (global completion threshold is 98%).
  const finishedRow = db.prepare(`
    SELECT COUNT(*) as total FROM user_books WHERE progress_percent >= 98 AND user_id = ?
  `).get(req.user_id);

  // Timezone resolution: validate client timezone
  let timeZone = 'UTC';
  if (typeof req.query.tz === 'string' && req.query.tz.trim()) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: req.query.tz.trim() });
      timeZone = req.query.tz.trim();
    } catch (_) {
      timeZone = 'UTC';
    }
  }

  // Helper: get local date string YYYY-MM-DD in client timezone
  const getLocalDateKey = (dateObj) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateObj);
    } catch (_) {
      return dateObj.toISOString().slice(0, 10);
    }
  };

  // Reading streak: every local date touched by a session counts, including a
  // session crossing midnight. There is no artificial historical cutoff.
  const sessionRows = db.prepare(`
    SELECT rs.started_at, COALESCE(rs.ended_at, CURRENT_TIMESTAMP) AS ended_at,
           COALESCE(rs.duration_seconds, 0) AS duration_seconds,
           rs.book_id, b.title
    FROM reading_sessions rs
    LEFT JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ?
    ORDER BY started_at DESC
  `).all(req.user_id);

  const daySet = new Set();
  const dailySeconds = new Map();
  const monthlySeconds = new Map();
  for (const row of sessionRows) {
    if (row.started_at) {
      const start = new Date(row.started_at);
      const end = new Date(row.ended_at || row.started_at);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        daySet.add(getLocalDateKey(start));
        daySet.add(getLocalDateKey(end));
        for (let cursor = start.getTime() + 6 * 3600000; cursor < end.getTime(); cursor += 6 * 3600000) {
          daySet.add(getLocalDateKey(new Date(cursor)));
        }
        const key = getLocalDateKey(start);
        dailySeconds.set(key, (dailySeconds.get(key) || 0) + Number(row.duration_seconds || 0));
        const month = key.slice(0, 7);
        monthlySeconds.set(month, (monthlySeconds.get(month) || 0) + Number(row.duration_seconds || 0));
      }
    }
  }

  let streak = 0;
  const now = new Date();
  const todayKey = getLocalDateKey(now);

  const [y, m, d] = todayKey.split('-').map(Number);
  const baseUtcTime = Date.UTC(y, m - 1, d);

  let expectedDate = daySet.has(todayKey)
    ? baseUtcTime
    : baseUtcTime - 86400000;

  while (true) {
    const key = new Date(expectedDate).toISOString().slice(0, 10);
    if (daySet.has(key)) {
      streak++;
      expectedDate -= 86400000;
    } else {
      break;
    }
  }

  const sortedDays = [...daySet].sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const key of sortedDays) {
    const stamp = Date.parse(`${key}T00:00:00Z`);
    run = previous != null && stamp - previous === 86400000 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = stamp;
  }

  const previousWeekStart = new Date(Date.now() - 14 * 86400000).toISOString();
  const previousWeekEnd = weekAgo;
  const previousWeek = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM reading_sessions
    WHERE started_at >= ? AND started_at < ? AND user_id = ?
  `).get(previousWeekStart, previousWeekEnd, req.user_id).total;
  const averageSession = db.prepare(`
    SELECT COALESCE(AVG(duration_seconds), 0) AS value FROM reading_sessions
    WHERE user_id = ? AND duration_seconds > 0
  `).get(req.user_id).value;
  const mostRead = db.prepare(`
    SELECT rs.book_id, b.title, SUM(rs.duration_seconds) AS seconds
    FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
    WHERE rs.user_id = ? AND rs.duration_seconds > 0
    GROUP BY rs.book_id, b.title ORDER BY seconds DESC LIMIT 5
  `).all(req.user_id);
  const daily = [];
  for (let offset = 13; offset >= 0; offset--) {
    const date = new Date(Date.now() - offset * 86400000);
    const key = getLocalDateKey(date);
    daily.push({ date: key, seconds: dailySeconds.get(key) || 0 });
  }
  const monthly = [...monthlySeconds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-12)
    .map(([month, seconds]) => ({ month, seconds }));
  const paceRows = db.prepare(`
    SELECT b.file_size, ub.progress_percent, COALESCE(SUM(rs.duration_seconds), 0) AS seconds
    FROM user_books ub
    JOIN books b ON b.id = ub.book_id
    LEFT JOIN reading_sessions rs ON rs.book_id = ub.book_id AND rs.user_id = ub.user_id
    WHERE ub.user_id = ? AND ub.progress_percent > 0
    GROUP BY ub.book_id, b.file_size, ub.progress_percent
    HAVING seconds >= 300
  `).all(req.user_id);
  const paceSeconds = paceRows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
  const estimatedBytesRead = paceRows.reduce((sum, row) => {
    return sum + Number(row.file_size || 0) * Math.min(100, Math.max(0, Number(row.progress_percent || 0))) / 100;
  }, 0);
  const readingBytesPerMinute = paceSeconds > 0
    ? Math.round(estimatedBytesRead / (paceSeconds / 60))
    : null;

  res.json({
    time_read_this_week: weekRow.total,
    time_read_total: totalRow.total,
    books_finished: finishedRow.total,
    reading_streak_days: streak,
    longest_streak_days: longestStreak,
    previous_7_days: previousWeek,
    average_session_seconds: Math.round(averageSession || 0),
    reading_bytes_per_minute: readingBytesPerMinute,
    daily,
    monthly,
    most_read: mostRead,
  });
});

module.exports = router;

````

---

## File: `server/src/routes/settings.js`

*Relative Path: `server/src/routes/settings.js` | Size: 2.0 KB | Total Lines: 70*

````javascript
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// Keys that must never be exposed or overwritten via the API
const SENSITIVE_KEYS = ['passphrase_hash', 'session_token'];
const SETTING_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

/**
 * GET /api/settings
 * Returns all non-sensitive settings as a JSON object.
 */
router.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(req.user_id);
  const settings = {};
  for (const row of rows) {
    if (!SENSITIVE_KEYS.includes(row.key)) {
      // Try to parse JSON values, fall back to string
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (e) {
        settings[row.key] = row.value;
      }
    }
  }
  res.json(settings);
});

/**
 * PUT /api/settings
 * Body: { key: value, key2: value2, ... }
 * Upserts each key-value pair into the settings table.
 * Sensitive keys are rejected.
 */
router.put('/api/settings', (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);

  const runAll = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (SENSITIVE_KEYS.includes(key)) continue;
      if (!SETTING_KEY_RE.test(key)) throw new Error(`Invalid setting key: ${key}`);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (serialized === undefined || serialized.length > 100_000) throw new Error(`Setting ${key} is too large or unsupported`);
      upsert.run(req.user_id, key, serialized);
    }
  });

  try {
    runAll(Object.entries(body));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ ok: true });
});

module.exports = router;

````

---

## File: `server/src/routes/users.js`

*Relative Path: `server/src/routes/users.js` | Size: 5.1 KB | Total Lines: 145*

````javascript
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const db = require('../db');
const { validateUuidParam } = require('../lib/validation');

const router = express.Router();

/**
 * Middleware to ensure the current user is an admin.
 */
function requireAdmin(req, res, next) {
  const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(req.user_id);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

/**
 * GET /api/users
 * Lists all users.
 */
router.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at ASC').all();
  res.json(users);
});

/**
 * POST /api/users
 * Creates a new user.
 * Body: { username: "...", passphrase: "...", is_admin: boolean }
 */
router.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, passphrase, is_admin } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length === 0 || username.length > 255) {
      return res.status(400).json({ error: 'A valid username is required' });
    }
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
      return res.status(400).json({ error: 'A valid passphrase (min 12 characters) is required' });
    }
    if (is_admin !== undefined && typeof is_admin !== 'boolean') {
      return res.status(400).json({ error: 'is_admin must be a boolean' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username.trim());
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(passphrase, 10);
    const id = randomUUID();

    db.prepare('INSERT INTO users (id, username, passphrase_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(id, username.trim(), hash, is_admin ? 1 : 0);

    res.status(201).json({ id, username: username.trim(), is_admin: is_admin ? 1 : 0 });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/users/:id
 * Updates a user's role (is_admin) or resets their passphrase.
 * Body: { is_admin?: boolean, passphrase?: string }
 */
router.patch('/api/users/:id', validateUuidParam('id'), requireAdmin, async (req, res) => {
  try {
    const existing = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { is_admin, passphrase } = req.body;
    if (is_admin === undefined && passphrase === undefined) {
      return res.status(400).json({ error: 'At least one field (is_admin or passphrase) must be provided' });
    }

    let newAdmin = existing.is_admin;
    if (is_admin !== undefined) {
      if (typeof is_admin !== 'boolean') {
        return res.status(400).json({ error: 'is_admin must be a boolean' });
      }
      const parsedAdmin = is_admin ? 1 : 0;
      if (req.params.id === req.user_id && parsedAdmin === 0) {
        return res.status(400).json({ error: 'You cannot remove your own admin privileges' });
      }
      newAdmin = parsedAdmin;
    }

    let newHash = null;
    if (passphrase !== undefined) {
      if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
        return res.status(400).json({ error: 'A valid passphrase (min 12 characters) is required' });
      }
      newHash = await bcrypt.hash(passphrase, 10);
    }

    db.transaction(() => {
      if (newHash !== null) {
        db.prepare('UPDATE users SET is_admin = ?, passphrase_hash = ? WHERE id = ?').run(newAdmin, newHash, req.params.id);
        // Revoke active sessions on passphrase reset
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
      } else {
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(newAdmin, req.params.id);
      }
    })();

    const updated = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/users/:id
 * Deletes a user. Cannot delete yourself.
 */
router.delete('/api/users/:id', validateUuidParam('id'), requireAdmin, (req, res) => {
  if (req.params.id === req.user_id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({ ok: true });
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;

````

---

## File: `server/test/api-smoke.test.js`

*Relative Path: `server/test/api-smoke.test.js` | Size: 4.2 KB | Total Lines: 118*

````javascript
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

````

---

## File: `server/test/validation.test.js`

*Relative Path: `server/test/validation.test.js` | Size: 1.7 KB | Total Lines: 35*

````javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { text, number, isUuid, isBookFilename, isCoverFilename } = require('../src/lib/validation');

test('validation accepts expected library identifiers and rejects traversal', () => {
  assert.equal(isUuid('123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(isBookFilename('123e4567-e89b-42d3-a456-426614174000.epub'), true);
  assert.equal(isBookFilename('../book.epub'), false);
  assert.equal(isCoverFilename('123e4567-e89b-42d3-a456-426614174000.webp'), true);
  assert.equal(isCoverFilename('..\\cover.webp'), false);
});

test('text and number enforce bounds without coercing invalid values', () => {
  assert.equal(text('  A title  ', { required: true, max: 20, field: 'title' }), 'A title');
  assert.throws(() => text('', { required: true, field: 'title' }), /required/);
  assert.equal(number(98, { min: 0, max: 100, field: 'progress' }), 98);
  assert.throws(() => number('not-a-number', { field: 'progress' }), /number/);
});

test('frontend keeps security and reader regression invariants', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.doesNotMatch(app, /allow-same-origin allow-scripts/);
  assert.match(app, /pct\s*>=\s*98/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com|fonts\.googleapis\.com/);
  assert.match(html, /\/jszip\.min\.js/);
  assert.match(html, /\/epub\.min\.js/);
  assert.ok(fs.existsSync(path.join(publicDir, 'jszip.min.js')));
});

````

---
