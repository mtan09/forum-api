// ============================================================
// Stage A — claim extraction.
//
// Turns free text into "what does the author want", with NO political
// judgement. A claim says `more healthcare-provision` or `less
// business-regulation`; which coalition that belongs to is decided in
// direction.ts and nowhere else.
//
// Two extractors, one output shape:
//
//   TEMPLATE  a direction verb crossed with topic vocabulary. Generic,
//             so one rule reads hundreds of phrasings. Only valid where
//             the topic term names the QUANTITY ("fund Medicaid" =>
//             more healthcare-provision).
//
//   PHRASE    verb-plus-object pairs and idioms where the template
//             would invert. "Ban assault weapons" is *more*
//             gun-regulation even though "ban" is a contracting verb,
//             because the object is the thing being restricted rather
//             than the quantity being set.
//
// Polarity is a field, not a reason to discard. The old scorer dropped
// any match whose clause began with "oppose", which is why every rule
// worked only when the author agreed with it.
// ============================================================

import {
  clauses,
  compileAll,
  firstHit,
  isAttributed,
  normalize,
  snippet,
  polarityOf,
  AGAINST_CUE,
  FOR_CUE,
  EXPLICIT_NO_POSITION,
  type Compiled,
  type Polarity,
} from './matching'
import { detectStances } from './stances'

export type Direction = 'more' | 'less'
export type { Polarity }

export type Claim = {
  kind: 'policy' | 'actor'
  /** Topic key (policy) or action key (actor). Resolved in direction.ts. */
  topic: string
  /** Named entity, actor claims only. */
  target?: string
  /** What the sentence proposes doing. */
  direction: Direction
  /** Whether the author is for or against that. */
  polarity: Polarity
  weight: number
  confidence: number
  method: 'stance' | 'template' | 'phrase' | 'actor'
  /** For stance claims, which matcher inside the phrase library fired. */
  source?: string
  evidence: string
}

/** What the author actually wants, after applying polarity. */
export const netDirection = (claim: Claim): Direction =>
  claim.polarity === 'for'
    ? claim.direction
    : claim.direction === 'more' ? 'less' : 'more'

// A claim requires advocacy. Without that gate a descriptive sentence
// ("violent crime is down in most cities") becomes a position, and
// mislabelling a neutral post is worse than leaving it blank. Cues live in
// matching.ts because stances.ts needs the same ones.

// --- Direction verbs ------------------------------------------------
const EXPAND_TERMS = [
  'expand~', 'fund~', 'increase~', 'raise~', 'raising', 'invest~', 'guarantee~',
  'require~', 'mandate~', 'protect~', 'restore~', 'strengthen~', 'extend~',
  'broaden~', 'boost~', 'grow~', 'add~', 'create~', 'enact~', 'pass~', 'impose~',
  'regulate~', 'approve~', 'authorize~', 'authorise~', 'subsidize~', 'subsidise~',
  'more funding for', 'more money for',
]
const CONTRACT_TERMS = [
  'cut~', 'cutting', 'repeal~', 'defund~', 'reduce~', 'reducing', 'eliminate~',
  'abolish~', 'block~', 'ban~', 'restrict~', 'deregulate~', 'scale back',
  'roll back', 'limit~', 'curb~', 'shrink~', 'slash~', 'end~', 'ending',
  'privatize~', 'privatise~', 'withdraw~', 'rescind~', 'strike down',
  'weaken~', 'gut~', 'exempt~', 'divert~',
]

const EXPAND = compileAll(EXPAND_TERMS)
const CONTRACT = compileAll(CONTRACT_TERMS)

