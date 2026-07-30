# forum-api

Backend for the forum app (`../forum`). Hono + Postgres, self-managed JWT auth, disk/R2 storage, deterministic bias scoring with real news ingestion, OpenAI-powered streaming AI chat. Replaces the old Supabase backend entirely.

## Stack

| Concern | Dev | Production |
|---|---|---|
| API | Hono on Node (`npm run dev`, port 3000) | Same code — deploy anywhere Node runs (Railway, Fly, ...) |
| Database | Local homebrew Postgres, db `forum` | Neon — swap `DATABASE_URL` |
| Auth | Email+password, scrypt hashes, HS256 JWTs (30-day) | Same |
| Storage | `./uploads` on disk, served at `/storage/files/*` | Cloudflare R2 — set the `R2_*` vars |
| News + scoring | `npm run ingest` | Dedicated hourly Railway cron with locking, retries, and persistent run status |
| Article analysis | Transient feed/page extraction + structured evidence | OpenAI when configured, deterministic fallback |
| AI chat | `POST /ai/chat` streamed (SSE) via OpenAI (`gpt-5.4-nano`) | Set `OPENAI_API_KEY` |

## Transient news analysis, bias scoring & hot-topic clustering

The article feed pulls RSS from 58 curated outlets across the political spectrum (`src/ingest/sources.ts`, kept approximately even between left/center/right), dedupes by URL/title hash, and restores the proven pre-conservative feed-first/page-fallback extractor from commit `29b905f`. A substantial feed body is preferred; otherwise the publisher page is passed through a readability extractor with timeouts and video-rail rejection. Run once with `npm run ingest`. Production runs the same command in a dedicated hourly Railway cron service; the API process never schedules ingestion.

Raw publisher text exists only in memory during one ingest item. It feeds deterministic scoring plus `src/ingest/article-evidence.ts`, which produces a one-way text hash, word count, original evidence summary, attributed claims, timeline facts, relationships, disputed points, entities, event terms, method, and confidence. The raw body is inserted as `NULL`, is not logged, and never enters public/admin APIs, R2, Sentry, or forumAI retrieval. OpenAI creates richer paraphrased evidence when configured; a daily cap or provider failure falls back to deterministic metadata evidence without dropping the article.

Publisher policy status and executable acquisition/public/analysis/AI/image modes remain in `src/ingest/source-rights.ts`. The status records policy risk; it no longer blanket-disables the product. Unregistered sources remain metadata-only. See [`docs/ARTICLE_RIGHTS.md`](docs/ARTICLE_RIGHTS.md) for exact invariants, feature flags, and staged rollout.

After every ingest pass (or via `npm run cluster`), `src/ingest/cluster.ts` groups the last 7 days using headlines plus evidence search terms, entities, events, outlet diversity, and time. Each article is compared with a fixed founding-story profile, followed by a fixed-profile merge pass, so a cluster cannot snowball into unrelated topics. Automatic membership is rebuilt on every run. Clusters with 3+ articles from 2+ outlets become subtopics: the title is a member headline, the short summary is an original coverage note, and the long summary compares one attributed evidence summary (or headline fallback) from each available spectrum band. `volume` is the real article+post count, and `public_position` is the average scored position of matched user posts.

Publisher images use four explicit delivery modes: `none`, `remote_no_cache`, `managed_thumbnail`, and `licensed_cache`. Managed mode downloads at most 15 MB, validates the response as an image, strips metadata, and writes only 640px/1280px WebP variants to R2. The row retains source URL/hash, dimensions, status, cache time, and expiry. Any download/decoder/R2/configuration failure falls back to the remote preview so the article remains usable.

**Hashtags** are the organizing layer instead of fixed categories: articles get them auto-extracted from their keywords; users pick their own when posting (`POST /posts` accepts `hashtags[]`, plus inline `#tags` in the text). The 7 general topics still exist silently as background metadata.

Scoring (`src/scoring/`) is **deterministic — no LLM, no black box**:

