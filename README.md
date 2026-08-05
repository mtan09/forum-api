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
| AI chat | `POST /ai/chat` streamed (SSE) via OpenAI (`gpt-5.4-nano`) | Set `OPENAI_API_KEY` |
| Review fixtures | Off by default | Dedicated 10-minute Railway cron running `npm run demo:activity` while `DEMO_ACTIVITY_ENABLED=yes` |

## News ingestion, bias scoring & hot-topic clustering

The article feed is real: `src/ingest/` pulls RSS from 58 curated outlets across the political spectrum (`src/ingest/sources.ts`, kept roughly even between left/center/right), transiently extracts text, dedupes by URL/content hash, gates on political relevance, derives bounded analysis fields, scores, and inserts as `ready`. The extracted body is never written to PostgreSQL. Run once with `npm run ingest`. Production runs the same command in a dedicated hourly Railway cron service; the API process never schedules ingestion.

Publisher data is treated as untrusted. Image selection prefers a feed's canonical enclosure, validates every source with the same URL rules, rejects malformed article-URL-plus-caption metadata, and falls back to a valid page image. Full-text extraction rejects timestamp-heavy video-player/navigation rails from any publisher and falls back to the cleaner RSS text instead, so unrelated video headlines do not pollute scoring or story summaries.

**Nothing is hand-written.** After every ingest pass (or via `npm run cluster`), `src/ingest/cluster.ts` groups the last 7 days of articles into stories using one-way weighted term identifiers derived during ingestion. Each article is compared with a fixed founding-story profile, followed by a union-find merge pass over fixed profiles, so a cluster cannot accumulate vocabulary and snowball into unrelated topics. Automatic article membership is rebuilt on every clustering run rather than retaining stale links. Clusters with 3+ articles from 2+ outlets become subtopics — the "hot topics" carousel (`GET /topics/hot`) and summary screens use a real member headline for the story title, an original outlet-count coverage note, and one attributed publisher **headline** per Left/Center/Right band. Article-body sentences are neither stored nor used in public summaries. `volume` is the real article+post count, and `public_position` is the average scored position of matched user posts. Deterministic — no LLM anywhere in the clustering pipeline.

Every configured publisher has an explicit forumAI allow or block decision with
a shared recorded policy-review date and delivery/analysis modes. The allowed
and blocked sets are exhaustive and disjoint under test, so an unknown or newly
added source fails closed until it receives a reviewed decision.

**Hashtags** are the organizing layer instead of fixed categories: articles get them auto-extracted from their keywords; users pick their own when posting (`POST /posts` accepts `hashtags[]`, plus inline `#tags` in the text). The 7 general topics still exist silently as background metadata.

Scoring (`src/scoring/`) is **deterministic — no LLM, no black box**:

- **Lean (0 = left, 1 = right):** starts from the outlet's published lean rating (AllSides/Ad Fontes approximations in `sources.ts`), then shifts by at most ±0.25 based on partisan framing vocabulary in the text (Gentzkow–Shapiro-style term pairs: "estate tax"/"death tax", "undocumented"/"illegal alien", ...). Framing counts only outside quotations and is capped per term.
- **Fact vs. opinion:** a separate subjectivity score (loaded language, first person, opinion markers, quote density) plus URL/section heuristics classifies each piece as `factual_report` / `news_report` / `analysis` / `opinion`. The app shows reporting with a "Source Lean" bar and a badge instead of claiming the article itself has a measured slant.
- **Posts:** no outlet prior exists, so post placement uses a layered, versioned classifier: high-precision partisan framing, direct proposition rules, subject-plus-predicate composition, a local reviewed-prototype fallback for natural paraphrases, and lower-weight contextual alignment for explicit coalition/value arguments (`src/scoring/stances.ts`, `semantic-stances.ts`). It handles support, opposition, quotation, indirect attribution, and explicit disclaimers without using the author's identity or activity. Posts with no directional evidence store `NULL` rather than being falsely labeled center; genuine mixed evidence can still land at 0.5.
- **Reproducible by construction:** the entire scale is committed lexicons, stance rules, local prototypes, and fixed weights (`src/scoring/lexicons.ts`, `stances.ts`, `semantic-stances.ts`, `score.ts`). No post text leaves forum for spectrum placement. Every score stores the evidence span, detection method, confidence, and scorer version — surfaced in the app's **scorer receipts** UI. `npm run audit:posts` shadow-compares stored and proposed scores plus the reviewed regression corpus. `npm run rescore:posts` is a dry run unless explicitly passed `--apply`; `npm run rescore` also refetches article pages for transient article recomputation without storing bodies.

## User spectrum, The Floor & moderation