// --- Topic vocabulary ---------------------------------------------
// QUANTITY nouns only. An object noun ("assault weapon", "tariff") belongs
// in PHRASES, because a contracting verb applied to it means *more* policy,
// not less. Ordered most specific first — matching stops at the first hit.
const TOPIC_TERMS: [topic: string, terms: string[]][] = [
  ['healthcare-provision', [
    'medicaid', 'medicare', 'affordable care act', 'obamacare', 'health coverage',
    'public health funding', 'health insurance subsidies', 'public option',
    'cdc funding', 'contact tracing', 'county health staffing',
  ]],
  ['social-safety-net', [
    'safety net', 'food stamps', 'snap benefits', 'welfare benefits',
    'universal childcare', 'child care subsidies', 'paid leave',
    'housing assistance', 'unemployment benefits', 'child tax credit',
  ]],
  ['taxes-on-high-earners', [
    'corporate tax~', 'corporate taxes', 'estate tax', 'death tax', 'wealth tax',
    'capital gains tax~', 'taxes on billionaires', 'taxes on the wealthy',
    'top marginal rate',
  ]],
  ['labor-power', [
    'minimum wage', 'union~', 'collective bargaining', 'apprenticeship~',
    'worker protections', 'labor standards', 'wage mandate~', 'overtime rules',
    'prevailing wage',
  ]],
  ['business-regulation', [
    'regulation~', 'regulatory burden', 'compliance cost~', 'red tape',
    'licensing requirement~', 'antitrust enforcement',
  ]],
  ['climate-action', [
    'emissions', 'carbon pollution', 'carbon price', 'clean energy',
    'renewable~', 'energy transition', 'grid interconnection', 'climate resilience',
  ]],
  ['fossil-production', [
    'domestic oil production', 'oil production', 'drilling', 'pipeline~',
    'energy independence', 'domestic production', 'coal plant~',
  ]],
  ['gun-rights', ['second amendment', 'gun rights', 'concealed carry', 'carry permit~']],
  ['abortion-access', [
    'abortion access', 'abortion care', 'reproductive rights', 'reproductive care',
    'planned parenthood', 'contraception access',
  ]],
  ['lgbtq-protection', [
    'gender-affirming care', 'marriage equality', 'anti-discrimination protections',
    'trans health care',
  ]],
  ['religious-liberty', ['religious liberty', 'religious freedom', 'conscience protections']],
  ['immigration-openness', [
    'path to citizenship', 'pathway to citizenship', 'legal status',
    'daca', 'dreamers', 'asylum access', 'legal immigration pathway~',
    'birthright citizenship', 'refugee admissions',
  ]],
  ['immigration-enforcement', [
    'border enforcement', 'border security', 'deportation~', 'ice enforcement',
    'asylum restriction~', 'immigration detention', 'border wall',
  ]],
  // 'qualified immunity' and 'use-of-force' are shields, not the quantity —
  // ending them *increases* accountability, so they live in PHRASES.
  ['police-accountability', [
    'police accountability', 'civilian oversight', 'body camera~',
    'oversight board~',
  ]],
  ['police-enforcement', [
    'police staffing', 'police funding', 'sentencing', 'mandatory minimum~',
    'more officers', 'law enforcement funding',
  ]],
  ['drug-enforcement', ['drug interdiction', 'fentanyl seizures', 'drug penalties', 'trafficking penalties']],
  ['harm-reduction', ['harm reduction', 'naloxone', 'treatment access', 'decriminalization', 'decriminalisation', 'safe injection']],
  ['public-education-funding', [
    'public school funding', 'public schools', 'teacher pay', 'title i funding',
    'school funding',
  ]],
  ['school-choice', ['school choice', 'voucher~', 'charter school~', 'education savings account~']],
  ['parental-control-schools', ['parental rights', 'curriculum transparency', 'parental oversight']],
  ['voting-access', [
    'automatic voter registration', 'voter registration', 'ballot access',
    'mail ballot~', 'early voting', 'voting rights',
  ]],
  ['voting-restrictions', ['voter id', 'voter identification', 'signature verification', 'roll purge~']],
  ['military-force', [
    'military readiness', 'deterrence', 'defense modernization', 'airstrike~',
    'military capacity', 'troop deployment~',
  ]],
  ['war-powers-constraint', [
    'war powers', 'congressional authorization', 'congressional approval',
    'authorization for use of military force',
  ]],
  ['tenant-protection', ['rent control', 'rent stabilization', 'tenant protections', 'eviction protections']],
  ['public-transit', ['public transit', 'transit funding', 'bus service', 'rail service']],
  ['entitlement-solvency', ['trust fund', 'entitlement reform', 'entitlement spending']],
  ['housing-supply', ['zoning', 'housing supply', 'homebuilding', 'affordable housing']],
  ['trade-protection', ['tariff~', 'trade barrier~', 'import duties', 'protectionism']],
  ['speech-regulation', ['content moderation', 'platform moderation', 'online speech rules', 'section 230']],
  ['tech-antitrust', ['big tech breakup', 'platform monopol~', 'tech antitrust']],
  ['ai-regulation', ['ai regulation', 'ai mandate~', 'algorithm transparency', 'ai safety rules']],
  ['government-spending', ['federal spending', 'discretionary spending', 'public investment', 'the deficit']],
]

