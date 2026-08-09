// ============================================================
// Stage B1 — the coalition mapping.
//
// THIS FILE IS THE ONLY PLACE IN THE SCORER THAT HOLDS A POLITICAL
// JUDGEMENT. Claim extraction (claims.ts) says what the author wants;
// this says which side wants that. Keeping the two apart is the point
// of the redesign — the previous scorer stamped a side inside each of
// ~70 regexes, so revising one judgement meant hunting through all of
// them, and "the author disagrees" had nowhere to go.
//
// Topics are named as THE QUANTITY BEING INCREASED. That dissolves the
// rights-inversion problem without per-domain exceptions: banning
// assault weapons is *more* gun-regulation, not less of something, and
// expanding gun rights is *more* gun-rights. Both read naturally.
//
// `contested` is a real answer. Where the left/right mapping has
// genuinely moved — tariffs were labour-left protectionism for a
// century and are Trump-coded now — refusing to place is more honest
// than encoding a snapshot and forgetting the date.
//
// Every row carries `asOf` and `note`. Changing any row is a scale
// change: bump POST_SCORER_VERSION and re-score.
// ============================================================

export type Side = 'left' | 'right'
export type Mapping = Side | 'contested'

export type TopicRule = {
  /** Named as the quantity being increased. */
  topic: string
  /** Which coalition wants more of it. */
  moreMeans: Mapping
  /** When this judgement was last reviewed. */
  asOf: string
  note: string
}

