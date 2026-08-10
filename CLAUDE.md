# forum-api

Hono + Postgres + JWT, deployed on Railway. Serves the iOS and web clients in
the sibling repo at `../forum`.

## Commits

**Never list Claude as a contributor.** No `Co-Authored-By` trailer, no
"Generated with" footer. Commits are authored solely by the repo owner.

## Deploying — read this before running `railway up`

The Railway project contains **four services built from this one repo**:

| service | role |
|---|---|
| `forum-api` | the HTTP API — `api.forumeveryside.com` |
| `forum-ingest` | cron, hourly — article ingest |
| `forum-demo-activity` | cron, every 10 min — demo persona activity |
| `forum-daily-brief` | cron, every 15 min — opted-in Daily Brief delivery and retention |

**This directory is linked to `forum-demo-activity`, not `forum-api`.** A bare
`railway up` deploys the cron service and silently leaves the API on the old
build. Always name the target:

```
railway up --service forum-api --detach
```

Then confirm the deployment landed on the service you meant, and that the API is
actually up:

```
curl -s https://api.forumeveryside.com/health     # {"status":"ok","db":"ok"}
```

## Checks

```
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
```

## Scoring

Deliberately deterministic and auditable: every input is a committed, diffable
word list rather than model weights. Same text always produces the same score,
and every score stores the signals that produced it plus the scorer version, so
any placement can be explained and any row re-scored.

**Any change to a lexicon, rule, weight, or threshold is a scale change.** Bump
the version in `src/scoring/score.ts` and re-score, or stored values stop being
comparable:

```
npm run rescore          # articles
npm run rescore:posts     # posts
npm run audit:posts       # read-only before/after harness
```

`position = null` means *unclassified*, not centrist. Preserve that — placing a
neutral post is worse than leaving it unplaced. `audit:posts` reports
`neutral_false_placement_rate`, which must stay 0.

### The post scorer is a three-stage pipeline (`claims-4.0.0`)

`scorePost` runs claim extraction → coalition mapping → calibration:

| stage | file | holds politics? |
|---|---|---|
| A · what does the author want | `claims.ts` (+ `stances.ts` phrase library) | no |
| B · which side is that | `direction.ts`, `story-context.ts` | **yes — only here** |
| C · where on the scale | `score.ts` | no |

**`direction.ts` is the only file in the scorer holding a political judgement.**
Topics are named as the quantity being increased (`gun-regulation`,
`gun-rights`), which is what lets "ban assault weapons" read as *more*
gun-regulation without per-domain exceptions. Polarity is a field on the claim,
so "I oppose cutting Medicaid" flips rather than being discarded. `contested` is
a real answer for issues whose mapping has moved — tariffs, platform speech,
antitrust, AI.