- **Lean (0 = left, 1 = right):** begins with the outlet prior and may shift from framing found in the transient body. Receipts record whether extraction used a feed, page, or metadata fallback without storing the analyzed prose.
- **Fact vs. opinion:** URL sections, feed categories, and permitted text classify `factual_report` / `news_report` / `analysis` / `opinion`. Headline-only rows do not pretend to have body-derived subjectivity evidence.
- **Posts:** no outlet prior exists, so post placement combines partisan framing with a versioned US issue-and-stance ontology (`src/scoring/stances.ts`). The ontology recognizes explicit propositions such as requiring congressional authorization for war, expanding immigration pathways, strengthening collective bargaining, or cutting federal spending. Posts with no directional evidence store `NULL` rather than being falsely labeled center; genuine mixed evidence can still land at 0.5.
- **Reproducible by construction:** the scale is committed lexicons, stance rules, fixed weights, and source/evidence versions. New articles are scored before raw text is discarded; later rescoring uses structured `search_text`, not a retained publisher body.

## User spectrum, The Floor & moderation

- **User spectrum (`/users/:id/spectrum`)** is computed from activity, never self-declared: each scored post contributes its position at weight 3, each upvote contributes the voted content's lean at weight 1, each downvote the *mirror* of that lean. Votes on one's own posts are excluded. `/users/me/spectrum/history` replays the same math at each recent month-end for the profile trajectory sparkline.
- **The Floor (`/debates`)** auto-picks up to 6 daily rooms from the story clusters — `biggest` (top-scored), `contested` (deepest coverage from *both* wings), and `trending` fill — generated lazily and topped up per request. Users pin a position (`POST /debates/:id/vote`), which unlocks a 10-bin distribution + median and a shared thread. `GET /debates/recap` returns yesterday's rooms with their final numbers. The Floor's "day" is anchored to `America/New_York` so UTC rollover doesn't blank the evening's rooms.
- **Pre-publication moderation** — posts, comments, DMs, usernames, bios, forumAI prompts, and user images pass narrow deterministic hard stops followed by `omni-moderation-latest`. Images are checked before R2 upload. Provider outage fails closed with a retryable 503; rejection uses a neutral 422. Audits retain only hashes and decision metadata, never rejected raw content. Publisher articles are excluded.
- **Reports and blocks** — `POST /reports` flags a post/article/comment/user; blocks are enforced in feeds, comments, search, follows, and DMs. Admins review reports and separately resolve flagged mock-corpus moderation records.
- **Private accounts** — follows have pending/accepted states. Unapproved visitors see basic profile identity and spectrum but not collected Posts/Comments/Upvoted/Saved history; individually encountered content remains eligible for feeds, search, and threads. Blocking removes follow relationships.
- **Notifications** — Push and Email preferences exist per replies/upvotes/DMs/follows. Email delivery is globally opt-in and requires a verified address; replies and DMs send immediately and upvotes coalesce per post.
- **Hardening** — every authenticated request re-resolves the user, so deleted or banned accounts invalidate old JWTs immediately. Sliding-window rate limits protect sensitive routes, uploads are re-encoded with EXIF stripped, Sentry redacts PII/tokens, and `/health` checks Postgres.
- **Deletion and feedback** — account deletion transactionally enqueues public/private R2 cleanup with retries and a 24-hour alert. Structured beta feedback stores device/build context and optional screenshots in a separate private bucket; only admins receive short-lived signed URLs.
- **Reliable ingestion** — a Postgres advisory lock prevents overlap, database and per-source failures retry independently, clustering remains in the successful flow, and `ingest_runs` records totals, failures, duration, and freshness.

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

Local seed accounts are development fixtures only. Set or rotate their
passwords locally after seeding; production and App Review credentials must
never be written in this repository.

