<div align="center">

# StreamVault VOD Streaming Platform

[![Turborepo CI](https://github.com/snhi2002-beep/streaming-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/snhi2002-beep/streaming-platform/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.21-green.svg)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-5.22-teal.svg)](https://www.prisma.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-5.25-orange.svg)](https://docs.bullmq.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-oriented, modular Video-on-Demand (VOD) streaming platform backend built with **Node.js, Express.js, TypeScript, MySQL, Prisma, Redis, BullMQ, FFmpeg, S3 Object Storage, and Stripe**.

</div>

---

<Image src="image_agent_tag_255438411884787663" alt="StreamVault VOD ingestion, transcoding, and streaming architecture workflow" caption="VOD Ingestion, Transcoding, and CDN Delivery Architecture" />

---

## Architecture Overview & Key Engineering Features

1. **Modular Monolith with Isolated Workers**:
   - The API control plane (`src/server.ts`) handles low-latency HTTP traffic (`/api/v1/*`), while CPU-bound media ingestion and FFmpeg HLS transcoding execute in isolated BullMQ worker processes (`src/workers/index.ts`) with strict resource limits.
2. **Robust Authentication & Refresh Token Rotation**:
   - Passwords hashed using **Argon2id**. Short-lived Access Tokens (15 min) in response bodies; long-lived Refresh Tokens (7 days) in `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
   - **Reuse Detection**: If a rotated or revoked refresh token is presented, the system detects theft and immediately revokes all active tokens in that `familyId`.
3. **Asynchronous Direct-to-S3 Upload & FFmpeg HLS Pipeline**:
   - Admin initiates upload -> short-lived S3 presigned PUT URL -> direct client-to-S3 upload -> S3 `HeadObject` validation -> BullMQ job -> isolated FFmpeg worker produces resolution-aware ABR ladder (`360p`, `480p`, `720p`, `1080p`), master `.m3u8` playlists, `.ts` segments, and WebVTT sprite thumbnails.
4. **Secure Playback & Concurrent Stream Limiting**:
   - Enforces profile maturity ratings and subscription entitlements.
   - **Concurrency Control**: Redis sorted sets (`playback:active:{userId}`) prune inactive streams via heartbeats and enforce plan limits.
   - **CDN Delivery**: Issues CloudFront / HMAC-signed cookies and manifest URLs (Express never proxies video bytes).
5. **Stripe Subscriptions & Webhooks**:
   - Cryptographic `Stripe-Signature` verification with raw request body, idempotent `WebhookEvent` table storage, out-of-order timestamp guards, and Redis entitlement cache invalidation.

---

## Project Structure

```text
streaming-platform/
├── apps/
│   ├── api/                   # Express VOD backend service
│   │   ├── src/
│   │   │   ├── config/        # Zod environment validation & constants
│   │   │   ├── modules/       # Domain modules (auth, profiles, catalog, videos, playback, subscriptions, reviews)
│   │   │   ├── infrastructure/# Prisma, Redis, S3, BullMQ, FFmpeg, CDN signer
│   │   │   ├── workers/       # BullMQ FFmpeg transcode worker & cleanup
│   │   │   ├── observability/ # Liveness/readiness probes & Prometheus metrics
│   │   │   ├── app.ts         # Express app configuration & OpenAPI Swagger UI
│   │   │   └── server.ts      # HTTP server & graceful shutdown
│   │   ├── prisma/            # Prisma schema, migrations & seed script
│   │   └── tests/             # Vitest unit & architecture tests
│   └── web/                   # Next.js viewer client
├── packages/
│   └── typescript-config/     # Shared tsconfig bases
├── compose.yaml               # Docker Compose (MySQL, Redis, MinIO, API, Worker)
└── README.md
```

---

## Getting Started & Local Installation

### Prerequisites
- Node.js LTS (v20+)
- Docker & Docker Compose

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/snhi2002-beep/streaming-platform.git
cd streaming-platform
npm install
```

### 2. Configure Environment Variables
Copy the example environment file inside `apps/api`:
```bash
cp apps/api/.env.example apps/api/.env
```

### 3. Run via Docker Compose (Recommended)
```bash
docker compose up --build -d

# Run Prisma migrations and seed development data inside the API container
docker exec -it vod-api npx prisma migrate dev --name init
docker exec -it vod-api npm run prisma:seed
```

### 4. Run Locally (Manual)
```bash
cd apps/api
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed

# Start API Server (Port 4000)
npm run dev

# Start BullMQ FFmpeg Worker (In a separate terminal)
npm run dev:worker
```

* **Interactive Swagger UI / OpenAPI Spec:** `http://localhost:4000/api/docs`
* **Liveness & Readiness Probes:** `http://localhost:4000/health/live` & `http://localhost:4000/health/ready`
* **Prometheus Metrics:** `http://localhost:4000/health/metrics`

---

## API Documentation & Sample Requests/Responses

### 1. Register User & Default Profile
* **Endpoint:** `POST /api/v1/auth/register`
* **Request Body:**
```json
{
  "email": "viewer@streamvault.example.com",
  "password": "Password123!",
  "profileName": "Main Profile"
}
```
* **Response (`201 Created`):**
```json
{
  "success": true,
  "data": {
    "userId": "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    "email": "viewer@streamvault.example.com",
    "status": "ACTIVE",
    "profiles": [
      {
        "id": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
        "name": "Main Profile",
        "isKidsProfile": false
      }
    ]
  }
}
```

---

### 2. Authenticate (Login)
* **Endpoint:** `POST /api/v1/auth/login`
* **Request Body:**
```json
{
  "email": "viewer@streamvault.example.com",
  "password": "Password123!",
  "deviceFingerprint": "browser-chrome-mac",
  "deviceName": "MacBook Pro",
  "deviceType": "WEB"
}
```
* **Response (`200 OK` + Sets `HttpOnly` Refresh Token Cookie):**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresInSeconds": 900,
    "user": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      "email": "viewer@streamvault.example.com",
      "roles": ["VIEWER"],
      "permissions": []
    }
  }
}
```

---

### 3. Fetch Homepage Catalog (Redis Cached)
* **Endpoint:** `GET /api/v1/catalog/home`
* **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "featuredMovies": [
      {
        "id": "mov-1111-2222-3333",
        "title": "Orbital Horizon",
        "slug": "orbital-horizon",
        "synopsis": "A deep-space relay engineer uncovers a signal anomaly near Europa.",
        "runtimeSeconds": 7320,
        "maturityRating": "PG_13",
        "requiresPremium": true,
        "trendingScore": 98.4,
        "genres": [
          {
            "genre": {
              "id": "gen-sci-fi",
              "name": "Sci-Fi",
              "slug": "sci-fi"
            }
          }
        ]
      }
    ],
    "trendingMovies": [],
    "featuredSeries": []
  },
  "cached": false
}
```