const COMPILED_TOPICS: [string, Compiled[]][] =
  TOPIC_TERMS.map(([topic, terms]) => [topic, compileAll(terms)])

// --- Phrase patterns ------------------------------------------------
// Where the template would invert, or where a whole position has an
// idiomatic name. Direction is stated outright rather than derived.
type Phrase = { topic: string; direction: Direction; patterns: RegExp[] }

const PHRASES: Phrase[] = [
  // Guns — the object is what gets restricted, so restricting is *more* policy.
  { topic: 'gun-regulation', direction: 'more', patterns: [
    /\b(?:ban|restrict|regulate|limit|prohibit)\w*\s+(?:\w+\s+){0,3}?(?:assault weapons?|firearms?|guns?|high-capacity magazines?)\b/i,
    /\b(?:assault weapons?|firearms?|guns?)\s+(?:\w+\s+){0,2}?(?:ban|restrictions?|control)\b/i,
    /\b(?:universal )?background checks?\b/i,
    /\bgun safety (?:laws?|legislation|measures?)\b/i,
    /\bred flag laws?\b/i,
  ]},
  // Debt — cancelling a burden is *more* relief.
  { topic: 'debt-relief', direction: 'more', patterns: [
    /\b(?:cancel|forgive|wipe out|discharge)\w*\s+(?:\w+\s+){0,3}?(?:student (?:debt|loans?)|medical debt)\b/i,
    /\bstudent (?:debt|loans?)\s+(?:\w+\s+){0,3}?(?:cancell?ation|forgiveness|relief)\b/i,
    /\bstudent (?:debt|loans?)\s+should be (?:cancell?ed|forgiven)\b/i,
  ]},
  // Immigration enforcement — deporting is the action itself.
  { topic: 'immigration-enforcement', direction: 'more', patterns: [
    /\bdeport(?:s|ed|ing)?\b/i,
    /\b(?:secure|seal|close) the border\b/i,
    /\bcrack down on (?:illegal )?immigration\b/i,
    /\brestrict\w*\s+(?:\w+\s+){0,3}?(?:birth tourism|birthright citizenship|asylum)\b/i,
  ]},
  { topic: 'immigration-openness', direction: 'more', patterns: [
    /\b(?:brought|came) here as (?:a )?(?:child|children|kid|toddler)s?\b/i,
    /\bfamily separation\b/i,
  ]},
  // Abortion — defunding the provider is captured by the template, but
  // restricting access idiomatically is not.
  { topic: 'abortion-access', direction: 'less', patterns: [
    /\b(?:abortion|gestational) (?:ban|limits?|restrictions?)\b/i,
    /\bheartbeat (?:bill|law)\b/i,
  ]},
  // Foreign policy.
  { topic: 'war-powers-constraint', direction: 'more', patterns: [
    /\bcongress(?:\s+\w+){0,5}\s+(?:has not|hasn't|never)\s+voted\b/i,
    /\bcongress (?:must|should|needs? to) vote\b/i,
    /\b(?:unauthori[sz]ed|illegal|unconstitutional)\s+(?:war|strike|bombing|military action)\b/i,
  ]},
  { topic: 'military-force', direction: 'more', patterns: [
    /\bpeace through strength\b/i,
    /\b(?:restore|maintain) deterrence\b/i,
    /\bdecisive (?:military )?action\b/i,
    /\b(?:cannot|can't) be allowed to threaten (?:U\.S\.|US|American) (?:forces|troops|allies)\b/i,
  ]},
  { topic: 'military-force', direction: 'less', patterns: [
    /\bbring (?:our |the )?(?:troops|soldiers|service members) home\b/i,
    /\bend(?:ing)? (?:the )?(?:endless|forever) wars?\b/i,
    /\bceasefire now\b/i,
  ]},
  // Taxes — "tax relief" and "tax cuts" name the position.
  { topic: 'taxes-on-high-earners', direction: 'less', patterns: [
    /\btax relief\b/i,
    /\btax cuts? for (?:the wealthy|corporations|job creators)\b/i,
  ]},
  { topic: 'taxes-on-high-earners', direction: 'more', patterns: [
    /\bmake (?:the wealthy|billionaires|corporations) pay\b/i,
    /\bfair share of taxes\b/i,
  ]},
  // Labour.
  { topic: 'labor-power', direction: 'more', patterns: [
    /\bright to organi[sz]e\b/i,
    /\bliving wage\b/i,
  ]},
  { topic: 'labor-power', direction: 'less', patterns: [
    /\bright[- ]to[- ]work\b/i,
  ]},
  // Trade — contested, but must still be recognised as a claim so it can
  // be reported as contested rather than silently missed.
  { topic: 'trade-protection', direction: 'more', patterns: [
    /\btariffs?\s+(?:\w+\s+){0,4}?(?:protect|help|save|bring back)\b/i,
    /\bimpose (?:new )?tariffs?\b/i,
  ]},
  { topic: 'trade-protection', direction: 'less', patterns: [
    /\btariffs? are (?:a )?tax(?:es)? on\b/i,
    /\b(?:repeal|lift|drop|end) (?:the )?tariffs?\b/i,
  ]},
  // Education.
  { topic: 'school-choice', direction: 'more', patterns: [
    /\blet(?:ting)? (?:[\w-]+\s+){0,2}?families (?:use|choose|pick)\b/i,
  ]},
  // "Emissions" is a burden, not the quantity — cutting them is *more*
  // climate action. Same shape as qualified immunity and assault weapons.
  { topic: 'climate-action', direction: 'more', patterns: [
    /\bemissions (?:cuts?|reductions?|targets?|limits?|caps?)\b/i,
    /\b(?:cut|reduce|lower)\w*\s+(?:\w+\s+){0,3}?emissions\b/i,
  ]},
  { topic: 'fossil-production', direction: 'more', patterns: [
    /\bmore domestic (?:nuclear|gas|oil|energy|production)\b/i,
    /\bdomestic (?:nuclear|gas|oil) capacity\b/i,
  ]},
  { topic: 'parental-control-schools', direction: 'more', patterns: [
    /\bparents? should (?:control|decide|read the curriculum|demand transparency)\b/i,
    /\bofficials? answer to families\b/i,
  ]},
  // Policing.
  { topic: 'police-enforcement', direction: 'more', patterns: [
    /\b(?:tougher|longer|harsher) (?:sentences?|penalties)\b/i,
    /\bhire more (?:police )?officers\b/i,
    /\bback the blue\b/i,
  ]},
  { topic: 'police-accountability', direction: 'more', patterns: [
    /\b(?:end|abolish|limit|narrow)\w*\s+qualified immunity\b/i,
    /\b(?:limit|restrict|tighten)\w*\s+(?:\w+\s+){0,2}?use[- ]of[- ]force\b/i,
    /\bpolice accountability\b/i,
  ]},
  { topic: 'police-accountability', direction: 'less', patterns: [
    /\b(?:protect|expand|preserve)\w*\s+qualified immunity\b/i,
  ]},
  // Housing.
  { topic: 'tenant-protection', direction: 'more', patterns: [
    /\btenant protections?\b/i,
    /\bjust cause eviction\b/i,
  ]},
]

// --- Epithets ---------------------------------------------------------
// The framing lexicon conflates two different kinds of term, and treating
// them alike is what made "the Affordable Care Act should be repealed" score
// left of centre:
//
//   NAMING TERMS    "estate tax", "Affordable Care Act". Both coalitions use
//                   them. Using one says nothing about your position, because
//                   you may be about to argue against the thing you named.
//                   These can intensify a placement but never create one.
//
//   EPITHETS        "woke", "cancel culture", "big oil", "climate crisis".
//                   Pejorative characterisations of the other side. Nobody
//                   uses them approvingly about their own coalition, so
//                   reaching for one IS the alignment, even with no policy
//                   proposed. These place a post.
//
// The test is whether the term is disparaging. Approving self-descriptions
// ("gun rights", "reproductive rights") are coalition-marked too, but they
// double as neutral policy nouns and carry the same inversion risk as naming
// terms, so they are deliberately excluded.
//
// Modelled as coalition-approval claims so they run through the same
// resolution path as everything else: disparaging a coalition is *less*
// approval of it, which resolves to the opposing side.

const RIGHT_CODED_EPITHETS = [
  'woke', 'wokeness', 'cancel culture', 'radical left', 'far-left', 'far left',
  'left-wing extremis~', 'socialist agenda', 'open borders', 'border crisis',
  'border invasion', 'migrant crime', 'illegal alien~', 'illegals',
  'climate alarmis~', 'gender ideology', 'transgender ideology',
  'identity politics', 'critical race theory', 'big government',
  'government overreach', 'nanny state', 'deep state', 'fake news',
  'liberal media', 'war on coal', 'death tax', 'welfare state',
  'abortion on demand', 'partial-birth abortion', 'voter fraud',
]

const LEFT_CODED_EPITHETS = [
  'far-right', 'far right', 'right-wing extremis~', 'ultraconservative~',
  'white nationalis~', 'insurrection', 'book ban~', 'union busting',
  'gun lobby', 'corporate greed', 'price gouging', 'big oil', 'big pharma',
  'fossil fuel industry', 'voter suppression', 'systemic racism',
  'climate crisis', 'climate emergency', 'tax cuts for the wealthy',
  'tax breaks for the rich',
]

const EPITHETS: [topic: string, lex: Compiled[]][] = [
  // Right-coded epithets disparage the left coalition.
  ['democratic-coalition-approval', compileAll(RIGHT_CODED_EPITHETS)],
  ['republican-coalition-approval', compileAll(LEFT_CODED_EPITHETS)],
]

// --- Actor claims ----------------------------------------------------
// A claim about a named person or proceeding. There is no permanent
// mapping for these — the side is resolved per story in story-context.ts
// from what the headlines said, and expires when the story does.

const ACTOR_ACTIONS: [action: string, re: RegExp][] = [
  ['confirmation', /\b(?:confirmation|confirm(?:ing|ed)?|nomination|nominee|nominat(?:e|ed|ing))\b/i],
  ['ethics-probe', /\b(?:ethics (?:probe|committee|investigation)|ethics inquiry)\b/i],
  ['investigation', /\b(?:investigation|investigat(?:e|ed|ing)|subpoena|indict(?:ment|ed)?|contempt)\b/i],
  ['impeachment', /\bimpeach(?:ment|ed|ing)?\b/i],
  ['resignation', /\b(?:resign(?:ation|ed|ing)?|step(?:ping)? down|withdraw the nomination)\b/i],
]

/** Capitalised multi-word name, avoiding sentence-initial false positives. */
const NAME = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g
const NAME_STOPWORDS = /^(?:The|A|An|If|When|While|But|And|On|In|At|For|This|That|These|Those|We|They|I|My|Our|Senate|House|Congress|Committee)\b/

function extractTarget(clause: string): string | undefined {
  const found: string[] = []
  for (const m of clause.matchAll(NAME)) {
    if (!NAME_STOPWORDS.test(m[1])) found.push(m[1])
  }
  return found[0]
}

// --- Extraction --------------------------------------------------------

function hasAdvocacy(clause: string): boolean {
  // An imperative opening ("Defund Planned Parenthood") carries advocacy
  // without a modal, so accept a clause that begins with a direction verb.
  const opensImperative =
    EXPAND.some(({ re }) => new RegExp(`^\\s*${re.source}`, 'i').test(clause)) ||
    CONTRACT.some(({ re }) => new RegExp(`^\\s*${re.source}`, 'i').test(clause))
  return opensImperative || FOR_CUE.test(clause) || AGAINST_CUE.test(clause)
}

export function detectClaims(text: string): Claim[] {
  const full = normalize(text)
  if (!full || EXPLICIT_NO_POSITION.test(full)) return []

  // One claim per topic. A phrase is more specific than the generic template,
  // so where they disagree — "end qualified immunity" reads as *less*
  // accountability to a template that treats the immunity as the quantity —
  // the phrase wins rather than both surviving and cancelling.
  const PRIORITY: Record<Claim['method'], number> = { stance: 4, phrase: 3, template: 2, actor: 1 }
  const byTopic = new Map<string, Claim>()

  const push = (claim: Claim) => {
    const key = `${claim.kind}:${claim.topic}`
    const current = byTopic.get(key)
    if (current && PRIORITY[current.method] >= PRIORITY[claim.method]) return
    byTopic.set(key, claim)
  }

  // Named positions from the phrase library. Highest priority: they match a
  // specific argument's wording, so where they disagree with the generic
  // template they are the better reading.
  for (const hit of detectStances(full)) {
    push({
      kind: 'policy',
      topic: hit.topic,
      direction: hit.direction,
      polarity: hit.polarity,
      weight: hit.weight,
      confidence: hit.confidence,
      method: 'stance',
      source: hit.method,
      evidence: hit.evidence,
    })
  }

  for (const clause of clauses(full)) {
    const advocacy = hasAdvocacy(clause)

    // -- PHRASE ---------------------------------------------------------
    for (const phrase of PHRASES) {
      const match = phrase.patterns.map((p) => clause.match(p)).find(Boolean) ?? null
      if (!match) continue
      if (isAttributed(clause, match)) continue
      push({
        kind: 'policy',
        topic: phrase.topic,
        direction: phrase.direction,
        polarity: polarityOf(clause, match),
        weight: 2,
        confidence: 0.9,
        method: 'phrase',
        evidence: snippet(clause, match),
      })
    }

    // -- EPITHET --------------------------------------------------------
    // Above the advocacy gate on purpose. These posts characterise rather
    // than propose — "cancel culture is out of control, woke administrators
    // police every word" asks for nothing, but nobody on the other side
    // writes that sentence.
    for (const [topic, lex] of EPITHETS) {
      const hit = firstHit(clause, lex)
      if (!hit || isAttributed(clause, hit.match)) continue
      push({
        kind: 'policy',
        topic,
        direction: 'less',
        polarity: polarityOf(clause, hit.match),
        // Weaker than a policy claim: it locates the author's coalition
        // without saying what they want done.
        weight: 1.2,
        confidence: 0.62,
        method: 'phrase',
        evidence: snippet(clause, hit.match),
      })
      break
    }

    if (!advocacy) continue

    // -- TEMPLATE -------------------------------------------------------
    const topicHit = (() => {
      for (const [topic, lex] of COMPILED_TOPICS) {
        const hit = firstHit(clause, lex)
        if (hit) return { topic, ...hit }
      }
      return null
    })()

    if (topicHit) {
      const expand = firstHit(clause, EXPAND)
      const contract = firstHit(clause, CONTRACT)
      // Whichever verb sits closest to the topic term governs it.
      const pick = (() => {
        if (expand && contract) {
          const t = topicHit.match.index ?? 0
          const de = Math.abs((expand.match.index ?? 0) - t)
          const dc = Math.abs((contract.match.index ?? 0) - t)
          return de <= dc
            ? { dir: 'more' as Direction, hit: expand }
            : { dir: 'less' as Direction, hit: contract }
        }
        if (expand) return { dir: 'more' as Direction, hit: expand }
        if (contract) return { dir: 'less' as Direction, hit: contract }
        return null
      })()

      if (pick && !isAttributed(clause, pick.hit.match)) {
        push({
          kind: 'policy',
          topic: topicHit.topic,
          direction: pick.dir,
          polarity: polarityOf(clause, pick.hit.match),
          weight: 1.8,
          confidence: 0.82,
          method: 'template',
          evidence: snippet(clause, pick.hit.match),
        })
      }
    }

    // -- ACTOR ----------------------------------------------------------
    for (const [action, re] of ACTOR_ACTIONS) {
      const match = clause.match(re)
      if (!match) continue
      if (isAttributed(clause, match)) continue
      push({
        kind: 'actor',
        topic: action,
        target: extractTarget(clause),
        direction: 'more',
        polarity: polarityOf(clause, match),
        weight: 1.6,
        confidence: 0.7,
        method: 'actor',
        evidence: snippet(clause, match),
      })
      break
    }
  }

  return [...byTopic.values()]
}
