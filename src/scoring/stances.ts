// Deterministic policy-stance ontology for user posts.
//
// The framing lexicon detects partisan word choice. These rules detect the
// proposition a writer is advancing, so natural-language policy arguments can
// be placed even when they avoid slogans. Each rule is deliberately narrow,
// auditable, and versioned with the scorer. Rules describe current US partisan
// alignment; they are not judgments about whether a position is correct.

export type StanceSide = 'left' | 'right'

export type StanceHit = {
  issue: string
  side: StanceSide
  label: string
  weight: number
}

type StanceRule = StanceHit & {
  patterns: RegExp[]
  excludes?: RegExp[]
}

const RULES: StanceRule[] = [
  // Foreign policy and presidential war powers
  {
    issue: 'foreign policy', side: 'left', weight: 2,
    label: 'war requires congressional authorization',
    patterns: [
      /\bcongress(?:\s+\w+){0,5}\s+(?:has not|hasn't|never)\s+voted\b/i,
      /\b(?:congressional|congress)\s+(?:authorization|approval|vote)\b/i,
      /\bwar powers(?:\s+(?:act|resolution|clause))?\b/i,
      /\b(?:unauthori[sz]ed|illegal|unconstitutional)\s+(?:war|strike|bombing|military action)\b/i,
    ],
  },
  {
    issue: 'foreign policy', side: 'left', weight: 2,
    label: 'military intervention should end',
    patterns: [
      /\bbring (?:our |the )?(?:troops|soldiers|service members) home\b/i,
      /\bend(?:ing)? (?:the )?(?:endless|forever) wars?\b/i,
      /\b(?:stop|end) (?:the )?(?:bombing|airstrikes?|military campaign)\b/i,
      /\bceasefire now\b/i,
    ],
  },
  {
    issue: 'foreign policy', side: 'right', weight: 2,
    label: 'military strength and deterrence',
    patterns: [
      /\bpeace through strength\b/i,
      /\bdeterrence (?:only )?works\b/i,
      /\b(?:finish|continue) (?:the )?(?:job|campaign|mission)\b/i,
      /\bpulling back(?:\s+\w+){0,5}\s+(?:invites|encourages)\b/i,
      /\bcommander[ -]in[ -]chief (?:authority|powers?)\b/i,
    ],
  },

  // Immigration
  {
    issue: 'immigration', side: 'left', weight: 2,
    label: 'legal status and humane immigration pathways',
    patterns: [
      /\bpath(?:way)? to (?:citizenship|legal status|permanent status)\b/i,
      /\bDACA recipients?\b/i,
      /\b(?:brought|came) here as (?:a )?(?:child|children|kid|toddler)s?\b/i,
      /\b(?:expand|fix|protect) (?:legal )?(?:immigration )?pathways?\b/i,
      /\bfamily separation\b/i,
      /\basylum seekers?\b/i,
      /\bno path to anything permanent\b/i,
    ],
  },
  {
    issue: 'immigration', side: 'right', weight: 2,
    label: 'stricter border enforcement',
    patterns: [
      /\b(?:country|nation)(?:\s+\w+){0,5}\s+control (?:its |the )?borders?\b/i,
      /\b(?:secure|enforce|close) (?:our |the )?borders?\b/i,
      /\bstrict(?:er)? immigration enforcement\b/i,
      /\bmass deportation\b/i,
      /\bbuild (?:the )?wall\b/i,
      /\bremain in mexico\b/i,
    ],
  },

  // Work, wages, and organized labor
  {
    issue: 'labor', side: 'left', weight: 2,
    label: 'stronger wages and collective bargaining',
    patterns: [
      /\b(?:raise|increase|higher) (?:the )?(?:federal )?minimum wage\b/i,
      /\bminimum wage(?:\s+\w+){0,8}\s+(?:floor rises|living wage|too low)\b/i,
      /\bmandatory anti-union meetings?\b/i,
      /\bunion elections?(?:\s+\w+){0,14}\s+(?:pressure campaigns?|intimidation|retaliation)\b/i,
      /\bworkers? (?:deserve|need) (?:a )?(?:union|living wage|seat at the table)\b/i,
      /\b(?:protect|expand) collective bargaining\b/i,
      /\bemployers? (?:do not|don't|will not|won't) volunteer\b/i,
      /\bthe floor rises because people push\b/i,
      /\bminimum wage(?:\s+\w+){0,14}\s+(?:jobs|restaurants?|businesses?)(?:\s+\w+){0,5}\s+(?:did not|didn't|have not|haven't) (?:vanish|disappear|collapse)\b/i,
    ],
  },
  {
    issue: 'labor', side: 'right', weight: 2,
    label: 'less regulation of wages and unions',
    patterns: [
      /\bright[- ]to[- ]work\b/i,
      /\bforced union(?:ism| dues)?\b/i,
      /\bminimum wage(?:\s+\w+){0,8}\s+(?:kills?|costs?) jobs\b/i,
      /\bunion bosses?\b/i,
      /\blabor costs?(?:\s+\w+){0,8}\s+(?:hurt|crush|close|kill)\b/i,
    ],
  },

  // Health care
  {
    issue: 'health care', side: 'left', weight: 2,
    label: 'greater public access and insurance accountability',
    patterns: [
      /\bmedicare for all\b/i,
      /\buniversal health ?care\b/i,
      /\bpublic option\b/i,
      /\bhealth ?care is a human right\b/i,
      /\bprior authorization (?:delays|denials?|blocks?|harms?)\b/i,
      /\binsurance denial\b/i,
      /\bhealth ?care billing system is broken\b/i,
    ],
  },
  {
    issue: 'health care', side: 'right', weight: 2,
    label: 'market-led health care',
    patterns: [
      /\bgovernment[- ]run health ?care\b/i,
      /\bsocialized medicine\b/i,
      /\bhealth ?care (?:choice|competition)\b/i,
      /\b(?:expand|protect) health savings accounts?\b/i,
    ],
  },

  // Climate and energy
  {
    issue: 'climate', side: 'left', weight: 2,
    label: 'climate action and clean-energy transition',
    patterns: [
      /\bclimate risk (?:is|has|keeps|will|hits?|hitting)\b/i,
      /\b(?:cut|reduce) (?:carbon |greenhouse gas )?emissions?\b/i,
      /\btransition to (?:clean|renewable) energy\b/i,
      /\b(?:invest|investment) in (?:clean|renewable) energy\b/i,
      /\bpolluters? (?:must|should|need to) pay\b/i,
    ],
  },
  {
    issue: 'energy', side: 'right', weight: 2,
    label: 'expand domestic energy production',
    patterns: [
      /\b(?:drill|produce) more (?:oil|gas|energy)\b/i,
      /\b(?:expand|increase) (?:domestic )?(?:oil|gas|energy) production\b/i,
      /\benergy security is national security\b/i,
      /\b(?:approve|build) (?:more )?(?:pipelines?|refineries?)\b/i,
      /\bpermit nuclear(?:\s+\w+){0,6}\s+instead of\b/i,
    ],
  },

  // Elections and governing institutions
  {
    issue: 'voting', side: 'left', weight: 2,
    label: 'fewer barriers to voting',
    patterns: [
      /\bvoter id(?:\s+\w+){0,10}\s+(?:cost|burden|DMV|disenfranchis)\b/i,
      /\bvoter id(?:\s+\w+){0,20}\s+(?:who pays|free ids?|DMV hours?|rural counties)\b/i,
      /\b(?:closed|closing) polling places?\b/i,
      /\b(?:expand|protect) (?:ballot|voting) access\b/i,
      /\bautomatic voter registration\b/i,
      /\bindependent (?:redistricting )?commissions?\b/i,
    ],
  },
  {
    issue: 'voting', side: 'right', weight: 2,
    label: 'stricter election safeguards',
    patterns: [
      /\b(?:require|support|adopt) (?:strict )?voter id\b/i,
      /\bvoter id (?:must|should|needs? to) be required\b/i,
      /\b(?:paper ballots?|signature verification)(?:\s+\w+){0,5}\s+(?:required|necessary|secure)\b/i,
      /\b(?:clean|audit) (?:the )?voter rolls\b/i,
    ],
  },

  // Education, reproductive policy, and firearms
  {
    issue: 'education', side: 'right', weight: 2,
    label: 'school choice and parental control',
    patterns: [
      /\bschool choice(?:\s+\w+){0,8}\s+(?:works?|wins?|gives?|lets?|allows?)\b/i,
      /\bparents? (?:should|must|deserve to) (?:choose|control|review)\b/i,
      /\b(?:fund|expand|support) (?:school )?(?:vouchers?|education savings accounts?)\b/i,
      /\bparents? are voting with their feet\b/i,
    ],
  },
  {
    issue: 'education', side: 'left', weight: 2,
    label: 'stronger public-school investment',
    patterns: [
      /\b(?:fund|invest in) public schools?\b/i,
      /\b(?:oppose|end|reject) (?:school )?vouchers?\b/i,
      /\bvouchers?(?:\s+\w+){0,8}\s+(?:drain|defund|weaken) public schools?\b/i,
    ],
  },
  {
    issue: 'abortion', side: 'left', weight: 2,
    label: 'protect abortion and reproductive access',
    patterns: [
      /\b(?:protect|expand|restore) (?:abortion|reproductive) (?:access|rights|freedom|care)\b/i,
      /\breproductive rights(?:\s+\w+){0,10}\s+(?:wins?|matter|protected|ballot)\b/i,
      /\bbodily autonomy(?:\s+\w+){0,6}\s+(?:wins?|right|protected|matters?)\b/i,
    ],
  },
  {
    issue: 'abortion', side: 'right', weight: 2,
    label: 'restrict abortion and protect fetal life',
    patterns: [
      /\b(?:ban|restrict|limit) abortion\b/i,
      /\b(?:protect|defend) (?:unborn|fetal) (?:children|babies|life|lives)\b/i,
      /\blife begins at conception\b/i,
    ],
  },
  {
    issue: 'guns', side: 'left', weight: 2,
    label: 'stronger gun-safety laws',
    patterns: [
      /\b(?:pass|support|strengthen) (?:gun safety|gun control) (?:legislation|laws?|measures?)\b/i,
      /\b(?:universal )?background checks?(?:\s+\w+){0,5}\s+(?:required|law|now|save)\b/i,
      /\b(?:ban|restrict) assault weapons?\b/i,
      /\bgun safety legislation(?:\s+\w+){0,8}\s+(?:dying|blocked|needed)\b/i,
    ],
  },
  {
    issue: 'guns', side: 'right', weight: 2,
    label: 'protect gun ownership and resist new restrictions',
    patterns: [
      /\b(?:protect|defend) (?:gun|second amendment) rights\b/i,
      /\b(?:oppose|reject|stop) (?:new )?(?:gun control|gun restrictions?)\b/i,
      /\benforce (?:the )?(?:gun )?laws? already on the books\b/i,
    ],
  },

  // Public safety
  {
    issue: 'policing', side: 'left', weight: 2,
    label: 'police accountability and reform',
    patterns: [
      /\bpolice accountability\b/i,
      /\b(?:reform|demilitarize) (?:the )?police\b/i,
      /\bend qualified immunity\b/i,
      /\b(?:excessive|deadly) force(?:\s+\w+){0,6}\s+(?:accountability|investigation|reform)\b/i,
    ],
  },
  {
    issue: 'policing', side: 'right', weight: 2,
    label: 'stronger support for law enforcement',
    patterns: [
      /\b(?:support|respect|fund) (?:the )?(?:police|cops|law enforcement)\b/i,
      /\bpolicing you respect\b/i,
      /\b(?:hire|recruit) more (?:police|officers|cops)\b/i,
      /\btougher (?:sentences|sentencing|penalties)\b/i,
    ],
  },

  // Fiscal policy and regulation
  {
    issue: 'fiscal policy', side: 'left', weight: 2,
    label: 'more progressive taxes and public investment',
    patterns: [
      /\b(?:raise|increase) taxes? on (?:the )?(?:wealthy|rich|billionaires?|corporations?)\b/i,
      /\b(?:cancel|forgive) student (?:loan )?debt\b/i,
      /\b(?:invest|spend) more in (?:public schools?|public transit|social programs?)\b/i,
    ],
  },
  {
    issue: 'fiscal policy', side: 'right', weight: 2,
    label: 'lower spending, taxes, or regulation',
    patterns: [
      /\b(?:cut|reduce) (?:government |federal )?spending\b/i,
      /\b(?:cut|lower|reduce) (?:income |corporate )?taxes?\b/i,
      /\bnational debt(?:\s+\w+){0,8}\s+(?:costs?|crisis|unsustainable|real bills)\b/i,
      /\bstudent loan forgiveness is (?:a )?(?:regressive|giveaway)\b/i,
      /\b(?:cut|reduce|simplif(?:y|ies)) (?:government )?(?:regulation|compliance|red tape)\b/i,
    ],
  },

  // Housing and the courts
  {
    issue: 'housing', side: 'left', weight: 2,
    label: 'greater housing affordability and tenant protection',
    patterns: [
      /\bhousing is a human right\b/i,
      /\b(?:rent|rents) (?:ate|takes?|consumes?) (?:half|\d+%)/i,
      /\brenters?(?:\s+\w+){0,8}\s+(?:spend|pay) (?:half|\d+%)(?:\s+\w+){0,4}\s+(?:income|paycheck)\b/i,
      /\b(?:expand|build|fund) affordable housing\b/i,
      /\btenant protections?\b/i,
      /\brent burden\b/i,
    ],
  },
  {
    issue: 'courts', side: 'left', weight: 2,
    label: 'reform the Supreme Court',
    patterns: [
      /\bsupreme court term limits?\b/i,
      /\b(?:expand|reform) (?:the )?(?:supreme court|SCOTUS)\b/i,
      /\b(?:ethics code|binding ethics rules?) for (?:the )?(?:supreme court|justices)\b/i,
    ],
  },
]

function stripQuotes(text: string): string {
  return text.replace(/["“]([^"“”]{2,600}?)["”]/g, ' ')
}

export function detectStances(text: string): StanceHit[] {
  const unquoted = stripQuotes(text.replace(/\s+/g, ' ').trim())
  const hits: StanceHit[] = []

  for (const { patterns, excludes, ...hit } of RULES) {
    if (excludes?.some((pattern) => pattern.test(unquoted))) continue
    if (!patterns.some((pattern) => pattern.test(unquoted))) continue
    hits.push(hit)
  }

  return hits
}