---

### 4. Initiate Video Upload & Get S3 Presigned URL (Admin)
* **Endpoint:** `POST /api/v1/videos/uploads/initiate`
* **Headers:** `Authorization: Bearer <ADMIN_JWT>`
* **Request Body:**
```json
{
  "ownerType": "MOVIE",
  "movieId": "mov-1111-2222-3333",
  "fileName": "orbital_horizon_master_4k.mp4",
  "mimeType": "video/mp4",
  "fileSizeBytes": 5368709120
}
```
* **Response (`201 Created`):**
```json
{
  "success": true,
  "data": {
    "assetId": "ast-9999-8888-7777",
    "status": "UPLOADING",
    "uploadUrl": "http://localhost:9000/vod-raw-uploads-private/raw/movie/ast-9999-8888-7777/source.mp4?AWSAccessKeyId=minioadmin...&Signature=...",
    "expiresInSeconds": 3600
  }
}
```

---

### 5. Authorize Playback & Receive Signed HLS Manifest
* **Endpoint:** `POST /api/v1/playback/sessions`
* **Headers:** `Authorization: Bearer <USER_JWT>`
* **Request Body:**
```json
{
  "profileId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
  "movieId": "mov-1111-2222-3333"
}
```
* **Response (`201 Created`):**
```json
{
  "success": true,
  "data": {
    "sessionId": "ses-5555-4444-3333",
    "sessionToken": "d41d8cd98f00b204e9800998ecf8427e",
    "masterPlaylistUrl": "https://cdn.streamvault.example.com/hls/ast-9999-8888-7777/master.m3u8?exp=1760520000&sig=abc123xyz...",
    "expiresAt": "2026-10-15T13:00:00.000Z",
    "resumePositionSeconds": 1420
  }
}
```

---

### 6. Create Stripe Subscription Checkout Session
* **Endpoint:** `POST /api/v1/subscriptions/checkout`
* **Headers:** `Authorization: Bearer <USER_JWT>`
* **Request Body:**
```json
{
  "planCode": "PREMIUM_MONTHLY"
}
```
* **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4...",
    "sessionId": "cs_test_a1b2c3d4..."
  }
}
```

---

## Running Tests

```bash
cd apps/api
npm test
```

---

## License

Distributed under the MIT License. See `LICENSE` for details.