Framing vocabulary splits in two. **Naming terms** ("estate tax", "Affordable
Care Act") are used by both coalitions and can only intensify a placement, never
create one — treating them as placement signals is what scored "the Affordable
Care Act should be repealed" left of centre. **Epithets** ("woke", "big oil")
are pejorative, so reaching for one is itself the alignment and does place a
post.

`story-context.ts` resolves claims about named people from article headlines per
story, refreshed by ingest, and the resolved map is written into
`position_signals` so `rescore:posts` replays the judgement made at score time
rather than re-deriving against a newer news cycle.

**Every unplaced post now records why** — `no-claim`, `contested`,
`unmapped-topic`, `unmapped-actor`. `audit:posts` reports the breakdown. The
first two are correct outcomes; the last two are coverage gaps worth shrinking.

### Two deferred pieces of work — read before touching the scorer

**1. There is still no way to prove a scoring change is an improvement.**
`src/scoring/evaluation-corpus.ts` reports near-100% because it was written
alongside the rules it tests, and it will bless a change that makes things
worse. `generated_demo_direction.rate` is less circular but is *also*
contaminated: demo posts the old scorer could not classify were rejected at
write time and never published, so the surviving corpus is selected to suit
`stance-3.0.0`. Measured on it, `claims-4.0.0` scores 0.656 against the old
0.688 — which is not evidence either way.

**A hand-labelled holdout set is the prerequisite for any further tuning.**
Until it exists, do not claim an accuracy improvement, and do not tune against
`evaluation-corpus.ts` — that is how the current overfitting happened. Deferred
deliberately, 2026-08-08.

**2. The demo generator has not been adapted to the new scorer.**
`createPost` (`src/demo/activity.ts`) rejects a directional persona's post
unless `scorePost` already places it correctly, and it calls `scorePost` without
story context — unlike `routes/posts.ts`, which passes it. Each rejection burns
up to six model generations and throws the text away.

**Measured 2026-08-09, and it contradicts what this section first predicted.**
The rejection rate did *not* get worse: `stance-3.0.0` rejected 40 of 124 post
jobs (32.3%), `claims-4.0.0` rejected 6 of 20 (30.0%). Small sample, but the
concern that entity-heavy posts would fail more often is not showing up. What
*is* visible: 5 of those 6 rejections were right-leaning posts, which would
point at thinner right-side coverage in the topic table if it persists.

The gate's real cost is not waste, it is measurement: it guarantees the
published corpus contains only what the scorer already reads, which is why
`generated_demo_direction` cannot settle whether a scoring change helped.
Deferred deliberately, 2026-08-08.

Background on how the scorer got here, what was tried and rejected:
`docs/post-scoring-investigation.md`.

## Spectrum

A user's political placement lives in **`src/lib/spectrum.ts`** and is consumed
by three call sites: `/users/me/spectrum`, `/users/me/spectrum/history`, and the
feed's recommendation profile. It was previously duplicated across all three and
drifted. Do not reimplement it.

Decay is `0.5^(ageDays / 365)` and is deliberately **floorless**. Pure
exponential decay is time-invariant — advancing time scales numerator and
denominator alike — so a user who does nothing has a placement that never moves.
A floor breaks that and makes the number drift with no user action. There is a
test asserting this; do not "fix" it by adding a minimum weight.

## Content volume is a launch artifact, not a product property

Production today is a review environment. **31 of 36 accounts are scheduled
demo personas**, and they author almost everything:

| all time | persona | real |
|---|---|---|
| Posts | 172 | 5 |
| Comments | 2,042 | 1 |
| Votes | 3,053 | 1 |

Against that, ingest adds ~900–1,250 articles/day — **11,972 articles vs 96
posts over the last 14 days, roughly 1:125.**

That ratio is produced by a cron job. `forum-demo-activity` runs every 10
minutes and paces each persona to two posts per three-day rotation
(`demoPersonaPostsOnDay`, `src/demo/activity.ts`), which caps the community at
~20–21 posts/day no matter what. Articles are uncapped. **The gap measures the
demo schedule, not user behaviour.**

### Build for the opposite ratio

The product vision is a large userbase where posts **equal or exceed** articles
in both volume and engagement. Design for that, not for today's numbers:

- **Don't tune ranking to compensate.** No content-type quotas, no post boosts,
  no "articles are drowning posts" fixes. Posts lose today because there are 96
  of them; that self-corrects. Structural asymmetries are worth fixing (and
  have been — see `## Recommendation feed`); volume is not an asymmetry.
- **Don't reject a feature because community volume is low today.** "There
  wouldn't be enough posts to fill it" is a statement about August 2026, not
  about the product. Judge community features on whether they work at parity.
- **Do assume posts scale like articles.** Any query, index, pagination
  strategy, or feed assembly path that is comfortable at 96 posts/14d must hold
  at five figures. Article-side code already handles that volume — match it
  rather than writing a simpler post-side version.
- **Do keep the UI honest at both ends.** Layouts and empty states have to read
  well in a post-sparse feed *and* a post-dominant one.

### Never evaluate against demo data

**Filter on the `demo_personas` join, not `is_demo_generated`.** The flag only
marks rows the activity cron wrote — 84 of 172 posts and 1,779 of 2,042
comments. The seeded showcase corpus is persona-authored but unflagged, so the
flag silently leaves half the synthetic posts in:

```sql
LEFT JOIN demo_personas dp ON dp.user_id = x.user_id   -- dp.user_id IS NULL = real
```

Any measurement of ranking quality, engagement, retention, or feed composition
**must exclude them**, or it is measuring the generator. With real engagement at
one comment and one vote total, an unfiltered metric is ~99.9% synthetic.

This applies to reasoning as much as to SQL: "posts get few upvotes" is not
evidence about posts.

## Recommendation feed

`src/recommendation/` — `service.ts` loads candidates and the profile,
`rank.ts` scores and diversifies.

Posts and articles compete in one pool with no content-type quota. Posts
currently lose mostly on volume, which is a launch artifact that self-corrects
— see the section above. **Freshness, novelty, the diversify pass, the weight
tables, and the candidate pool sizes were left alone on purpose.** Don't "fix"
them without new evidence.

Structural asymmetries that were real have been fixed: each kind is scored
against the weight mass it can actually reach (posts can never earn `source`),
unknown lean scores 0.5 rather than being penalised, and `openRate` counts only
`open` because posts cannot emit `outbound_open`.

## Notifications

Nine notifications across four kinds (`replies`, `upvotes`, `dms`, `follows`),
all funnelled through `notify()` → `deliver()` in `src/lib/push.ts`. Push and
email are two outputs of that one path, gated independently by
`notification_prefs`; upvotes are the exception, accumulating into
`notification_email_digests` rather than emailing per event.

**`daily_brief` is a fifth kind and does not go through `deliver()`.** It calls
`sendPushToUser` and `sendEmail` directly from `src/lib/daily-brief-delivery.ts`
because it needs its own gating columns and per-edition dedupe. That means it
inherits none of `deliver()`'s gating, and none of the coverage in
`notification-delivery.test.ts` — both have to be maintained separately.
`sendPushToUser` is an un-gated primitive: it applies no preference checks and
**never throws**, returning the number of messages Expo accepted. A caller that
treats a non-throwing call as delivered will mark notifications sent that
nobody received.

**Every destination path comes from `src/lib/notification-routes.ts`.** Don't
inline `` `/post/${id}` `` at a call site again — the client repo's
`npm run check:deep-links` parses that file to confirm each path still names a
real screen, and a path it can't see is a path nobody is checking.

`data.url` is not decoration. The client navigates only when it is present and
starts with `/`; a payload without it produces a notification that opens the app
and does nothing else.

To exercise any of them without waiting for a real reply or follow:

```
npm run notify:test -- --list
npm run notify:test -- --user <userId> --case new-dm
```

It calls `deliver()` directly, so prefs still gate it and what arrives is what
production would send. Remote push needs a physical device — it does not work in
the simulator or Expo Go.

`src/lib/notification-delivery.test.ts` covers the payload and the full gating
matrix with a stubbed `fetch`; it does not and cannot prove APNs delivery.

## Database access

Read-only investigation against production is fine and often the fastest way to
answer a question — `npm run audit:posts`, or a short script using `src/db`.
Anything that writes needs a migration and explicit sign-off.
