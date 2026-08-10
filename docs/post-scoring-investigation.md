# The post scorer

How `scorePost` decides where a user post sits on the political spectrum.
Current as of 2026-08-09, scorer version **`claims-4.0.0`**.

Self-contained — no prior session context needed. If you are about to change
anything in `src/scoring/`, read this first, and read "Working on this safely"
at the end before you write a single pattern.

---

## 1. What it does

A post gets a `position` in `[0, 1]` where 0 is left, 1 is right, plus a
`confidence`, plus `position_signals` — a receipt explaining every decision.

`position = null` means **unclassified, not centrist.** This distinction is
load-bearing. Placing a genuinely neutral post at 0.5 is worse than leaving it
blank, and there is a metric guarding it (`neutral_false_placement_rate`, which
must stay 0).

Bands, from `audit-posts.ts`: `< 0.45` left, `> 0.55` right, else center.

Everything is deterministic and offline. No model runs at score time. Same text
plus same committed tables always yields the same score, and any row can be
re-scored and explained after the fact. That property is deliberate — do not
break it.

---

## 2. Why it looks like this

The previous scorer, `stance-3.0.0`, welded direction into the matcher: each of
~70 regexes hard-coded `side: 'left'` or `side: 'right'` at the point of match.
Probing it with fifteen plain policy sentences, **three scored correctly**.

Four symptoms, one cause:

| symptom | why |
|---|---|
| `I oppose cutting Medicaid` → nothing | a rule that already knows its side has nowhere to put "the author disagrees", so the guard **deleted** the match. Every rule only worked when the author agreed. |
| `The Affordable Care Act should be repealed` → **0.45, left of centre** | framing vocabulary could set direction alone. That lexicon identifies which *outlet* wrote a story, so it inverts when someone argues against a thing they named neutrally. |
| `Deport illegal aliens…` → 0.55, reported centre | `FULL_STRENGTH_HITS = 6` is tuned for 800-word articles. A 40-word post cannot reach six framing hits, so one hit moved ±0.05 — exactly the band boundary. |
| `Student debt should be cancelled` → nothing | every rule was bespoke to one argument, and roughly a dozen were transcriptions of single posts. |

That last point also explains why `evaluation-corpus.ts` reported 100%: the
rules were written *from* those sentences. See §8.

---

## 3. Architecture

Three stages with an explicit intermediate representation. **Political judgment
lives in exactly one of them.**

| stage | question | output | holds politics? |
|---|---|---|---|
| **A. Claims** | what does the author want? | `(topic, more/less, for/against)` | no |
| **B. Direction** | which side is that, today? | `left` / `right` / `contested` / unmapped | **yes — only here** |
| **C. Calibration** | where on the scale, how sure? | position, confidence, null reason | no |

```
text ──► claims.ts ──► direction.ts      ──► score.ts ──► position | null
         (+stances)    story-context.ts               (+ null reason receipt)
```

| file | role |
|---|---|
| `src/scoring/matching.ts` | shared primitives: term compilation, clause splitting, quote stripping, attribution, polarity |
| `src/scoring/claims.ts` | **stage A.** Turns text into claims. No politics. |
| `src/scoring/stances.ts` | the phrase library feeding stage A. Named positions matched by wording. No politics — carries `topic` + `direction`, never a side. |
| `src/scoring/direction.ts` | **stage B1.** The topic → coalition table. The only political judgment in the scorer. |
| `src/scoring/story-context.ts` | **stage B2.** Per-story coalition map for claims about named people, derived from article headlines. |
| `src/scoring/score.ts` | **stage C.** Orchestration and arithmetic. Also holds `scoreArticle`, which is a different algorithm — do not conflate them. |

---

## 4. Stage A — claim extraction (`claims.ts`)

```ts
type Claim = {
  kind: 'policy' | 'actor'
  topic: string                    // resolved in stage B
  target?: string                  // named entity, actor claims only
  direction: 'more' | 'less'       // what the sentence proposes
  polarity: 'for' | 'against'      // whether the author wants that
  weight: number
  confidence: number
  method: 'stance' | 'template' | 'phrase' | 'actor'
}
```

`netDirection(claim)` applies polarity: being *against* `more X` is wanting
`less X`. **Polarity is a field, not a reason to discard** — that single change
roughly doubles the reach of every pattern, because each one now reads both
agreement and disagreement.

