# Temporary App Review demo community

forum has no public users before its first App Store review. Production can
therefore run a temporary, clearly disclosed fictional community so reviewers
can exercise populated feeds, profiles, comments, recommendations, and The
Floor.

## What is simulated

The controlled `@example.dev` accounts are marked `userdata.is_demo = true`.
The mobile client renders `(Fictional demo account)` beside their names and a
deterministically colored, forum-owned logo avatar. `src/demo/personas.ts`
defines a persistent fictional role, bio, political lean, interests, and voice
for every account.

The demo worker plans staggered activity with durable jobs:

- a three-day author rotation ensures every persona posts;
- comments respond to another fictional account's post or a current Floor
  room;
- reactions target only fictional posts and comments; and
- Floor pins are persona-shaped with bounded variation instead of uniform or
  center-heavy placement.

Fresh posts use only clustered topic titles and attributed publisher
headlines as current-event context. They do not copy article bodies. Generated
posts and comments pass moderation and are stored with
`is_demo_generated = true` and a unique `demo_job_id`. Votes are idempotent
upserts. The worker never uses demo-account passwords and sends no notification
for its direct database writes.

## Operation

The worker is inert unless `DEMO_ACTIVITY_ENABLED=yes` is present. Run one pass
with:

```sh
npm run demo:activity
```

A dedicated Railway cron service should invoke that command every ten minutes.
`GET /admin/demo-activity-status` reports enabled state, account count, job
counts, and recent outcomes without exposing generated content or credentials.

Failed content generation is retried twice at 30-minute intervals. Missing or
non-demo targets are skipped. An advisory lock and job-level deduplication make
concurrent or repeated runs safe.

## Removal after approval

First disable the worker. Then inspect the exact deletion scope:

```sh
npm run demo:cleanup
```

Only after the dry run is correct, apply the deletion:

```sh
DEMO_ACCOUNT_DELETE=DELETE_FICTIONAL_DEMO_ACCOUNTS npm run demo:cleanup
```

The command deletes only rows where `userdata.is_demo = true`; foreign-key
cascades remove their credentials, posts, comments, votes, follows, persona
records, and scheduled jobs. It does not delete the separate App Review or
owner accounts. Smoke-test empty states before manually releasing the approved
build.