- **User spectrum (`/users/:id/spectrum`)** is computed from activity, never self-declared: each scored post contributes its position at weight 3, each upvote contributes the voted content's lean at weight 1, each downvote the *mirror* of that lean. Votes on one's own posts are excluded. `/users/me/spectrum/history` replays the same math at each recent month-end for the profile trajectory sparkline.
- **The Floor (`/debates`)** auto-picks up to 6 daily rooms from the story clusters — `biggest` (top-scored), `contested` (deepest coverage from *both* wings), and `trending` fill — generated lazily and topped up per request. Users pin a position (`POST /debates/:id/vote`), which unlocks a 10-bin distribution + median and a shared thread. `GET /debates/recap` returns yesterday's rooms with their final numbers. The Floor's "day" is anchored to `America/New_York` so UTC rollover doesn't blank the evening's rooms.
- **Pre-publication moderation and AI consent** — forum's narrow deterministic hard stops run first for every user. A versioned, explicit permission record is required before any user content is sent to OpenAI's `omni-moderation-latest`; existing users are not grandfathered. With permission, text receives OpenAI's broader additional check. After decline or withdrawal, text posts, comments, DMs, and profile edits remain available under forum's rules and never reach OpenAI. Image uploads and forumAI require permission because those features inherently use OpenAI image-safety or generation. Provider outage fails closed with a retryable 503 when an OpenAI check is used; rejection uses a neutral 422; missing consent for an OpenAI-dependent feature uses a distinct 428. Audits retain only hashes and decision metadata, never rejected raw content. Publisher articles are excluded from moderation.
- **Reports and blocks** — `POST /reports` flags a post/article/comment/user or a received DM. Message reports are limited to the recipient; admins can hide the reported message, ban its sender, or dismiss it. Blocks are enforced in feeds, comments, search, follows, and DMs. Admins separately resolve flagged mock-corpus moderation records.
- **Private accounts** — follows have pending/accepted states. Unapproved visitors see basic profile identity and spectrum but not collected Posts/Comments/Upvoted/Saved history; individually encountered content remains eligible for feeds, search, and threads. Blocking removes follow relationships.
- **Notifications** — Push and Email preferences exist per replies/upvotes/DMs/follows. Email delivery is globally opt-in and requires a verified address; replies and DMs send immediately and upvotes coalesce per post. Successful Expo ticket IDs are persisted, their APNs/FCM receipts are checked after the recommended delay, and dead device tokens are removed.
- **Hardening** — every authenticated request re-resolves the user, so deleted or banned accounts invalidate old JWTs immediately. Sliding-window rate limits protect sensitive routes, uploads are re-encoded with EXIF stripped, Sentry redacts PII/tokens, and `/health` checks Postgres.
- **Deletion and feedback** — account deletion immediately removes structured feedback along with the profile and other account data, then transactionally enqueues public/private R2 cleanup with retries and a 24-hour alert. While an account exists, structured feedback stores device/build context and optional screenshots in a separate private bucket; only admins receive short-lived signed URLs.
- **Reliable ingestion** — a Postgres advisory lock prevents overlap, database and per-source failures retry independently, clustering remains in the successful flow, and `ingest_runs` records totals, failures, duration, and freshness.
- **Temporary review community** — the initial prelaunch database can run 31 visibly labeled fictional personas with distinct bios, viewpoints, interests, and voices. Durable jobs stagger posts, comments, reactions, and Floor pins; generated content is moderated, auditable, and idempotent. The worker is explicitly enabled and has a guarded post-approval cleanup. See `docs/DEMO_COMMUNITY.md`.

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
npm run scrub:article-bodies                     # dry-run profile/parity audit; guarded apply removes legacy bodies
npm run audit:posts                              # read-only scorer audit over stored posts
npm run rescore:posts                            # dry-run post backfill; add -- --apply deliberately
```

Local seed accounts are development fixtures only. Set or rotate their
passwords locally after seeding; production and App Review credentials must
never be written in this repository.

`npm test` runs the vitest suite (scorer determinism and labeled-corpus thresholds, rate limiter, hashtag normalization, publisher-image URL validation, extracted-content quality, and headline-only perspective summaries); CI runs typecheck + tests on every push. A `Dockerfile` is included for Railway/Fly/Render — see `../forum/LAUNCH.md` for the deploy walkthrough.

Seed scripts (all idempotent, run against the live API): `seed:dev` (minimal), `seed:community` (base community), `seed:expand` (larger community + posts, comments, votes, bookmarks, and Floor pins), and `seed:stances` (focused left/right/mixed scoring fixture for an existing mock community). The expansion includes the same substantive policy takes with expected score ranges, so seeding also catches stance-regression errors.

For App Review, migration 020 and `npm run harden:demo` convert the seeded
`@example.dev` fixtures into locked fictional demo accounts. Migration 021 adds
the transient-analysis profile and source-level forumAI eligibility fields;
migration 022 adds idempotent jobs for reactions to newly ingested articles. With
`DEMO_ACTIVITY_ENABLED=yes`, `npm run demo:activity` syncs their unique bios and
personas, plans staggered concise posts, comments, votes, article reactions, and Floor
activity, and executes due vote/content lanes independently. Every incoming
feed-eligible article is eventually planned even when an ingest burst exceeds a
single cron pass. It is safe to invoke
frequently. After approval, disable the worker, preview `npm run demo:cleanup`,
then apply only with the exact guarded value documented in
`docs/DEMO_COMMUNITY.md`.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/signup` `{username,email,password,ai_consent_accepted,ai_consent_version}` | — | Create an unverified account with an explicit allow/decline AI decision → `{token, user}`; no email is sent until onboarding requests it |
| `POST /auth/login` `{email,password}` | — | Log in → `{token, user}` |
| `POST /auth/change-password` `{current_password,new_password}` | ✅ | Change password |
| `GET /auth/verify?token=` · `POST /auth/resend-verification` | Link / ✅ | Verify email, or request/replace the verification link when the verification UI is reached |
| `POST /auth/forgot-password` · `/reset-password` | — | Request and redeem an emailed reset code |
| `GET /users/me` · `PATCH /users/me` · `DELETE /users/me` | ✅ | Own profile (patch: username/bio/avatar_url/header_url) / delete account |
| `GET`/`PUT /users/me/ai-consent` | ✅ | Inspect, grant, decline, or withdraw versioned OpenAI processing permission |
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
| `GET /search?q=&topic_id=` | ✅ | Ranked article/post search with matching story clusters and full-corpus counts; `topic_id` opens the complete result set for a hot story |
| `GET /sources/:name` | — | Source detail: rating, stats, content mix, recent coverage |
| `GET /messages` · `/unread-count` · `/with/:userId` | ✅ | DM inbox, unread total, and a read-marking conversation thread; admin-hidden messages are omitted |
| `POST /messages/with/:userId` `{content}` | ✅ | Send a block-aware, rate-limited direct message |
| `POST /reports` `{target_kind,target_id,reason}` | ✅ | Report content, users, or a DM received by the caller |
| `POST /reports` `{target_kind,target_id,reason,detail?}` | ✅ | Flag a post/article/comment/user |
| `GET /admin/reports` · `POST /admin/reports/:id/resolve` | Admin | Review reports; hide, ban, or dismiss |
| `POST /feedback` · `POST /feedback/screenshot` | ✅ | Create structured feedback and optional private screenshot |
| `GET /admin/feedback` · `PATCH /admin/feedback/:id` | Admin | Triage feedback, status, and notes |
| `GET /admin/moderation` · `POST /admin/moderation/:id/resolve` | Admin | Review flagged existing-corpus records |
| `GET /admin/ingest-status` | Admin | Recent ingest runs, freshness, and source failures |
| `GET /admin/demo-activity-status` | Admin | Temporary review-fixture worker state and recent job outcomes |
| `POST /storage/upload?filename=x.jpg` (raw bytes) | ✅ | Image upload → `{url}` (disk in dev, R2 when configured) |
| `POST /ai/chat` `{message,framing?,history?,article_id?,post_id?}` | ✅ | Daily-capped forumAI SSE stream grounded in eligible headlines, forum story metadata, and consented community context |
| `GET /legal/terms` · `/legal/privacy` | — | Public legal pages |
| `GET /` · `/p/:id` · `/a/:id` | — | Product landing and Open Graph share pages with app deep links |

