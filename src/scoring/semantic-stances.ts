// Local, deterministic semantic fallback for policy stances.
//
// This is deliberately not a generic topic embedding: topic similarity cannot
// tell support from opposition. Each prototype represents an expressed policy
// position, and a candidate clause must contain the issue, an authorial stance
// cue, and most of a reviewed prototype's normalized concepts. Nothing leaves
// the server and identical text always produces identical output.

export type SemanticStanceHit = {
  issue: string
  side: 'left' | 'right'
  label: string
  weight: number
  confidence: number
  evidence: string
  method: 'prototype'
}

type PrototypeGroup = {
  issue: string
  side: 'left' | 'right'
  label: string
  subjects: RegExp
  examples: string[]
}

const GROUPS: PrototypeGroup[] = [
  {
    issue: 'labor', side: 'left', label: 'stronger worker and union protections',
    subjects: /\b(worker|labor|union|wage|apprentice|collective bargain)/i,
    examples: [
      'guarantee union labor standards',
      'protect workers and collective bargaining',
      'require fair wages and apprenticeship slots',
      'strengthen workplace safety and worker protections',
    ],
  },
  {
    issue: 'labor', side: 'right', label: 'fewer labor mandates on employers',
    subjects: /\b(worker|labor|union|wage|employer|business)/i,
    examples: [
      'oppose union mandates on employers',
      'reduce labor regulations on businesses',
      'reject government wage mandates',
      'protect workers right to reject a union',
    ],
  },
  {
    issue: 'public health', side: 'left', label: 'greater public-health investment',
    subjects: /\b(public health|pandemic|ventilation|contact trac|county health|medicaid|health coverage)/i,
    examples: [
      'fund public health infrastructure',
      'invest in ventilation and contact tracing',
      'expand health coverage and local health staffing',
      'strengthen transparent public health data sharing',
    ],
  },
  {
    issue: 'public health', side: 'right', label: 'fewer centralized health mandates',
    subjects: /\b(public health|pandemic|vaccine|mask|health mandate|health agency)/i,
    examples: [
      'oppose federal public health mandates',
      'limit government vaccine and mask requirements',
      'return public health decisions to states and families',
      'require more limits on public health agency power',
    ],
  },
  {
    issue: 'immigration', side: 'left', label: 'broader legal and humanitarian pathways',
    subjects: /\b(immigra|migrant|asylum|refugee|daca|border)/i,
    examples: [
      'expand legal immigration pathways',
      'protect asylum seekers and refugee families',
      'create permanent legal status for immigrants',
      'limit deportation and family separation',
    ],
  },
  {
    issue: 'immigration', side: 'right', label: 'stricter immigration enforcement',
    subjects: /\b(immigra|migrant|asylum|deport|border)/i,
    examples: [
      'increase border enforcement and deportations',
      'restrict asylum and illegal immigration',
      'require stronger border security',
      'limit immigration until the border is controlled',
    ],
  },
  {
    issue: 'climate', side: 'left', label: 'stronger climate and clean-energy action',
    subjects: /\b(climate|emission|renewable|clean energy|pollution|carbon|fossil fuel)/i,
    examples: [
      'require measurable emissions reductions',
      'measurable emissions cuts',
      'invest in renewable energy and grid upgrades',
      'regulate carbon pollution and fossil fuels',
      'make polluters pay for climate damage',
    ],
  },
  {
    issue: 'energy', side: 'right', label: 'greater domestic production and energy choice',
    subjects: /\b(energy|oil|gas|pipeline|drilling|refinery|nuclear)/i,
    examples: [
      'expand domestic oil and gas production',
      'increase domestic nuclear and gas capacity',
      'approve pipelines and energy infrastructure',
      'reduce regulations on energy producers',
      'prioritize reliable energy over mandates',
    ],
  },
  {
    issue: 'education', side: 'left', label: 'greater public-school investment and access',
    subjects: /\b(school|education|teacher|student|college|university|voucher)/i,
    examples: [
      'fund public schools and teachers',
      'oppose vouchers that divert public school funding',
      'expand equal access to public education',
      'invest in school staff and student services',
    ],
  },
  {
    issue: 'education', side: 'right', label: 'greater parental control and school choice',
    subjects: /\b(school|education|parent|curriculum|student|voucher|homeschool)/i,
    examples: [
      'expand parental control over education',
      'give families school choice and vouchers',
      'require curriculum transparency for parents',
      'return education decisions to parents and local communities',
    ],
  },
  {
    issue: 'housing', side: 'left', label: 'greater housing investment and tenant protection',
    subjects: /\b(housing|rent|tenant|landlord|homeless|home afford)/i,
    examples: [
      'expand affordable housing and tenant protections',
      'fund public and affordable housing',
      'protect renters from excessive rent increases',
      'require landlords to provide safe housing',
    ],
  },
  {
    issue: 'housing', side: 'right', label: 'fewer housing and development restrictions',
    subjects: /\b(housing|rent|tenant|landlord|zoning|development|home build)/i,
    examples: [
      'reduce zoning and building regulations',
      'oppose rent control and housing mandates',
      'let private developers build more housing',
      'protect property owners from government restrictions',
    ],
  },
  {
    issue: 'fiscal policy', side: 'left', label: 'more progressive revenue and public investment',
    subjects: /\b(tax|budget|spending|billionaire|corporation|public investment|student debt)/i,
    examples: [
      'raise taxes on wealthy people and corporations',
      'fund public services with progressive taxes',
      'invest government money in public programs',
      'forgive student debt and expand public support',
    ],
  },
  {
    issue: 'fiscal policy', side: 'right', label: 'lower taxes, spending, and regulation',
    subjects: /\b(tax|budget|spending|deficit|debt|regulation|government program)/i,
    examples: [
      'cut government spending and taxes',
      'reduce the deficit and federal programs',
      'oppose taxpayer funding for new programs',
      'reduce regulation and compliance costs',
    ],
  },
  {
    issue: 'voting', side: 'left', label: 'broader ballot access and voting protections',
    subjects: /\b(vot|ballot|polling place|redistrict|election access)/i,
    examples: [
      'expand voting and ballot access',
      'protect voters from disenfranchisement',
      'make voter registration easier',
      'use independent redistricting commissions',
    ],
  },
  {
    issue: 'voting', side: 'right', label: 'stricter election safeguards',
    subjects: /\b(vot|ballot|election|voter roll|signature verification)/i,
    examples: [
      'require voter identification and signature verification',
      'strengthen election security and ballot controls',
      'audit voter rolls and require paper ballots',
      'limit ballot collection and late voting',
    ],
  },
  {
    issue: 'civil rights', side: 'left', label: 'stronger civil-rights protections',
    subjects: /\b(civil right|discriminat|racial|lgbt|transgender|equal protection|qualified immunity)/i,
    examples: [
      'expand civil rights and anti discrimination protections',
      'protect transgender people from discrimination',
      'end qualified immunity and strengthen accountability',
      'require equal treatment under the law',
    ],
  },
  {
    issue: 'civil rights', side: 'right', label: 'greater religious and associational freedom',
    subjects: /\b(religious liberty|religious freedom|conscience|first amendment|free speech|association)/i,
    examples: [
      'protect religious liberty from government mandates',
      'expand conscience protections and free association',
      'oppose compelled speech requirements',
      'protect unpopular speech from institutional censorship',
    ],
  },
  {
    issue: 'public safety', side: 'left', label: 'greater police accountability and prevention',
    subjects: /\b(police|law enforcement|crime|public safety|qualified immunity|sentencing)/i,
    examples: [
      'strengthen police accountability and community prevention',
      'reduce incarceration and reform sentencing',
      'invest in violence prevention instead of punishment',
      'limit police use of force and qualified immunity',
    ],
  },
  {
    issue: 'public safety', side: 'right', label: 'stronger enforcement and sentencing',
    subjects: /\b(police|law enforcement|crime|public safety|sentence|prosecutor)/i,
    examples: [
      'hire more police and strengthen enforcement',
      'increase penalties for violent crime',
      'support law enforcement staffing and prosecution',
      'prioritize victims and tougher sentencing',
    ],
  },
  {
    issue: 'foreign policy', side: 'left', label: 'greater restraint and congressional war authority',
    subjects: /\b(war|military|troop|airstrike|bombing|ceasefire|war powers|congressional author)/i,
    examples: [
      'end military intervention and bring troops home',
      'require congress to authorize military action',
      'support a ceasefire and diplomatic resolution',
      'oppose unauthorized airstrikes and bombing',
    ],
  },
  {
    issue: 'foreign policy', side: 'right', label: 'greater military strength and deterrence',
    subjects: /\b(war|military|troop|defense|deterrence|adversary|national security)/i,
    examples: [
      'strengthen military deterrence and readiness',
      'continue the mission until the threat is defeated',
      'increase defense spending and military capability',
      'oppose withdrawal that rewards hostile regimes',
    ],
  },
  {
    issue: 'technology', side: 'left', label: 'stronger technology-platform regulation',
    subjects: /\b(big tech|technology compan|social media|artificial intelligence|\bai\b|antitrust|data privacy)/i,
    examples: [
      'regulate technology companies and protect data privacy',
      'enforce antitrust law against big tech',
      'require algorithm transparency and consumer protections',
      'hold social media platforms accountable for harms',
    ],
  },
  {
    issue: 'technology', side: 'right', label: 'fewer technology mandates and speech controls',
    subjects: /\b(big tech|technology compan|social media|artificial intelligence|\bai\b|antitrust|data privacy)/i,
    examples: [
      'reduce government regulation of technology companies',
      'oppose government control of online speech',
      'protect innovation from artificial intelligence mandates',
      'limit government pressure on social media platforms',
    ],
  },
]

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'more', 'of', 'on', 'or', 'our', 'that', 'the', 'their',
  'this', 'to', 'with', 'should', 'must', 'need', 'needs', 'want', 'wants', 'we', 'i',
])

