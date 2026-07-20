// ============================================================
// Scoring lexicons — the entire bias scale lives in this file.
//
// Design: scores must be reproducible and auditable, so every input
// to the scorer is a committed, diffable word list — not model weights
// or API output. Editing any list is a scale change: bump
// SCORER_VERSION in score.ts and run `npm run rescore`.
//
// Groundings:
// - Framing pairs follow Gentzkow & Shapiro (2010), "What Drives
//   Media Slant?" — partisan term choice ("death tax" vs "estate tax")
//   measured from congressional speech is a validated slant signal.
// - Loaded-language and attribution cues follow Recasens, Danescu-
//   Niculescu-Mizil & Jurafsky (2013), "Linguistic Models for
//   Analyzing and Detecting Biased Language" (framing bias +
//   epistemological bias).
// - Hedging cues follow Hyland (1998) on academic hedging; first-person
//   and deontic-modality cues are standard subjectivity features (Wiebe
//   et al., MPQA).
//
// Conventions: entries are matched case-insensitively on word
// boundaries; a trailing '~' allows a plural/inflection suffix
// (s, es, ed, ing). Multi-word phrases are allowed.
// ============================================================

// --- Partisan framing vocabulary -----------------------------
// Term choices that empirically skew to left-leaning outlets/speakers.
export const LEFT_FRAMING = [
  'undocumented immigrant~',
  'undocumented worker~',
  'gun safety',
  'gun violence prevention',
  'commonsense gun',
  'gun reform',
  'assault weapon~',
  'reproductive rights',
  'reproductive health',
  'reproductive freedom',
  'abortion care',
  'pro-choice',
  'climate crisis',
  'climate emergency',
  'climate justice',
  'estate tax',
  'affordable care act',
  'tax cuts for the wealthy',
  'tax breaks for the rich',
  'voting rights',
  'voter suppression',
  'gender-affirming care',
  'marriage equality',
  'racial justice',
  'systemic racism',
  'social justice',
  'income inequality',
  'wealth gap',
  'living wage',
  'corporate greed',
  'price gouging',
  'big oil',
  'big pharma',
  'fossil fuel industry',
  'far-right',
  'far right',
  'right-wing extremis~',
  'ultraconservative~',
  'white nationalis~',
  'insurrection',
  'book ban~',
  'union busting',
  'gun lobby',
]

// Term choices that empirically skew to right-leaning outlets/speakers.
export const RIGHT_FRAMING = [
  'illegal alien~',
  'illegal immigrant~',
  'illegals',
  'gun rights',
  'second amendment rights',
  'law-abiding gun owner~',
  'pro-life',
  'unborn child~',
  'unborn baby',
  'unborn babies',
  'abortion on demand',
  'partial-birth abortion',
  'climate alarmis~',
  'death tax',
  'obamacare',
  'tax relief',
  'job creator~',
  'voter fraud',
  'election integrity',
  'gender ideology',
  'transgender ideology',
  'traditional marriage',
  'family values',
  'woke',
  'wokeness',
  'critical race theory',
  'identity politics',
  'radical left',
  'far-left',
  'far left',
  'left-wing extremis~',
  'socialist agenda',
  'open borders',
  'border crisis',
  'border invasion',
  'migrant crime',
  'big government',
  'government overreach',
  'nanny state',
  'entitlement spending',
  'welfare state',
  'handout~',
  'cancel culture',
  'law and order',
  'tough on crime',
  'back the blue',
  'school choice',
  'parental rights',
  'energy independence',
  'war on coal',
  'liberal media',
  'mainstream media',
  'fake news',
  'deep state',
]

