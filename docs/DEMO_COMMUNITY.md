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

- a three-day author rotation gives every persona two concise posts;
- comments respond to another fictional account's post or a current Floor
  room;
- every newly ingested, feed-eligible publisher article receives two to five
  persona-shaped votes within roughly two hours; unclustered cards have an 8%
  comment rate and multi-source story cards have a 20% rate, with at most one
  clearly fictional headline-grounded community comment;
- post and comment reactions target only fictional social content; and
- Floor pins are persona-shaped with bounded variation instead of uniform or
  center-heavy placement.

Fresh posts target 25-65 words and use only clustered topic titles and
attributed publisher headlines as current-event context. They do not copy article bodies. Generated
posts and comments pass moderation. Article comments are limited to what the
attributed publisher headline establishes and cannot claim access to the full
article. A directional persona's post is also run
through the same content-only spectrum classifier as a real post. If its actual
argument is unclassified or points the opposite way, the generator gets one
natural rewrite attempt around a concrete supported or opposed policy. If the
rewrite remains inconsistent, the durable job retries with a fresh generation;
after its bounded attempts, that post is omitted instead of publishing generic
filler. Mechanical openings such as `On [headline]` and `As a [role]` are
rejected before storage. Persona lean validates the fixture but is never copied
into the stored score. Posts are stored with
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
Cheap vote jobs drain in a separate high-throughput lane from slower generated
posts and comments. Defaults are 300 vote jobs and 8 content jobs per run;
`DEMO_ACTIVITY_VOTE_BATCH_SIZE` and `DEMO_ACTIVITY_CONTENT_BATCH_SIZE` may tune
those bounded lanes without changing the cron schedule.

Failed content generation is retried twice at 30-minute intervals. Missing or
non-demo targets are skipped. An advisory lock and job-level deduplication make
concurrent or repeated runs safe. Directionally inconsistent generated posts
are never published; exhausted quality retries remain visible in job status and
worker warnings without being reported as operational Sentry exceptions.

## Removal after approval

First disable the worker. Then inspect the exact deletion scope:

```sh
npm run demo:cleanup
```

Only after the dry run is correct, apply the deletion:

```sh
DEMO_ACCOUNT_DELETE=DELETE_FICTIONAL_DEMO_ACCOUNTS npm run demo:cleanup
```

The command refuses to apply while `DEMO_ACTIVITY_ENABLED=yes`. It deletes only
rows where `userdata.is_demo = true`; foreign-key cascades remove their
credentials, posts, comments, votes, follows, persona records, and scheduled
jobs. In the same transaction it recalculates cached vote/comment totals on
publisher articles touched by demo activity. It does not delete the separate
App Review or owner accounts. Smoke-test empty states before manually releasing
the approved build.