Four extractors, deduped by `kind:topic` with priority
`stance > phrase > template > actor`:

- **stance** — the `stances.ts` phrase library. Specific arguments matched by
  wording. Highest priority: where a phrase and the generic template disagree,
  the phrase is the better reading.
- **phrase** — verb-plus-object pairs where the template would invert. "Ban
  assault weapons" is *more* gun-regulation even though "ban" contracts, because
  the object is what gets restricted.
- **template** — the generic engine: a direction verb crossed with topic
  vocabulary. One rule reads hundreds of phrasings.
- **actor** — claims about a named person or proceeding (confirmation, ethics
  probe, investigation, impeachment, resignation).

### Two rules that prevent whole classes of bug

**Topic vocabulary must name the quantity, not the object.** `medicaid` is a
quantity — "cut Medicaid" is unambiguously less healthcare-provision. `assault
weapon` is an object — "ban assault weapons" is *more* gun-regulation, so a
template would read it backwards. Object nouns belong in `PHRASES`, which state
direction outright. Getting this wrong is the single easiest way to invert a
score. (`qualified immunity`, `emissions` and `student debt` are all in `PHRASES`
for exactly this reason.)

**Advocacy is required.** A claim needs a modal, an explicit support/oppose cue,
or an imperative opening. Without this gate, "violent crime is down in most
cities" becomes a position. Epithets are the deliberate exception — see below.

### Framing vocabulary splits in two

The lexicons in `lexicons.ts` conflate two different things, and treating them
alike is what produced the ACA inversion:

- **Naming terms** — "estate tax", "Affordable Care Act". Both coalitions use
  them. Using one says nothing about your position, because you may be about to
  argue against the thing you named. These can *intensify* a placement, never
  create one.
- **Epithets** — "woke", "cancel culture", "big oil", "climate crisis".
  Pejorative characterisations of the other side. Nobody applies them to their
  own coalition, so reaching for one **is** the alignment even with no policy
  proposed. These do place a post, at lower weight (1.2), modelled as
  coalition-approval claims so they resolve through the same path.

The test is whether the term is *disparaging*. Approving self-descriptions
("gun rights", "reproductive rights") are coalition-marked too, but they double
as neutral policy nouns and carry the same inversion risk as naming terms.

---

## 5. Stage B — direction

### B1: the topic table (`direction.ts`)

**This file is the only place in the scorer holding a political judgment.**
~35 rows, each with `moreMeans`, an `asOf` date and a `note`.

**Topics are named as the quantity being increased.** That dissolves the
rights-inversion problem without per-domain exceptions: `gun-regulation`
moreMeans left, `gun-rights` moreMeans right, and "ban assault weapons" is
simply *more* gun-regulation. Both read naturally.

`resolveTopic(topic, netDirection)` returns a side, or a reason it cannot:

- **`contested`** is a first-class answer, not a gap. Trade and tariffs,
  platform speech, antitrust, AI regulation, housing supply. These mappings have
  genuinely moved within living memory — protectionism was labour-left for a
  century and is Trump-coded now — so refusing beats encoding a snapshot.
- **`unmapped-topic`** means a real ask on a topic absent from the table.

A **contested claim suppresses placement when it dominates the post**
(`contestedWeight >= resolvedWeight`). Without this, "Tariffs on Chinese steel
protect American workers" resolves left off a secondary labour rule — reading a
coalition off wording while ignoring the position actually argued, which is the
original defect in miniature. Ties suppress; a wrong placement costs more than a
blank.

### B2: story context (`story-context.ts`)

A person needs no permanent political identity — only one for the story being
discussed, which lasts exactly as long as posts about it do. And the press
states it continuously:

```
Republicans clear Todd Blanche for top US Justice Department role
Trump posts video targeting Murkowski over vote against Blanche confirmation
```

Per hot cluster, scan member titles for `(coalition actor)(stance verb)(action)`
and emit `action → the side pushing for it`. Requires a **≥2 net margin and 2:1
ratio** rather than unanimity, because defections are exactly what gets written
up — "Second GOP Senator Comes Out Against Blanche Confirmation" is a headline
*because* it is atypical, and demanding zero contradiction would suppress every
real story.

Posts match a cluster by keyword overlap, reusing `cluster.ts`'s existing logic.