Auth: `Authorization: Bearer <jwt>`. Errors: `{error: string}` with a meaningful status.

## forumAI

`POST /ai/chat` streams Server-Sent Events (`delta` per perspective → `done`), so answers render token-by-token instead of after a long wait. Deterministic retrieval (`src/ai/retrieval.ts`) ranks eligible recent headlines using the stored bounded analysis profile. Broad prompts about the biggest story or latest headlines use generated hot-story metadata and eligible recent headlines, so an `article_id` is not required. Context is balanced across source-lean bands when possible. Publisher bodies are not stored or sent to OpenAI; publishers with explicit AI/automation restrictions are excluded, and unknown publishers fail closed. Passing an eligible `article_id` or a consented `post_id` can pin the chat to that subject; restricted article IDs return `ARTICLE_AI_CONTEXT_UNAVAILABLE` without consuming the daily allowance. `history` carries in-session conversation memory. Requires `OPENAI_API_KEY` and is capped by `AI_DAILY_LIMIT` (50 by default).

## Configuration and secrets

Copy `.env.example` to `.env` for local development. `.env` is gitignored and must never be committed; `.env.example` contains names and safe defaults/placeholders only. Production secrets belong in the deployment provider:

- Required: `DATABASE_URL`, a strong `JWT_SECRET`
- forumAI: `OPENAI_API_KEY`, optional `AI_DAILY_LIMIT`
- Temporary App Review fixtures: `DEMO_ACTIVITY_ENABLED=yes`, optional `DEMO_ACTIVITY_MODEL`, `DEMO_ACTIVITY_VOTE_BATCH_SIZE`, and `DEMO_ACTIVITY_CONTENT_BATCH_SIZE`; remove or disable after approval
- Durable uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`; private feedback additionally requires `R2_FEEDBACK_BUCKET_NAME`
- Email/public links: `RESEND_API_KEY`, `EMAIL_FROM`, `SUPPORT_EMAIL`,
  `LEGAL_CONTACT_EMAIL`, `WEB_APP_URL`, and `PUBLIC_API_URL`
- Observability: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`; App Store release testing remains blocked without working Sentry. `SENTRY_RELEASE` is preferred when supplied, while Railway deployments fall back to the Git commit SHA or deployment ID so every captured event still has a release tag.

