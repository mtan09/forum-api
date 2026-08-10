# Post scoring: current state, limitations, and options

Written 2026-08-07 after an investigation into why most posts render without a
spectrum. Self-contained: no prior session context needed.

**Status: superseded 2026-08-08.** The scorer this document analyses,
`stance-3.0.0`, was replaced by `claims-4.0.0` — a three-stage pipeline
(claim extraction → coalition mapping → calibration) described in
`../CLAUDE.md`. All 178 posts were re-scored.

Everything below still describes `stance-3.0.0` and is kept because the
*analysis* remains the reason the redesign took the shape it did — particularly
Limitation 3, which became the `contested` mapping value. **Read the sections
below as history, not as current behaviour.**

What is current: the "Defects in `claims-4.0.0`" section at the end of this
document.

---

## How `scorePost` works today

`src/scoring/score.ts:199`. Deterministic, offline, no model. Scale: 0 = left,
1 = right, 0.5 = center. Version `stance-3.0.0`.

1. **Feature extraction** (`features.ts:92`) strips quoted spans — a quoted
   opponent's vocabulary is not the author's framing choice — then counts hits
   against `LEFT_FRAMING` (43 entries) and `RIGHT_FRAMING` (54), capped at 3 per
   term so one repeated phrase cannot dominate.

2. **Framing signal** (`score.ts:113`):
   ```
   net      = (rightCount − leftCount) / (rightCount + leftCount)   ∈ [−1, 1]
   strength = min((rightCount + leftCount) / 6, 1)
   ```

3. **Stance detection** (`stances.ts:589`), four layers in order:

   | layer | matching | confidence | count |
   |---|---|---|---|
   | `RULES` | one regex over the whole text | 0.96 | 47 |
   | `COMPOSITIONAL_RULES` | subject **and** predicate in one clause | 0.88 | ~15 |
   | `CONTEXT_RULES` | rhetorical patterns | 0.74 | ~8 |
   | `detectSemanticStances` | ≥58% prototype token overlap | ≤0.88 | 24 groups |

   All four run; `uniqueHits` dedupes. `rejectedOrAttributed` guards against
   negation and attribution ("Republicans claim that…").

4. **Aggregate:**
   ```
   stanceNet      = (Σ right weights − Σ left weights) / Σ all weights
   stanceStrength = min(Σ all weights / 4, 1)

   shift    = clamp(±0.45,  net × strength × 0.30              ← framing
                          + stanceNet × stanceStrength × 0.35) ← stances
   evidence = leftCount + rightCount + Σ stance weights
   position = evidence > 0 ? clamp01(0.5 + shift) : null
   ```

