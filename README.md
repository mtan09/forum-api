# forum-api

Backend for the forum app (`../forum`). Hono + Postgres, self-managed JWT auth, disk/R2 storage, deterministic bias scoring with real news ingestion, OpenAI-powered streaming AI chat. Replaces the old Supabase backend entirely.

## Stack

| Concern | Dev | Production |
|---|---|---|
| API | Hono on Node (`npm run dev`, port 3000) | Same code — deploy anywhere Node runs (Railway, Fly, ...) |
| Database | Local homebrew Postgres, db `forum` | Neon — swap `DATABASE_URL` |
| Auth | Email+password, scrypt hashes, HS256 JWTs (30-day) | Same |
| Storage | `./uploads` on disk, served at `/storage/files/*` | Cloudflare R2 — set the `R2_*` vars |
| News + scoring | `npm run ingest` (or `INGEST_INTERVAL_MINUTES` timer) | Same — no external APIs or keys needed |
| AI chat | `POST /ai/chat` streamed (SSE) via OpenAI (`gpt-5.4-nano`) | Set `OPENAI_API_KEY` |

## News ingestion, bias scoring & hot-topic clustering

The article feed is real: `src/ingest/` pulls RSS from ~59 curated outlets across the political spectrum (`src/ingest/sources.ts`, kept ~even between left/center/right), extracts full text, dedupes by URL/content hash, gates on political relevance, auto-derives hashtags and a background general topic, scores, and inserts as `ready`. Run once with `npm run ingest`, or set `INGEST_INTERVAL_MINUTES` to refresh on a timer while the server runs.

Publisher data is treated as untrusted. Image selection prefers a feed's canonical enclosure, validates every source with the same URL rules, rejects malformed article-URL-plus-caption metadata, and falls back to a valid page image. Full-text extraction rejects timestamp-heavy video-player/navigation rails from any publisher and falls back to the cleaner RSS text instead, so unrelated video headlines do not pollute scoring or story summaries.

**Nothing is hand-written.** After every ingest pass (or via `npm run cluster`), `src/ingest/cluster.ts` groups the last 7 days of articles into stories: each article is compared with a fixed founding-story profile, followed by a union-find merge pass over fixed profiles, so a cluster cannot accumulate vocabulary and snowball into unrelated topics. Automatic article membership is rebuilt on every clustering run rather than retaining stale links. Clusters with 3+ articles from 2+ outlets become subtopics — the "hot topics" carousel (`GET /topics/hot`) and their blurb/summary screens are generated **extractively**: the title is a real member headline (preferring outlets nearest the center), the short blurb is a lead sentence, and the long summary quotes one clean, word-boundary-capped lead (260 characters maximum) per spectrum band ("From the left (…): … / From the center: … / From the right: …"). `volume` is the real article+post count, and `public_position` is the average scored position of matched user posts. Deterministic — no LLM anywhere in the pipeline.

**Hashtags** are the organizing layer instead of fixed categories: articles get them auto-extracted from their keywords; users pick their own when posting (`POST /posts` accepts `hashtags[]`, plus inline `#tags` in the text). The 7 general topics still exist silently as background metadata.

Scoring (`src/scoring/`) is **deterministic — no LLM, no black box**:

- **Lean (0 = left, 1 = right):** starts from the outlet's published lean rating (AllSides/Ad Fontes approximations in `sources.ts`), then shifts by at most ±0.25 based on partisan framing vocabulary in the text (Gentzkow–Shapiro-style term pairs: "estate tax"/"death tax", "undocumented"/"illegal alien", ...). Framing counts only outside quotations and is capped per term.
- **Fact vs. opinion:** a separate subjectivity score (loaded language, first person, opinion markers, quote density) plus URL/section heuristics classifies each piece as `factual_report` / `news_report` / `analysis` / `opinion`. The app shows reporting with a "Source Lean" bar and a badge instead of claiming the article itself has a measured slant.
- **Posts:** no outlet prior exists, so post placement combines partisan framing with a versioned US issue-and-stance ontology (`src/scoring/stances.ts`). The ontology recognizes explicit propositions such as requiring congressional authorization for war, expanding immigration pathways, strengthening collective bargaining, or cutting federal spending. Posts with no directional evidence store `NULL` rather than being falsely labeled center; genuine mixed evidence can still land at 0.5.
- **Reproducible by construction:** the entire scale is committed lexicons, stance rules, and fixed weights (`src/scoring/lexicons.ts`, `stances.ts`, `score.ts`). Every score stores the signals that produced it (`lean_signals` / `position_signals`) and its `scorer_version` — surfaced verbatim in the app's **scorer receipts** UI. Changing any lexicon, stance, weight, or prior = bump `SCORER_VERSION` and `npm run rescore` to recompute everything from stored text. `npm run audit:posts` is a read-only preview of current versus proposed post scores.

## User spectrum, The Floor & moderation