The current production sender is
`forum <accounts@updates.forumeveryside.com>`. Public support and privacy pages
are `https://api.forumeveryside.com/support` and
`https://api.forumeveryside.com/legal/privacy`; both contact addresses resolve
to `support@forumeveryside.com`. The production browser client is
`https://mtan-forum.expo.app`, which is the current `WEB_APP_URL`.
`PUBLIC_API_URL=https://api.forumeveryside.com` ensures verification links use
the public HTTPS origin even though Railway terminates TLS before Node.

TLS is configured explicitly in `src/db.ts`. Any `sslmode` query parameter is removed from the parsed database URL so `pg` cannot silently reinterpret it after a driver upgrade; local hosts remain non-TLS and remote hosts use the configured TLS object.

## Going to production

1. Apply numbered migrations before deploying a new mobile binary. Migration 016 retains the seeded test personas while removing John’s admin access; migration 017 adds explicit AI consent evidence and durable Expo push receipts; migration 020 identifies fictional accounts and adds the durable temporary activity queue; migration 021 adds derived article profiles and source-policy eligibility; migration 023 makes structured feedback cascade with account deletion. After the updated API and ingest services are live, run the guarded article-body scrub and verify its database constraint.
2. Create a public media R2 bucket and a separate private feedback bucket (`npm run storage:feedback`); never enable public access on feedback.
3. Deploy the API with `/health` as the Railway health check.
4. Deploy the same repository as a Railway cron service with start command `npm run ingest`, schedule `0 * * * *`, and restart policy `Never`.
5. Set `OPENAI_API_KEY`, an explicit `AI_DAILY_LIMIT`, and Sentry. Production email sends from `accounts@updates.forumeveryside.com`; keep the Resend API key in Railway only and retain the verified SPF/DKIM/DMARC records in Cloudflare.
6. Create separate owner/admin and non-admin reviewer accounts with `npm run account:release`. The utility marks the controlled address verified, clears suspension/privacy state, and makes only the `owner` role an admin; updating with `RELEASE_ACCOUNT_ROLE=reviewer` removes admin access. Supply `RELEASE_ACCOUNT_PASSWORD` from a password manager and set `RELEASE_ACCOUNT_PRINT_PASSWORD=no` when logs must not echo it. Credentials belong in a password manager/App Store Connect, never this repository. Local legacy seed scripts likewise require `FORUM_DEV_SEED_PASSWORD` from a gitignored environment rather than embedding a credential. When running `npm run verify:release`, supply the retired fixture credential as `RELEASE_LEGACY_DEMO_PASSWORD` only in that one-off invoking shell so the check can prove it no longer works.
7. Preview seeded-persona release cleanup with `npm run harden:demo`, then apply it only with `DEMO_ACCOUNT_APPLY=yes npm run harden:demo`. It targets the exact `example.dev` domain, preserves posts/comments, replaces remote profile media with the app default, labels profiles as fictional demos, rotates every shared password, and removes notification/AI-consent state.
8. For the disclosed prelaunch fixture, add a separate Railway cron with `npm run demo:activity` every ten minutes and set `DEMO_ACTIVITY_ENABLED=yes` only on that service. Check `/admin/demo-activity-status`. Choose manual App Store release; after approval, disable the worker and run the guarded cleanup before releasing the same approved build.
9. Treat recovery as production-ready only after a controlled account receives a six-digit reset code and completes the reset in the iOS app. A successful API response alone is intentionally non-enumerating and does not prove that Resend delivered the message.

The Expo app auto-derives the API URL from the Metro dev-server host in development, so a phone on the same Wi-Fi works with zero config.