const AUTHOR_STANCE_CUE = /(?:\b(?:i|we|our|us)\b(?:\s+\w+){0,5}\s+\b(?:want|support|oppose|reject|believe|need|demand|favor)|\b(?:should|must|need(?:s)? to|deserve(?:s)?|support|oppose|reject|let us|let's)\b|\bwho(?:\s+\w+){0,3}\s+(?:guarantee|ensure|protect|fund)|^\s*(?:fund|protect|expand|increase|strengthen|require|invest|guarantee|ensure|limit|reduce|cut|ban|allow|stop|end|keep|prioriti[sz]e|return)\b)/i
const OPPOSITION_CUE = /\b(?:oppose|reject|against|should not|shouldn't|must not|mustn't|do not|don't|cannot|can't)\b/i
const NO_POSITION = /\b(?:have not|haven't|do not|don't) (?:taken|take|have) (?:a |any )?position\b/i

const QUOTED = /["“]([^"“”]{2,600}?)["”]/g

function stem(value: string): string {
  return value
    .replace(/(ization|ational|fulness|ousness|iveness)$/i, '')
    .replace(/(ments|ment|ations|ation|ities|ity|ingly|edly|ings|ing|ers|ies|ed|es|s)$/i, '')
}

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(stem)
    .filter((token) => token.length >= 3 && !STOP.has(token))
}

function prototypeCoverage(clause: string, example: string): { score: number; overlap: number } {
  const clauseTokens = new Set(normalizedTokens(clause))
  const exampleTokens = [...new Set(normalizedTokens(example))]
  const overlap = exampleTokens.filter((token) => clauseTokens.has(token)).length
  return {
    overlap,
    score: exampleTokens.length > 0 ? overlap / exampleTokens.length : 0,
  }
}

function evidenceSnippet(clause: string): string {
  const compact = clause.replace(/\s+/g, ' ').trim()
  return compact.length <= 150 ? compact : `${compact.slice(0, 147)}…`
}

export function detectSemanticStances(text: string): SemanticStanceHit[] {
  const unquoted = text.replace(QUOTED, ' ').replace(/\s+/g, ' ').trim()
  const clauses = unquoted.split(/(?<=[.!?;])\s+|\s+[—–-]\s+/).filter(Boolean)
  const candidates: SemanticStanceHit[] = []

  for (const group of GROUPS) {
    let best: { score: number; overlap: number; clause: string } | null = null
    for (const clause of clauses) {
      if (!group.subjects.test(clause) || !AUTHOR_STANCE_CUE.test(clause) || NO_POSITION.test(clause)) continue
      for (const example of group.examples) {
        // An explicit rejection of a proposal must never be interpreted as
        // support merely because the rejected policy words overlap.
        if (OPPOSITION_CUE.test(clause) !== OPPOSITION_CUE.test(example)) continue
        const match = prototypeCoverage(clause, example)
        if (match.overlap < 2 || match.score < 0.58) continue
        if (!best || match.score > best.score) best = { ...match, clause }
      }
    }
    if (!best) continue
    candidates.push({
      issue: group.issue,
      side: group.side,
      label: group.label,
      weight: 1.6,
      confidence: Math.min(0.88, 0.58 + best.score * 0.3),
      evidence: evidenceSnippet(best.clause),
      method: 'prototype',
    })
  }

  // If both sides matched the same issue with nearly identical evidence, the
  // language is too ambiguous for the fallback. Strong, distinct matches are
  // retained as genuine mixed evidence and can resolve to the center.
  return candidates.filter((candidate) => {
    const opposite = candidates.find(
      (other) => other.issue === candidate.issue && other.side !== candidate.side
    )
    return !opposite || Math.abs(opposite.confidence - candidate.confidence) >= 0.04 ||
      opposite.evidence !== candidate.evidence
  })
}