**Replayability.** Cluster state changes hourly. The resolved map is written into
`position_signals` at score time, and `rescore:posts` **replays** it rather than
re-deriving — otherwise re-scoring would silently re-judge an old post against
today's news. It derives fresh only where nothing was recorded. The story layer
is time-stamped evidence, not a timeless rule.

It works where headlines name a coalition and fails where they do not: Blanche
resolves, Fauci does not.

---

## 6. Stage C — calibration (`score.ts`)

Posts have their own constants. The article path is unchanged and shares nothing
but `extractFeatures`.

| constant | value | why |
|---|---|---|
| `FULL_STRENGTH_CLAIMS` | 2 | not the article path's 6, which a 40-word post cannot reach |
| `MAX_CLAIM_SHIFT` | 0.28 | resolved claims move the position this far at most |
| `MAX_FRAMING_BOOST` | 0.06 | framing intensifies only, and only once a claim exists |
| `FRAMING_FULL_STRENGTH_POST` | 2 | post-length framing scale |
| total shift cap | ±0.36 | |

Every unplaced post records **why**, which is the diagnostic the old scorer
lacked entirely — "recognised nothing" and "recognised it but has no mapping"
used to be indistinguishable:

| reason | meaning | correct? |
|---|---|---|
| `no-claim` | no position stated — observation, question, refusal | permanent |
| `contested` | mapping has genuinely moved | deliberate |
| `unmapped-topic` | real ask, topic absent from the table | coverage gap |
| `unmapped-actor` | claim about a person the headlines don't disambiguate | coverage gap |

`npm run audit:posts` reports the breakdown.

---

## 7. Where the boundary falls

A position is returned when the post **states what should happen**. Everything
else stays blank.

The first three reasons below must **never** acquire a placement. The last two
are the ones worth shrinking.

| reason | example |
|---|---|
| no ask | *"Fed held rates again. Sticky services inflation is the whole story."* |
| explicit refusal | *"You can be for or against any policy, but a system this slow serves nobody."* |
| question | *"Tariffs on China… curious what people here think."* |
| contested | *"Tariffs are taxes on your own consumers."* |
| unmapped topic | *"The stablecoin bill quietly moving through committee…"* |
| unresolved actor | *"Nexstar hosting the SC Senate debate… it's really gatekeeping."* |

### Production state, 2026-08-09

178 posts, all `claims-4.0.0`. Of ~169 visible: **56 left, 39 right, 3 center,
71 unclassified** — and of those blanks, **59 `no-claim`, 10 `unmapped-actor`,
2 `contested`**.

---

## 8. Known defects

Found by reading real placements on device, not by any test suite — which is
§9's point.

### D1 — opposition as contrastive negation reads as support

**The serious one.** Two production posts scored **0.78 (right)** while arguing
the opposite:

```
Restricting birthright citizenship won't "fix" public health—it's an
administrative shock that destabilizes families…

Restricting birthright citizenship isn't a policy tweak—it's an attempt to
redraw constitutional rights…
```

Receipts on both: `polarity: "for"` on two claims, both resolving right.

**Polarity is blind to subject-position criticism.** `polarityOf` checks for an
against-cue *before* the match and a disparaging copular predicate *after* it.
Here the topic phrase is the sentence subject at index 0 — nothing precedes it —
and the disagreement arrives as `X won't Y` or `X isn't A—it's B`. The redesign
fixed "I oppose cutting Medicaid"; it did not fix the far more common form where
the criticised thing is the grammatical subject.

**One span counted twice.** "Restricting birthright citizenship" matches a
PHRASE rule (`immigration-enforcement · more`) *and* a TEMPLATE rule
(`birthright citizenship` is also an `immigration-openness` term, "Restricting"
contracts → `less`). Both resolve right. Dedupe keys on `kind:topic`, so two
different topics from identical text both survive and their weights add — 0.65
becomes 0.78.

**Worse than a blank.** The governing principle is that unclassified beats
mislabelling neutral text as centrist. Placing a post confidently on the side it
argues against is worse than either, and `neutral_false_placement_rate` does not
detect it — that metric only counts neutral text acquiring a placement.

Two changes worth making *together*, once §9 exists:
- treat a topic term in subject position followed by a negated positive-outcome
  verb, or a contrastive `not A but B`, as `against`