export const TOPIC_DIRECTION: TopicRule[] = [
  // --- Economic role of government -------------------------------
  { topic: 'healthcare-provision', moreMeans: 'left', asOf: '2026-08',
    note: 'Public coverage, Medicaid/Medicare expansion, public-health capacity.' },
  { topic: 'social-safety-net', moreMeans: 'left', asOf: '2026-08',
    note: 'Welfare, food assistance, childcare, paid leave.' },
  { topic: 'debt-relief', moreMeans: 'left', asOf: '2026-08',
    note: 'Student-debt cancellation and medical-debt forgiveness.' },
  { topic: 'taxes-on-high-earners', moreMeans: 'left', asOf: '2026-08',
    note: 'Corporate, estate and wealth taxation.' },
  { topic: 'government-spending', moreMeans: 'left', asOf: '2026-08',
    note: 'Generic fiscal expansion. Weakest of the economic topics — a call to fund something specific is usually better captured by that topic.' },
  { topic: 'labor-power', moreMeans: 'left', asOf: '2026-08',
    note: 'Unions, wage floors, bargaining rights, apprenticeships.' },
  { topic: 'business-regulation', moreMeans: 'left', asOf: '2026-08',
    note: 'Compliance requirements on firms. "Repeal the regulation" is less of this.' },
  { topic: 'entitlement-solvency', moreMeans: 'right', asOf: '2026-08',
    note: 'Framing Social Security/Medicare as a solvency problem needing restraint.' },

  // --- Energy and climate ----------------------------------------
  { topic: 'climate-action', moreMeans: 'left', asOf: '2026-08',
    note: 'Emissions limits, transition funding, grid buildout.' },
  { topic: 'fossil-production', moreMeans: 'right', asOf: '2026-08',
    note: 'Domestic drilling, pipelines, energy-independence framing.' },

  // --- Rights domains --------------------------------------------
  { topic: 'gun-regulation', moreMeans: 'left', asOf: '2026-08',
    note: 'Background checks, assault-weapon restrictions, safe storage.' },
  { topic: 'gun-rights', moreMeans: 'right', asOf: '2026-08',
    note: 'Second Amendment expansion, carry rights.' },
  { topic: 'abortion-access', moreMeans: 'left', asOf: '2026-08',
    note: 'Reproductive care availability and funding.' },
  { topic: 'lgbtq-protection', moreMeans: 'left', asOf: '2026-08',
    note: 'Anti-discrimination protection and gender-affirming care.' },
  { topic: 'religious-liberty', moreMeans: 'right', asOf: '2026-08',
    note: 'Conscience exemptions, compelled-speech objections.' },

  // --- Immigration ------------------------------------------------
  { topic: 'immigration-openness', moreMeans: 'left', asOf: '2026-08',
    note: 'Legal pathways, asylum access, DACA, birthright citizenship.' },
  { topic: 'immigration-enforcement', moreMeans: 'right', asOf: '2026-08',
    note: 'Border enforcement, deportation, asylum restriction.' },

  // --- Crime and policing ------------------------------------------
  { topic: 'police-enforcement', moreMeans: 'right', asOf: '2026-08',
    note: 'Staffing, sentencing severity, proactive enforcement.' },
  { topic: 'police-accountability', moreMeans: 'left', asOf: '2026-08',
    note: 'Qualified immunity, oversight boards, use-of-force limits.' },
  { topic: 'drug-enforcement', moreMeans: 'right', asOf: '2026-08',
    note: 'Interdiction and criminal penalties.' },
  { topic: 'harm-reduction', moreMeans: 'left', asOf: '2026-08',
    note: 'Treatment access, naloxone, decriminalisation.' },

  // --- Education ----------------------------------------------------
  { topic: 'public-education-funding', moreMeans: 'left', asOf: '2026-08',
    note: 'Public-school investment, teacher pay.' },
  { topic: 'school-choice', moreMeans: 'right', asOf: '2026-08',
    note: 'Vouchers, charters, education savings accounts.' },
  { topic: 'parental-control-schools', moreMeans: 'right', asOf: '2026-08',
    note: 'Curriculum transparency and parental veto.' },

  // --- Democracy ------------------------------------------------------
  { topic: 'voting-access', moreMeans: 'left', asOf: '2026-08',
    note: 'Automatic registration, mail ballots, early voting.' },
  { topic: 'voting-restrictions', moreMeans: 'right', asOf: '2026-08',
    note: 'Voter ID, signature verification, roll purges.' },

  // --- Foreign policy and defence --------------------------------------
  { topic: 'military-force', moreMeans: 'right', asOf: '2026-08',
    note: 'Deterrence, readiness, willingness to strike.' },
  { topic: 'war-powers-constraint', moreMeans: 'left', asOf: '2026-08',
    note: 'Congressional authorisation, limits on unilateral action.' },

  // --- Housing and cities -------------------------------------------
  { topic: 'tenant-protection', moreMeans: 'left', asOf: '2026-08',
    note: 'Rent stabilisation, eviction protection.' },
  { topic: 'public-transit', moreMeans: 'left', asOf: '2026-08',
    note: 'Transit funding and service expansion.' },

  { topic: 'veterans-support', moreMeans: 'left', asOf: '2026-08',
    note: 'Weak. Both coalitions claim it; only the funding-versus-deployment framing leans.' },
  { topic: 'court-reform', moreMeans: 'left', asOf: '2026-08',
    note: 'Structural change to the federal judiciary — expansion, term limits, ethics rules.' },

  // --- Coalition approval ---------------------------------------------
  // Expressed approval of a coalition, rather than of a policy. Criticism is
  // *less* approval, so it resolves to the opposing side. Carries lower
  // weight at the call site: naming a party is not a policy position.
  { topic: 'republican-coalition-approval', moreMeans: 'right', asOf: '2026-08',
    note: 'Approval of Republican conduct and priorities.' },
  { topic: 'democratic-coalition-approval', moreMeans: 'left', asOf: '2026-08',
    note: 'Approval of Democratic conduct and priorities.' },

  // --- Genuinely contested -------------------------------------------
  // These are not gaps. The mapping has moved within living memory or
  // splits both coalitions internally, so a placement would be a guess
  // dressed as a measurement.
  { topic: 'housing-supply', moreMeans: 'contested', asOf: '2026-08',
    note: 'Deregulatory YIMBYism splits both coalitions; supply-side zoning reform has left and right advocates and opponents.' },
  { topic: 'trade-protection', moreMeans: 'contested', asOf: '2026-08',
    note: 'Labour-left protectionism for a century, Trump-coded since ~2016. Both parties now contain both positions.' },
  { topic: 'speech-regulation', moreMeans: 'contested', asOf: '2026-08',
    note: 'Platform moderation: right frames removal as censorship, left frames non-removal as harm. Sides swap by platform and topic.' },
  { topic: 'tech-antitrust', moreMeans: 'contested', asOf: '2026-08',
    note: 'Breaking up large platforms has committed advocates in both coalitions for opposite reasons.' },
  { topic: 'ai-regulation', moreMeans: 'contested', asOf: '2026-08',
    note: 'Not yet coalition-aligned; safety and accelerationist camps cut across party.' },
]

const BY_TOPIC = new Map(TOPIC_DIRECTION.map((rule) => [rule.topic, rule]))

export function lookupTopic(topic: string): TopicRule | undefined {
  return BY_TOPIC.get(topic)
}

export const flip = (side: Side): Side => (side === 'left' ? 'right' : 'left')

/**
 * Resolve a claim's net direction to a side.
 *
 * `moreMeans` answers "who wants more of this". A claim for *less* of it, or
 * a claim *against* more of it, belongs to the other coalition. Both flips
 * compose, which is what makes "I oppose cutting Medicaid" work without a
 * second rule: less healthcare-provision is right, opposing it is left.
 */
export function resolveTopic(
  topic: string,
  netDirection: 'more' | 'less'
): { side: Side } | { side: null; reason: 'contested' | 'unmapped-topic' } {
  const rule = BY_TOPIC.get(topic)
  if (!rule) return { side: null, reason: 'unmapped-topic' }
  if (rule.moreMeans === 'contested') return { side: null, reason: 'contested' }
  return { side: netDirection === 'more' ? rule.moreMeans : flip(rule.moreMeans) }
}