- **User spectrum (`/users/:id/spectrum`)** is computed from activity, never self-declared: each scored post contributes its position at weight 3, each upvote contributes the voted content's lean at weight 1, each downvote the *mirror* of that lean. Votes on one's own posts are excluded. `/users/me/spectrum/history` replays the same math at each recent month-end for the profile trajectory sparkline.
- **The Floor (`/debates`)** auto-picks up to 6 daily rooms from the story clusters — `biggest` (top-scored), `contested` (deepest coverage from *both* wings), and `trending` fill — generated lazily and topped up per request. Users pin a position (`POST /debates/:id/vote`), which unlocks a 10-bin distribution + median and a shared thread. `GET /debates/recap` returns yesterday's rooms with their final numbers. The Floor's "day" is anchored to `America/New_York` so UTC rollover doesn't blank the evening's rooms.
- **Moderation** — `POST /reports` flags a post/article/comment/user (one live report per reporter per target); `POST`/`DELETE /users/:id/block` are one-directional blocks enforced in read queries (feed, comments, search, DMs); `GET /users/me/blocks` lists them. Admins (`userdata.is_admin`) review reports via `/admin/reports` and resolve with hide (content vanishes from all reads), ban (`is_banned` accounts are locked out at the auth layer), or dismiss.
- **Social** — one-directional follows (`POST`/`DELETE /users/:id/follow`, `GET /posts?feed=following`) and pair-keyed DMs (`/messages` inbox with unread counts, `/messages/with/:userId` threads) with push notifications on send.
- **Hardening** — sliding-window rate limits on every sensitive route (auth, uploads, posting, AI), a persistent per-user daily forumAI budget (`ai_usage`), email verification + reset codes (Resend, console fallback in dev), uploads re-encoded to bounded JPEGs with EXIF stripped, GIN-indexed full-text search, and env-gated Sentry + a DB-checking `/health`.

## Getting started

```bash
createdb forum                                   # once (or point DATABASE_URL elsewhere)
psql forum -f schema.sql                         # tables + topic seed
for m in migrations/*.sql; do psql forum -f "$m"; done   # apply migrations in order
psql forum -f seed.sql                           # dev subtopics + sample articles
cp .env.example .env                             # fill in JWT_SECRET (openssl rand -hex 32)
npm install
npm run dev                                      # http://localhost:3000
npm run seed:expand                              # lived-in community via the API
npm run ingest                                   # fetch + score real news into the article feed
npm run audit:posts                              # read-only scorer audit over stored posts
```

Dev logins after seeding: `john@example.dev` / `jane@example.dev` / `alice@example.dev`, password `password123` (john is an admin in dev).

`npm test` runs the vitest suite (scorer determinism, rate limiter, hashtag normalization, publisher-image validation, extracted-content quality, and bounded summary leads); CI runs typecheck + tests on every push. A `Dockerfile` is included for Railway/Fly/Render — see `../forum/LAUNCH.md` for the deploy walkthrough.