// --- Loaded / charged language (direction-neutral) ------------
// Signals intensity and subjectivity, not lean. High density means the
// text editorializes; it raises the subjectivity score and shows up in
// the stored signals, but never moves the lean number by itself.
export const LOADED_TERMS = [
  'slam~', 'blast~', 'rip~', 'torch~', 'eviscerat~', 'skewer~',
  'destroy~', 'demolish~', 'humiliat~', 'obliterat~',
  'disgraceful', 'disgrace', 'outrageous', 'outrage~', 'shocking',
  'radical~', 'extremist~', 'extreme',
  'disaster~', 'disastrous', 'catastrophic', 'catastrophe',
  'corrupt~', 'corruption', 'shameful', 'shameless',
  'absurd', 'ridiculous', 'ludicrous', 'unhinged', 'deranged',
  'dangerous', 'betrayal', 'betray~', 'scandal~', 'scandalous',
  'so-called', 'notorious', 'infamous', 'crony', 'cronies',
  'scheme~', 'sham', 'hoax', 'witch hunt', 'debacle', 'fiasco',
  'reckless', 'chilling', 'stunning', 'bombshell', 'firestorm',
  'appalling', 'horrific', 'vicious', 'toxic', 'assault on',
  'war on', 'attack on democracy', 'threat to democracy',
]

// --- Attribution verbs ----------------------------------------
// Neutral reporting verbs — a high share of these (plus quoting)
// indicates straight news copy.
export const NEUTRAL_ATTRIBUTION = [
  'said', 'says', 'stated', 'announced', 'reported', 'told',
  'according to', 'noted', 'added', 'confirmed', 'denied',
  'testified', 'wrote', 'described', 'asked', 'responded',
]

// Loaded attribution verbs — cast the speaker or their claim in a
// light (Recasens et al.'s "epistemological bias"). Counted toward
// subjectivity.
export const LOADED_ATTRIBUTION = [
  'slammed', 'blasted', 'ripped', 'mocked', 'gloated', 'whined',
  'complained', 'raged', 'fumed', 'admitted', 'conceded',
  'claimed', 'insisted', 'boasted', 'bragged', 'lashed out',
  'doubled down', 'refused to say', 'dodged', 'deflected',
]

// --- Hedging (mild subjectivity: analysis rather than opinion) --
export const HEDGES = [
  'may', 'might', 'could', 'perhaps', 'possibly', 'likely',
  'unlikely', 'appears', 'seems', 'suggests', 'arguably',
  'reportedly', 'allegedly', 'apparently', 'probably',
]

// --- Explicit opinion markers ----------------------------------
// Strong markers of first-person advocacy. Counted only outside
// quotations (quoted speakers are allowed opinions in straight news).
export const OPINION_MARKERS = [
  'i believe', 'i think', 'i argue', 'in my view', 'in my opinion',
  'we must', 'we should', 'we need to', 'we cannot allow',
  "it's time to", 'it is time to', 'make no mistake',
  'let me be clear', 'the truth is', 'frankly', 'to be blunt',
]

// --- Political relevance vocabulary -----------------------------
// Used only to gate ingestion (is this article politics at all?),
// never to compute lean.
export const POLITICAL_VOCAB = [
  'congress', 'senate', 'senator~', 'house of representatives',
  'representative~', 'president~', 'presidency', 'white house',
  'governor~', 'legislature', 'legislation', 'bill', 'law~',
  'election~', 'campaign~', 'ballot~', 'voter~', 'voting', 'poll~',
  'democrat~', 'republican~', 'gop', 'liberal~', 'conservative~',
  'progressive~', 'libertarian~',
  'policy', 'policies', 'regulation~', 'regulatory', 'federal',
  'supreme court', 'scotus', 'justice department', 'doj', 'fbi',
  'government', 'administration', 'cabinet', 'secretary of',
  'immigration', 'border', 'asylum', 'tariff~', 'sanction~',
  'abortion', 'medicare', 'medicaid', 'social security',
  'tax~', 'budget', 'deficit', 'inflation', 'minimum wage',
  'military', 'pentagon', 'war', 'nato', 'foreign policy',
  'ukraine', 'russia', 'china', 'israel', 'gaza', 'iran',
  'first amendment', 'second amendment', 'civil rights',
  'climate', 'epa', 'healthcare', 'health care', 'impeach~',
  'executive order~', 'veto~', 'filibuster', 'primaries', 'primary',
]