- suppress a template claim whose span overlaps a phrase claim, rather than
  letting both contribute weight

### D2 — right-leaning generated posts rejected more often

Of 6 demo-gate rejections on 2026-08-09, **5 were right-leaning**. Overall
rejection rate did not worsen (30.0% vs `stance-3.0.0`'s 32.3%), so this is
about *which* side fails.

Sample far too small to act on. If it persists it suggests thinner right-side
coverage in `direction.ts` — plausible, since topics were named as quantities
that read as left-side asks, with right positions expressed as `less` of them.
Re-measure at a few hundred jobs before touching the table.

### D3 — no way to validate a fix

See §9. D1 is the first defect that cannot responsibly be fixed without it.

---

## 9. The validation problem — read before changing anything

**Neither existing metric can tell you whether a scoring change helped.**

- `evaluation-corpus.ts` reports near-100% because the rules were written from
  those exact sentences. **It will bless a regression.** Do not tune against it;
  that is how `stance-3.0.0` overfitted.
- `generated_demo_direction` is less circular but contaminated in a way that is
  easy to miss: the demo write-gate (`demo/activity.ts`) **discards any post the
  current scorer cannot place**, so the published corpus is selected to suit
  whatever scorer produced it. Measured on it, `claims-4.0.0` scores 0.656
  against `stance-3.0.0`'s 0.688 — a difference that settles nothing.

What `claims-4.0.0` *can* claim: the fifteen-sentence probe went 3/15 → 15/15,
corpus directional is 41/44 (the 3 "misses" are `contested` topics where the
corpus and the design deliberately disagree), centre 3/3, and
`neutral_false_placement_rate` held at 0/11.

What it cannot claim: that overall accuracy improved.

**A hand-labelled holdout set is the prerequisite for further tuning.** Roughly
80–150 posts, labelled by hand including `unclassified` for genuinely neutral
ones, kept separate from the rules. Deferred deliberately 2026-08-08; it is now
blocking D1.

---

## 10. Working on this safely

1. **Any change to a lexicon, rule, weight or threshold is a scale change.**
   Bump `POST_SCORER_VERSION` in `score.ts` and run `npm run rescore:posts`, or
   stored values stop being comparable.
2. **Put political judgments in `direction.ts` and nowhere else.** If you find
   yourself typing `'left'` or `'right'` in `claims.ts` or `stances.ts`, stop.
3. **Name topics as the quantity being increased.** Check whether your term is a
   quantity or an object; objects belong in `PHRASES`.
4. **Terms must inflect.** Use the trailing `~` convention — `\btariff\b` does
   not match "Tariffs", and a space matches a hyphen so "school choice" also
   reads "school-choice".
5. **Do not chase individual posts with new regexes.** That is precisely what
   produced the scorer this one replaced.
6. `neutral_false_placement_rate` must stay **0**.
7. Verify with `npm run audit:posts` (read-only) before `--apply`.
8. Callers of `scorePost`: `routes/posts.ts` (passes story context),
   `rescore-posts.ts` (replays it), `audit-posts.ts` (loads it),
   `demo/activity.ts` (**does not** — see D2).

---

## 11. History, condensed

`stance-3.0.0` was a framing lexicon plus four pattern layers, each hard-coding
a side. A 2026-08-07 investigation found 40% of posts unclassified and
identified three limitations. Two shaped the redesign:

- **No entity valence.** "I support Blanche's confirmation" is right-leaning
  *because Trump nominated him*, a fact the model could not represent. Answered
  by `story-context.ts` — derive it per story from headlines rather than
  maintaining a table of people.
- **The policy→side mapping is itself time-varying.** Tariffs disprove any fixed
  table: market-interfering protectionism was labour-left for a century and is
  Trump-coded now. Answered by making `contested` a real value.

The prototype layer (`semantic-stances.ts`, v3.0.0's headline feature) required
≥58% stemmed-token overlap with a stored example — near-verbatim matching in
semantic clothing. It classified 5 posts out of 144 and was deleted in
`claims-4.0.0`.

Product-owner critiques that shaped the analysis and should not be
re-litigated: tariffs are not obviously right-leaning; batch entity refresh
misses day-to-day news; capitalisation-based entity extraction misses lowercase
policy nouns; low post volume today is a launch artifact and not a reason to
tune ranking.