Seed scripts (all idempotent, run against the live API): `seed:dev` (minimal), `seed:community` (base community), `seed:expand` (larger community + posts, comments, votes, bookmarks, and Floor pins), and `seed:stances` (focused left/right/mixed scoring fixture for an existing mock community). The expansion includes the same substantive policy takes with expected score ranges, so seeding also catches stance-regression errors.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/signup` `{username,email,password}` | — | Create account → `{token, user}` |
| `POST /auth/login` `{email,password}` | — | Log in → `{token, user}` |
| `POST /auth/change-password` `{current_password,new_password}` | ✅ | Change password |
| `GET /auth/verify?token=` · `POST /auth/resend-verification` | Link / ✅ | Verify email or resend the verification link |
| `POST /auth/forgot-password` · `/reset-password` | — | Request and redeem an emailed reset code |
| `GET /users/me` · `PATCH /users/me` · `DELETE /users/me` | ✅ | Own profile (patch: username/bio/avatar_url/header_url) / delete account |
| `GET /users/me/spectrum` · `/history` | ✅ | Computed political placement + monthly trajectory |
| `GET /users/me/posts` · `/comments` · `/upvoted` | ✅ | Own content for the profile tabs |
| `GET /users?ids=` · `GET /users/:id` · `GET /users/:id/spectrum` | ✅ | Public profiles, follow/block state, counts, and computed spectrum |
| `GET /users/me/suggested` · `POST`/`DELETE /users/:id/follow` | ✅ | Onboarding suggestions and follow/unfollow |
| `POST`/`DELETE /users/me/push-token` | ✅ | Register or remove an Expo push token |
| `GET`/`PUT /users/me/notification-prefs` | ✅ | Read or update server-enforced push preferences |
| `POST`/`DELETE /users/:id/block` · `GET /users/me/blocks` | ✅ | Block / unblock / list blocked users |
| `GET /posts?topic_id=&user_id=&feed=following&limit=&offset=` | ✅ | Paginated feed (author + vote joined, blocked/hidden content filtered) |
| `POST /posts` `{content,media_url?,hashtags?}` | ✅ | Create post (spectrum position computed server-side) |
| `POST /posts/:id/vote` `{direction: up\|down\|null}` | ✅ | Vote / unvote (counters recomputed transactionally) |
| `GET /comments?post_id=\|article_id=\|debate_id=\|parent_comment_id=&page=&limit=` | ✅ | Paginated comments with reply counts |
| `POST /comments` `{post_id?\|article_id?\|debate_id?\|parent_comment_id?,content}` | ✅ | Comment or reply (on posts, articles, or debates) |
| `GET /articles?topic_id=&subtopic_id=&limit=&offset=` · `GET /articles/:id` | — | Paginated news (`my_vote`/`my_bookmark` joined when authed) |
| `POST /articles/:id/vote` `{direction: up\|down\|null}` | ✅ | Vote / unvote an article |
| `GET /topics` · `/topics/hot` · `/topics/subtopics/:id` | — | Topics, hot-topic carousel, subtopic detail + articles |
| `GET /debates` · `/debates/recap` · `/debates/:id` | ✅ | Today's Floor rooms, yesterday's recap, one room + distribution |
| `POST /debates/:id/vote` `{position: 0..1}` | ✅ | Drop / move your pin |
| `POST /bookmarks/toggle` `{post_id?\|article_id?}` · `GET /bookmarks` | ✅ | Save/unsave; list saved posts + articles |
| `GET /search?q=` | ✅ | Search users, sources, posts (+#hashtags), articles |
| `GET /sources/:name` | — | Source detail: rating, stats, content mix, recent coverage |
| `GET /messages` · `/unread-count` · `/with/:userId` | ✅ | DM inbox, unread total, and a read-marking conversation thread |
| `POST /messages/with/:userId` `{content}` | ✅ | Send a block-aware, rate-limited direct message |
| `POST /reports` `{target_kind,target_id,reason,detail?}` | ✅ | Flag a post/article/comment/user |
| `GET /admin/reports` · `POST /admin/reports/:id/resolve` | Admin | Review reports; hide, ban, or dismiss |
| `POST /storage/upload?filename=x.jpg` (raw bytes) | ✅ | Image upload → `{url}` (disk in dev, R2 when configured) |
| `POST /ai/chat` `{message,framing?,history?,article_id?,post_id?}` | ✅ | Daily-capped forumAI SSE stream, grounded in the article corpus |
| `GET /legal/terms` · `/legal/privacy` | — | Public legal pages |
| `GET /` · `/p/:id` · `/a/:id` | — | Product landing and Open Graph share pages with app deep links |

Auth: `Authorization: Bearer <jwt>`. Errors: `{error: string}` with a meaningful status.

## forumAI

`POST /ai/chat` streams Server-Sent Events (`delta` per perspective → `done`), so answers render token-by-token instead of after a long wait. The prompt is grounded via deterministic retrieval (`src/ai/retrieval.ts`) over the app's own recent article corpus. Topic-specific prompts use keyword relevance; broad prompts about the biggest story or latest headlines automatically use the generated hot-story index and recent articles, so an `article_id` is not required. Retrieved coverage is balanced across source-lean bands when the corpus permits and injected as context without adding an LLM to retrieval or scoring. Passing `article_id` or `post_id` still pins the chat to that subject; `history` carries in-session conversation memory. Requires `OPENAI_API_KEY` and is capped by `AI_DAILY_LIMIT` (50 by default).

## Configuration and secrets

Copy `.env.example` to `.env` for local development. `.env` is gitignored and must never be committed; `.env.example` contains names and safe defaults/placeholders only. Production secrets belong in the deployment provider:

- Required: `DATABASE_URL`, a strong `JWT_SECRET`
- forumAI: `OPENAI_API_KEY`, optional `AI_DAILY_LIMIT`
- Durable uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
- Email: `RESEND_API_KEY`, `EMAIL_FROM`, `LEGAL_CONTACT_EMAIL`
- Observability: optional `SENTRY_DSN`

TLS is configured explicitly in `src/db.ts`. Any `sslmode` query parameter is removed from the parsed database URL so `pg` cannot silently reinterpret it after a driver upgrade; local hosts remain non-TLS and remote hosts use the configured TLS object.

## Going to production

1. `neonctl projects create forum` → set `DATABASE_URL`, run `schema.sql` + `migrations/*.sql` + `seed.sql` against it (`scripts/setup.mjs` automates Neon + R2 provisioning).
2. Create an R2 bucket, enable public access, fill in the `R2_*` vars.
3. Set `OPENAI_API_KEY` for AI chat.
4. Deploy (e.g. `railway init && railway up`) and point the app at it via `EXPO_PUBLIC_API_URL`.

The Expo app auto-derives the API URL from the Metro dev-server host in development, so a phone on the same Wi-Fi works with zero config.