`npm test` runs the vitest suite, including complete source-policy coverage, transient feed handling, evidence fallback, raw-content API exclusion, managed-image projection, metadata extraction, scorer determinism, rate limiting, and moderation. CI runs typecheck + tests on every push.

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
| `GET /users/me/suggested` · `POST`/`DELETE /users/:id/follow` | ✅ | Follow, request, cancel, or unfollow |
| `GET /users/me/follow-requests` · `POST /users/follow-requests/:id/accept` · `/decline` | ✅ | List and resolve incoming private-account requests |
| `DELETE /users/:id/follower` | ✅ | Remove an accepted follower |
| `POST`/`DELETE /users/me/push-token` | ✅ | Register or remove an Expo push token |
| `GET`/`PUT /users/me/notification-prefs` | ✅ | Channel/event preferences; accepts the legacy flat push shape during migration |
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
| `GET /search?q=&topic_id=` | ✅ | Ranked article/post search with matching story clusters and full-corpus counts; exact metadata matches rank first, adjacent headline/event phrases add controlled recall, and counts use the same predicate as results |
| `GET /sources/:name` | — | Source detail: rating, stats, content mix, recent coverage |
| `GET /messages` · `/unread-count` · `/with/:userId` | ✅ | DM inbox, unread total, and a read-marking conversation thread |
| `POST /messages/with/:userId` `{content}` | ✅ | Send a block-aware, rate-limited direct message |
| `POST /reports` `{target_kind,target_id,reason,detail?}` | ✅ | Flag a post/article/comment/user |
| `GET /admin/reports` · `POST /admin/reports/:id/resolve` | Admin | Review reports; hide, ban, or dismiss |
| `POST /feedback` · `POST /feedback/screenshot` | ✅ | Create structured beta feedback and optional private screenshot |
| `GET /admin/feedback` · `PATCH /admin/feedback/:id` | Admin | Triage feedback, status, and notes |
| `GET /admin/moderation` · `POST /admin/moderation/:id/resolve` | Admin | Review flagged existing-corpus records |
| `GET /admin/ingest-status` | Admin | Recent ingest runs, freshness, and source failures |
| `GET /admin/source-rights` | Admin | Reviewed policy and active text/AI/image modes for all publishers |
| `POST /admin/articles/:id/purge-media` | Admin | Immediate R2 + API takedown of one article image |
| `POST /storage/upload?filename=x.jpg` (raw bytes) | ✅ | Image upload → `{url}` (disk in dev, R2 when configured) |
| `POST /ai/chat` `{message,framing?,history?,article_id?,post_id?}` | ✅ | Daily-capped forumAI SSE stream, grounded in the article corpus |
| `GET /legal/terms` · `/legal/privacy` | — | Public legal pages |
| `GET /` · `/p/:id` · `/a/:id` | — | Product landing and Open Graph share pages with app deep links |

Auth: `Authorization: Bearer <jwt>`. Errors: `{error: string}` with a meaningful status.

## forumAI

`POST /ai/chat` streams Server-Sent Events (`delta` per perspective → `done`). Retrieval uses headline, publisher link, source/date/lean, entities, events, original evidence summaries, attributed claims, and timelines. It distinguishes a single outlet's assertion from cross-source agreement. Publisher article bodies never enter chat retrieval because they are not retained.

## Configuration and secrets

Copy `.env.example` to `.env` for local development. `.env` is gitignored and must never be committed; `.env.example` contains names and safe defaults/placeholders only. Production secrets belong in the deployment provider:

- Required: `DATABASE_URL`, a strong `JWT_SECRET`
- forumAI: `OPENAI_API_KEY`, optional `AI_DAILY_LIMIT`
- Transient analysis: `ARTICLE_TRANSIENT_ANALYSIS_ENABLED`, `ARTICLE_STRUCTURED_EVIDENCE_ENABLED`, `ARTICLE_ANALYSIS_MODEL`, and `ARTICLE_ANALYSIS_DAILY_LIMIT`
- Managed previews: `ARTICLE_MANAGED_IMAGES_ENABLED` and `ARTICLE_IMAGE_CACHE_DAYS`
- Durable uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`; private feedback additionally requires `R2_FEEDBACK_BUCKET_NAME`
- Email: `RESEND_API_KEY`, `EMAIL_FROM`, `SUPPORT_EMAIL`, `LEGAL_CONTACT_EMAIL`, and `WEB_APP_URL`
- Observability: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`; external beta remains blocked without working Sentry

TLS is configured explicitly in `src/db.ts`. Any `sslmode` query parameter is removed from the parsed database URL so `pg` cannot silently reinterpret it after a driver upgrade; local hosts remain non-TLS and remote hosts use the configured TLS object.

## Going to production

1. Apply numbered migrations before deploying a new mobile binary. For migrations 017–018 and the dry-run-first evidence/media backfill, follow `docs/ARTICLE_RIGHTS.md`.
2. Create a public media R2 bucket and a separate private feedback bucket (`npm run storage:feedback`); never enable public access on feedback.
3. Deploy the API with `/health` as the Railway health check.
4. Deploy the same repository as a Railway cron service with start command `npm run ingest`, schedule `0 * * * *`, and restart policy `Never`.
5. Set `OPENAI_API_KEY`, an explicit `AI_DAILY_LIMIT`, and Sentry. Configure Resend only after a permanent sending domain has SPF/DKIM/DMARC.
6. Create owner/admin and non-admin reviewer accounts with `npm run account:release`; credentials belong in a password manager/App Store Connect, never this repository.

The Expo app auto-derives the API URL from the Metro dev-server host in development, so a phone on the same Wi-Fi works with zero config.