5. **There is no fallback.** `evidence === 0` → `null`. Not centrist —
   unclassified. This is deliberate (scorer v2.0.0 changelog: "text with no
   directional evidence is left unclassified" rather than mislabeled as centrist)
   and should be preserved.

Bands, from `audit-posts.ts:22`: `< 0.45` left, `> 0.55` right, else center.

### Worked example

`"We should cut regulation and let the free market decide."` → **0.675**

```
framing hits    none                            → net 0, strength 0
stance hits     1 × fiscal-policy/right, weight 2, method pattern, conf 0.96
stanceNet       (2 − 0) / 2                     = 1.0
stanceStrength  min(2 / 4, 1)                   = 0.5
shift           0 + 1.0 × 0.5 × 0.35            = 0.175
position        0.5 + 0.175                     = 0.675   → band "right"
```

One rule fired; that is the entire basis for the score. `position_signals`
records it verbatim, including a `stance-meta` JSON blob with method, confidence,
and an evidence snippet.

### Articles score differently

`scoreArticle` (`score.ts:143`) starts from the outlet's published lean
(`sourcePrior`, from `ingest/sources.ts`) and lets text shift it by at most
`MAX_TEXT_SHIFT` = ±0.25. Consequence worth knowing: **every one of 18,111 ready
articles has a non-null lean**, because `source_lean` always backfills. Posts have
no equivalent prior, so text carries all the weight — and when there is no text
evidence, there is no score.

---

## Measured baseline

From `npm run audit:posts` (read-only) plus direct queries, 2026-08-07:

| | |
|---|---|
| visible posts | 144 |
| classified | 87 (left 51, center 3, right 33) |
| **unclassified** | **57 (40%)** |
| avg `position_confidence` of classified | 0.38 (29 of 87 below 0.35) |

Method breakdown for the 87 classified:

| method | posts |
|---|---|
| pattern rules | 51 |
| compositional | 8 |
| framing lexicon only | 8 |
| **prototype (the v3.0.0 addition)** | **5** |

Unclassified posts average **42 words**, classified **35** — length is not the
problem. Rule coverage is.

---

## Limitation 1 — the prototype layer barely fires

`detectSemanticStances` (`semantic-stances.ts:314`) requires a clause to cover
**≥58% of a prototype example's stemmed tokens**, with ≥2 tokens overlapping.
That is near-verbatim matching wearing semantic clothing. It is why v3.0.0, which
was specifically intended to fix coverage, classified 5 posts out of 144.

```
"I support raising the minimum wage."                → null
  "minimum wage" is not in LEFT_FRAMING              → 0 framing hits
  no labor pattern rule matches this phrasing        → 0 stance hits
  nearest prototype: "require fair wages and apprenticeship slots"
    tokens [requir, fair, wage, apprenticeship, slot]
    overlap = {wage} = 1  <  minimum 2               → rejected
  evidence = 0                                       → position = null
```

A textbook left position, unscored.

Real production examples that fail the same way — all express a clear stance:

- *"Restricting 'birth tourism' via executive orders is a rights-risk move I
  oppose."* Subject matches `immigration`, `AUTHOR_STANCE_CUE` matches
  `I oppose`, but the best prototype (`expand legal immigration pathways`)
  overlaps 1 of 4 tokens = 0.25.
- *"Confirmation should track clear vetting milestones, not political
  calendars."* No rule covers executive nominations at all.
- *"I support the House Ethics Committee moving forward with Max Miller's
  probe."* No rule covers congressional ethics oversight.

---

## Limitation 2 — no entity valence

The scorer knows three named entities — `Republican`, `Democrat`, `Trump` — and
only inside "criticism of X" patterns in `CONTEXT_RULES` (`stances.ts:442`).

```
NULL  conf=0.11   I support Todd Blanche's confirmation as Attorney General.
NULL  conf=0.14   Blanche's nomination should be rejected by the Senate.
NULL  conf=0.14   The Senate was right to hold Fauci in contempt.
NULL  conf=0.11   Holding Fauci in contempt is a partisan stunt and should stop.
0.391 conf=0.23   Trump was reckless and his actions were unconstitutional.
```

Only the last scores, and only via `/Trump.{0,10}(reckless|unconstitutional)/`.

Supporting Blanche's nomination is right-leaning *because Trump nominated him*.
Holding Fauci in contempt is right-leaning *because of who Fauci is to that
coalition*. Neither fact is representable in the current model.

This is the largest identifiable failure category:

| | mentions nomination / confirmation / contempt / probe |
|---|---|
| unclassified posts | **17 of 57 (30%)** |
| classified posts | 7 of 87 (8%) |

Roughly 4× over-represented among failures; about 12% of all posts. For a
news-driven product this matters disproportionately, because news is mostly about
people.

---

## Limitation 3 — the policy→side mapping is itself time-varying

The most important finding, and the one that reframes everything else.

```
NULL  I support tariffs on Chinese imports to protect American manufacturing.
NULL  Tariffs are a tax on working families and should be repealed.
```

`tariff` appears exactly once in the entire scoring module — in
`POLITICAL_VOCAB`, which feeds *relevance*, not lean. So both stances are
unscored.

But the deeper problem is that there is no obviously correct answer to score them
*with*. Market-interfering protectionism was a labor-left position for a century;
in 2026 it is Trump-coded and reads right. The same instability applies to
foreign intervention, free speech, antitrust, and deficit hawkishness.

**So `(issue, action) → side` is coalition-dependent, not stable.** The framing
lexicons are explicitly grounded in Gentzkow & Shapiro (2010) — a measurement of
congressional speech from sixteen years ago.

Every layer of this scorer encodes a coalition snapshot, not a timeless truth.
An earlier framing in this investigation — that policy propositions are stable and
only entity valence drifts — was **wrong**, and tariffs disprove it. Any design
that assumes a fixed policy→side table inherits this problem.

---

## Three categories of political signal

| category | example | covered today |
|---|---|---|
| framing vocabulary | "death tax", "climate crisis" | yes — lexicons |
| policy proposition | "we should cut regulation" | partly — rules |
| **entity valence** | "I support Blanche's confirmation" | **no** |

---

## Options considered

None chosen. Listed with their known weaknesses.

### A. Issue × action layer

Replace near-verbatim prototype matching with `(issue, action, polarity) → side`:

```ts
type ActionRule = {
  issue: string
  action: string           // canonical key, e.g. 'restrict-entry'
  patterns: RegExp[]       // ways of naming the action
  supportSide: StanceSide  // side implied by SUPPORTING it
}
// side = polarity === 'support' ? supportSide : opposite(supportSide)
```

`"Restricting birth tourism … I oppose"` → action `restrict-entry`, polarity
`oppose`, supportSide `right` → **left**.

Would slot in as a fifth layer in `detectStances`, after `COMPOSITIONAL_RULES`
and before `CONTEXT_RULES`. Suggested confidence 0.82, weight 1.8.

Reuses, rather than reimplements: `stripQuotes`, the clause splitter,
`rejectedOrAttributed`, `snippet`, `uniqueHits` (all `stances.ts`), and
`OPPOSITION_CUE` / `AUTHOR_STANCE_CUE` (`semantic-stances.ts:279-281`, would need
exporting).

**Weakness:** addresses neither Limitation 2 nor Limitation 3. It assumes a fixed
policy→side table, which is exactly what tariffs show to be unstable.

### B. Entity valence table, LLM-seeded

Offline batch proposes entries from the article corpus; a human reviews; the
committed table is what scoring reads. Runtime stays deterministic and `rescore`
replays exactly, because the model never runs at score time.

```
OFFLINE (monthly-ish, produces a reviewable diff)
  1. extract  frequent capitalised entities from ingested articles
  2. ground   attach the headlines each entity actually appears in
  3. propose  LLM returns role + valence + one-line reason + confidence
  4. REVIEW   human accepts / edits / rejects        ← editorial control
  5. commit   entities.ts, bump POST_SCORER_VERSION, rescore

AT SCORE TIME
  6. regex lookup against the committed table. No network.
```

Store the **role**, not a personal political score:

```ts
{ match: /\btodd blanche\b/i,
  role: 'trump-administration-nominee',
  because: 'Nominated by Trump for Attorney General',
  asOf: '2026-01' }
```

`'trump-administration-nominee' → supporting = right` lives in a separate tiny
mapping. "Blanche is a Trump nominee" is checkable; "Blanche is right-wing" is a
characterisation. The role framing is easier to defend, correct, and diff.

Valence alone means nothing — it needs polarity. Mentioning an entity carries no
signal; the stance toward them does, reusing the same support/oppose detection
option A needs.

**Weaknesses:** first review pass is real work (a few hundred entities); the LLM
is confidently wrong on minor figures; `none` must be used liberally for judges,
foreign officials, and cross-pressured figures; batch cadence lags breaking news.

### C. Entity valence table, hand-curated

Identical runtime and file format, no model dependency, all research manual.

### D. Ingest-driven relation extraction

Pattern-extract `"X nominated Y"` from articles as they arrive. **Zero lag and no
model** — when Trump nominates someone, that sentence is in the corpus the same
day. Covers only relation-shaped facts: catches Blanche, misses Fauci.
Complements B rather than replacing it — B is for the slower, broader question
where a month of lag is fine.

### E. Stable vs volatile split

Separate coalition-stable rules (abortion, guns, unions) from contested or
drifting ones (trade, foreign policy, tech, speech). The volatile file carries a
date, gets a review cadence, and can declare `contested → no score` so the
tariff case is answered honestly rather than guessed.

This is the only option that addresses Limitation 3.

---

## Critiques from the product owner — carry these forward

These reshaped the analysis and should not be re-litigated from scratch.

1. **"I wouldn't think of tariffs as right-leaning, since they interfere with
   markets."** The most consequential critique; produced Limitation 3 and
   invalidated the assumption behind option A.

2. **"Won't batch entity refresh miss a lot? A lot of content is day to day."**
   Correct. Mitigation is option D for time-critical relations; an LLM batch is
   only appropriate for slower questions.

3. **"It's not just capitalised things that are the issue."** Correct — entity
   extraction by capitalisation would miss lowercase policy nouns entirely, and
   the tariff case shows the gap is not confined to named entities.

4. **On feed freshness and novelty:** *"not a problem if current posts are scored
   lower since I've seen most of them; when the app is published people should be
   posting frequently, similar to the rate of articles."* Correct — those are
   low-volume artifacts, and the feed work deliberately left them alone.

5. **"Won't author affinity be unbalanced?"** (58 article sources vs potentially
   thousands of post authors.) Correct; the proposal was dropped. See the feed
   section of the implemented work.

---

## Verification guidance

- `npm run audit:posts` is the read-only before/after harness. Baseline:
  **57 unclassified of 144**.
- `neutral_false_placement_rate` must stay **0**. Placing "Wow" or a genuinely
  balanced post is worse than leaving it null.
- **The 58-case corpus in `evaluation-corpus.ts` reports 100% directional
  accuracy and cannot validate new rules.** It was written alongside the rules it
  tests, so it will bless a change that makes things worse. Add the 57 real
  unclassified posts with hand-assigned labels — including `unclassified` for the
  genuinely neutral ones — before trusting any delta.
- `generated_demo_direction.rate` (currently **0.68**) is the one metric here that
  is not self-referential: it compares placements against the authoring persona's
  known lean.
- Any lexicon, rule, or threshold change requires bumping `POST_SCORER_VERSION`
  (`score.ts:31`) and running `npm run rescore:posts`.
- `scorePost` callers, none of which need changing for a rules-only change:
  `routes/posts.ts:179` (post creation), `rescore-posts.ts`, `rescore.ts`,
  `audit-posts.ts`, `demo/activity.ts:475`.

---

# Defects in `claims-4.0.0`

Current as of 2026-08-09. Found by reading real placements on device during
build 9 testing, not by a test suite — which is itself the point of D3.

## D1 — Opposition expressed as contrastive negation reads as support

**The most serious one.** Two production posts scored **0.78 (right)** while
arguing the opposite:

```
Restricting birthright citizenship won't "fix" public health—it's an
administrative shock that destabilizes families who are already uninsured…

Restricting birthright citizenship isn't a policy tweak—it's an attempt to
redraw constitutional rights through litigation strategy…
```

Receipts on both:

```
claim: immigration-enforcement · more    polarity "for"   → right
claim: immigration-openness   · less     polarity "for"   → right
```

Two failures compounding.

**Polarity is blind to subject-position criticism.** `polarityOf` looks for an
against-cue *before* the match and a disparaging copular predicate *after* it.
Here the topic phrase is the sentence subject at index 0 — nothing precedes it —
and the disagreement arrives as contrastive negation: `X won't Y`, `X isn't
A—it's B`. Neither shape is recognised. The redesign fixed "I oppose cutting
Medicaid"; it did not fix the much more common form where the thing being
criticised is the grammatical subject.

**One span is counted as two claims.** "Restricting birthright citizenship"
matches a PHRASE rule (`immigration-enforcement`, direction `more`) *and* a
TEMPLATE rule — `birthright citizenship` is also an `immigration-openness` term,
with "Restricting" as the contracting verb, giving `less`. Both resolve right.
The dedupe in `detectClaims` keys on `kind:topic`, so two *different* topics
derived from identical text both survive and their weights add. That is what
lifts the score from roughly 0.65 to 0.78.

**Why this is worse than an unplaced post.** The scorer's governing principle is
that leaving text unclassified beats mislabelling a neutral post as centrist.
Placing a post confidently on the side it argues against is worse than either,
and `neutral_false_placement_rate` does not measure it — that metric only counts
neutral text acquiring a placement.

**Deliberately not fixed.** The obvious patch is more patterns: add `won't`, add
`isn't…it's`. That is exactly the accretion that overfitted `stance-3.0.0`, and
there is currently no instrument that could tell whether it helped — see D3. Two
changes worth considering together when there is one:

- treat a topic term in subject position, followed in the same clause by a
  negated positive-outcome verb or a contrastive `not A but B`, as `against`
- suppress the template claim when a phrase claim already covers an overlapping
  span, rather than letting both contribute weight

## D2 — Right-leaning generated posts are rejected more often

Of the 6 demo post jobs the write-time gate rejected on 2026-08-09, **5 were
right-leaning**. The overall rejection rate did not worsen versus
`stance-3.0.0` (30.0% against 32.3%), so this is about *which* side fails, not
how often.

Sample is far too small to act on. If it persists it points at thinner coverage
for right-side topics in `direction.ts` — plausible, since the topic table was
written by naming quantities that read naturally as left-side asks
(`healthcare-provision`, `labor-power`) with right-side positions expressed as
`less` of them.

Worth re-measuring at a few hundred jobs before touching the table.

## D3 — There is still no way to validate a fix

Unchanged from the original investigation, and now blocking concrete work.

- `evaluation-corpus.ts` reports near-100% because the rules were written from
  those sentences. It will bless a regression.
- `generated_demo_direction` is contaminated in a way that is easy to miss: the
  demo write-gate discards any post the *current* scorer cannot place, so the
  published corpus is selected to suit whatever scorer produced it. Measured on
  it, `claims-4.0.0` scores 0.656 against `stance-3.0.0`'s 0.688 — a difference
  that settles nothing in either direction.

D1 is the first defect that cannot responsibly be fixed without a hand-labelled
holdout set. Build it before the next scoring change, not after.
