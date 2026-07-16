# forum-api

Backend for the forum app (`../forum`). Hono + Postgres, self-managed JWT auth, disk/R2 storage, Anthropic-powered AI chat. Replaces the old Supabase backend entirely.

## Stack

| Concern | Dev | Production |
|---|---|---|
| API | Hono on Node (`npm run dev`, port 3000) | Same code — deploy anywhere Node runs (Railway, Fly, ...) |
| Database | Local homebrew Postgres, db `forum` | Neon — swap `DATABASE_URL` |
| Auth | Email+password, scrypt hashes, HS256 JWTs (30-day) | Same |
| Storage | `./uploads` on disk, served at `/storage/files/*` | Cloudflare R2 — set the `R2_*` vars |
| AI chat | `POST /ai/chat` via Anthropic API (`claude-opus-4-8`) | Set `ANTHROPIC_API_KEY` |

## Getting started

```bash
createdb forum                                   # once (or point DATABASE_URL elsewhere)
psql forum -f schema.sql                         # tables + topic seed
psql forum -f seed.sql                           # dev subtopics + sample articles
cp .env.example .env                             # fill in JWT_SECRET (openssl rand -hex 32)
npm install
npm run dev                                      # http://localhost:3000
npm run seed:dev                                 # sample users/posts/comments via the API
```

Dev logins after seeding: `john@example.dev` / `jane@example.dev` / `alice@example.dev`, password `password123`.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/signup` `{username,email,password}` | — | Create account → `{token, user}` |
| `POST /auth/login` `{email,password}` | — | Log in → `{token, user}` |
| `GET /users/me` · `PATCH /users/me` | ✅ | Own profile (patch: username/bio/avatar_url/header_url) |
| `GET/POST /users/me/positions` | ✅ | Per-topic political positions |
| `GET /users?ids=` · `GET /users/:id` | ✅ | Public profiles |
| `GET /posts?topic_id=&limit=&offset=` | ✅ | Feed (author + caller's vote joined in) |
| `POST /posts` `{content,media_url?,general_topic_id?,position?}` | ✅ | Create post |
| `POST /posts/:id/vote` `{direction: up\|down\|null}` | ✅ | Vote / unvote (counters recomputed transactionally) |
| `GET /comments?post_id=\|parent_comment_id=&page=&limit=` | ✅ | Paginated comments with reply counts |
| `POST /comments` `{post_id?\|parent_comment_id?,content}` | ✅ | Comment or reply |
| `GET /topics` | — | Topics with nested subtopics |
| `GET /topics/subtopics/:id` | — | Subtopic detail + its articles |
| `GET /articles?topic_id=&subtopic_id=` · `GET /articles/:id` | — | News articles |
| `POST /storage/upload?filename=x.jpg` (raw bytes) | ✅ | Image upload → `{url}` (disk in dev, R2 when configured) |
| `POST /ai/chat` `{message,framing}` | ✅ | forumAI → `{left, center, right}` |

Auth: `Authorization: Bearer <jwt>`. Errors: `{error: string}` with a meaningful status.

## Going to production

1. `neonctl projects create forum` → set `DATABASE_URL`, run `schema.sql` + `seed.sql` against it (`scripts/setup.mjs` automates Neon + R2 provisioning).
2. Create an R2 bucket, enable public access, fill in the `R2_*` vars.
3. Set `ANTHROPIC_API_KEY` for AI chat.
4. Deploy (e.g. `railway init && railway up`) and point the app at it via `EXPO_PUBLIC_API_URL`.

The Expo app auto-derives the API URL from the Metro dev-server host in development, so a phone on the same Wi-Fi works with zero config.
