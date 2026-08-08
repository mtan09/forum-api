# forum-api

Hono + Postgres + JWT, deployed on Railway. Serves the iOS and web clients in
the sibling repo at `../forum`.

## Commits

**Never list Claude as a contributor.** No `Co-Authored-By` trailer, no
"Generated with" footer. Commits are authored solely by the repo owner.

## Deploying — read this before running `railway up`

The Railway project contains **three services built from this one repo**:

| service | role |
|---|---|
| `forum-api` | the HTTP API — `api.forumeveryside.com` |
| `forum-ingest` | cron, hourly — article ingest |
| `forum-demo-activity` | cron, every 10 min — demo persona activity |

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

**`src/scoring/evaluation-corpus.ts` cannot validate new scoring rules.** It
reports 100% directional accuracy because it was written alongside the rules it
tests. `generated_demo_direction.rate` is the one non-self-referential metric —
it compares placements against the authoring persona's known lean.

Current state and open design questions: `docs/post-scoring-investigation.md`.
Post coverage is 40% unclassified; the fix is a larger design question, and that
document records what was tried, what was rejected, and why.

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

## Recommendation feed

`src/recommendation/` — `service.ts` loads candidates and the profile,
`rank.ts` scores and diversifies.

Posts and articles compete in one pool with no content-type quota. Posts
currently lose mostly because there are ~144 of them against ~12k articles from
the last 14 days, which is a volume artifact that self-corrects — **freshness,
novelty, the diversify pass, the weight tables, and the candidate pool sizes
were left alone on purpose.** Don't "fix" them without new evidence.

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
