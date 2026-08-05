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
  method: 'pattern' | 'compositional' | 'prototype' | 'context'
  confidence: number
  evidence: string
}

type StanceRule = Omit<StanceHit, 'method' | 'confidence' | 'evidence'> & {
  patterns: RegExp[]
  excludes?: RegExp[]
}

type CompositionalRule = Omit<StanceHit, 'method' | 'confidence' | 'evidence'> & {
  subjects: RegExp[]
  predicates: RegExp[]
  excludes?: RegExp[]
}

type ContextRule = Omit<StanceHit, 'method' | 'confidence' | 'evidence'> & {
  patterns: RegExp[]
}

import { detectSemanticStances } from './semantic-stances'

const RULES: StanceRule[] = [
  // Foreign policy and presidential war powers
  {
    issue: 'foreign policy', side: 'left', weight: 2,
    label: 'war requires congressional authorization',
    patterns: [
      /\bcongress(?:\s+\w+){0,5}\s+(?:has not|hasn't|never)\s+voted\b/i,
      /\b(?:congressional|congress)\s+(?:authorization|approval|vote)\b/i,
      /\bcongress (?:must|should|needs? to) vote\b/i,
      /\bwar powers(?:\s+(?:act|resolution|clause))?\b/i,
      /\b(?:unauthori[sz]ed|illegal|unconstitutional)\s+(?:war|strike|bombing|military action)\b/i,
      /\bconstitution(?:\s+\w+){0,12}\s+(?:war|commander[ -]in[ -]chief)\b/i,
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
      /\bdiplomacy is not weakness\b/i,
      /\bcivilian (?:deaths?|casualties)(?:\s+\w+){0,8}\s+(?:footnote|ignored|unacceptable)\b/i,
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
      /\b(?:restore|maintain) deterrence\b/i,
      /\b(?:decisive action|decisive military action)\b/i,
      /\b(?:cannot|can't) be allowed to threaten (?:U\.S\.|US|American) (?:forces|troops|allies)\b/i,
      /\bdestroy(?:ing)?(?:\s+\w+){0,5}\s+(?:military capacity|nuclear program)\b/i,
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
      /\b(?:strengthen|increase) border enforcement\b/i,
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
      /\bminimum wage[\s\S]{0,140}\brestaurants?[\s\S]{0,50}\b(?:did not|didn't|have not|haven't) (?:vanish|disappear|collapse)\b/i,
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
      /\bparents? (?:read|review)(?:\s+\w+){0,4}\s+(?:the )?curriculum(?:\s+\w+){0,8}\s+(?:more of this|transparency|sunlight)\b/i,
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
  {
    issue: 'veterans', side: 'left', weight: 1.5,
    label: 'greater public support for veterans and benefits',
    patterns: [
      /\b(?:fund|budget for|guarantee|expand)(?:\s+\w+){0,8}\s+(?:VA care|veterans? care|veterans? benefits|lifelong care)\b/i,
      /\bsupport the troops(?:\s+\w+){0,8}\s+support (?:the )?(?:paperwork|benefits|VA)\b/i,
    ],
  },
]

// Broader subject + predicate rules cover ordinary paraphrases while requiring
// the policy subject and the advocated action to occur in the same clause.
// They intentionally avoid party names and politician sentiment: disliking a
// person is not itself a policy stance.
const COMPOSITIONAL_RULES: CompositionalRule[] = [
  {
    issue: 'labor', side: 'left', weight: 2,
    label: 'stronger worker and union protections',
    subjects: [/\b(?:union|organized labor|workers?|apprenticeship|labor standards?)\b/i],
    predicates: [
      /\b(?:guarantee|protect|strengthen|require|expand|fund)(?:\s+\w+){0,7}\s+(?:union|labor|worker|apprenticeship|wage|safety)/i,
      /\b(?:union labor standards?|apprenticeship slots?|worker protections?|collective bargaining rights?)\b/i,
    ],
    excludes: [/\b(?:oppose|reject|end|ban) (?:the )?(?:union|labor|worker) (?:mandate|requirement|protection)/i],
  },
  {
    issue: 'labor', side: 'right', weight: 2,
    label: 'fewer labor mandates on employers',
    subjects: [/\b(?:union|labor|minimum wage|employers?|business(?:es)?)\b/i],
    predicates: [
      /\b(?:oppose|reject|end|reduce|limit)(?:\s+\w+){0,6}\s+(?:union|labor|wage) (?:mandates?|requirements?|rules?)/i,
      /\b(?:labor|wage|union) (?:mandates?|rules?|costs?)(?:\s+\w+){0,7}\s+(?:hurt|close|kill|burden)/i,
    ],
  },
  {
    issue: 'public health', side: 'left', weight: 2,
    label: 'greater public-health investment',
    subjects: [/\b(?:public health|pandemic|ventilation|contact tracing|county health|health coverage)\b/i],
    predicates: [
      /\b(?:fund|invest in|expand|strengthen|upgrade|protect)(?:\s+\w+){0,8}\s+(?:public health|ventilation|contact tracing|health staffing|health coverage|data sharing)/i,
      /\b(?:ventilation upgrades?|contact tracing capacity|public-health staffing|public health staffing)\b/i,
    ],
  },
  {
    issue: 'public health', side: 'right', weight: 2,
    label: 'fewer centralized health mandates',
    subjects: [/\b(?:public health|pandemic|vaccine|mask|health agenc(?:y|ies))\b/i],
    predicates: [
      /\b(?:oppose|reject|limit|end)(?:\s+\w+){0,7}\s+(?:federal |government )?(?:health|vaccine|mask) mandates?/i,
      /\b(?:return|leave)(?:\s+\w+){0,6}\s+(?:health decisions?|pandemic decisions?)(?:\s+\w+){0,4}\s+(?:states?|families|parents)/i,
    ],
  },
  {
    issue: 'technology', side: 'left', weight: 2,
    label: 'stronger technology-platform regulation',
    subjects: [/\b(?:big tech|technology companies|social media|artificial intelligence|AI|antitrust|data privacy)\b/i],
    predicates: [
      /\b(?:regulate|require|enforce|strengthen)(?:\s+\w+){0,7}\s+(?:privacy|antitrust|algorithm|platform|consumer protection)/i,
      /\bprotect(?:\s+\w+){0,4}\s+(?:data privacy|consumers?)\b/i,
      /\b(?:algorithm transparency|data privacy protections?|antitrust enforcement)\b/i,
      /\b(?:AI|algorithm) transparency requirements?(?:\s+\w+){0,12}\s+(?:light|lighter|modest|reasonable|necessary|needed)\b/i,
      /\bcompliance cost (?:worries|concerns)(?:\s+\w+){0,5}\s+(?:overstated|overblown|exaggerated)\b/i,
    ],
  },
  {
    issue: 'technology', side: 'right', weight: 2,
    label: 'fewer technology mandates and speech controls',
    subjects: [/\b(?:big tech|technology companies|social media|artificial intelligence|AI|online speech)\b/i],
    predicates: [
      /\b(?:oppose|reject|reduce|limit)(?:\s+\w+){0,7}\s+(?:technology|AI|platform|speech|innovation) (?:regulation|mandates?|controls?)/i,
      /\b(?:protect|keep)(?:\s+\w+){0,5}\s+(?:online speech|innovation)(?:\s+\w+){0,5}\s+(?:free|from government)/i,
    ],
  },
  {
    issue: 'housing', side: 'right', weight: 2,
    label: 'fewer housing and development restrictions',
    subjects: [/\b(?:housing|zoning|rent control|developers?|homebuilding)\b/i],
    predicates: [
      /\b(?:reduce|remove|relax|simplify|oppose)(?:\s+\w+){0,7}\s+(?:zoning|building|housing|rent control) (?:rules?|regulations?|restrictions?|mandates?)/i,
      /\blet(?:\s+\w+){0,5}\s+(?:developers?|builders?) build/i,
    ],
  },
  {
    issue: 'transportation', side: 'left', weight: 1.5,
    label: 'greater public-transit investment',
    subjects: [/\b(?:public transit|transit access|bus service|rail service)\b/i],
    predicates: [
      /\b(?:fund|expand|invest in|back)(?:\s+\w+){0,6}\s+(?:public transit|transit access|bus service|rail service)/i,
      /\b(?:public transit funding|transit investment)\b/i,
    ],
  },
  {
    issue: 'civil rights', side: 'right', weight: 2,
    label: 'greater religious and associational freedom',
    subjects: [/\b(?:religious liberty|religious freedom|conscience|compelled speech|free association)\b/i],
    predicates: [
      /\b(?:protect|expand|defend)(?:\s+\w+){0,5}\s+(?:religious liberty|religious freedom|conscience|free association)/i,
      /\b(?:oppose|reject|ban)(?:\s+\w+){0,5}\s+compelled speech/i,
    ],
  },
]

// Lower-weight contextual evidence captures ideology that is expressed through
// coalition approval, institutional values, and governing priorities rather
// than a textbook policy sentence. These rules must include an evaluative or
// advocative cue; merely naming a party, politician, or constituency is never
// enough. Receipts label this evidence separately from direct policy matches.
const CONTEXT_RULES: ContextRule[] = [
  {
    issue: 'political alignment', side: 'left', weight: 1.25,
    label: 'criticism of Republican political power',
    patterns: [
      /\bRepublicans?(?:\s+\w+){0,10}\s+(?:diversion|abuse|politiciz(?:e|ed|ing)|refus(?:e|ed|al)|fail(?:ed|ure)?|protecting power)\b/i,
      /\bTrump(?:\s+\w+){0,10}\s+(?:reckless|unauthori[sz]ed|unconstitutional|dangerous|wrong|abuse of power)\b/i,
    ],
  },
  {
    issue: 'political alignment', side: 'right', weight: 1.25,
    label: 'criticism of Democratic or progressive institutions',
    patterns: [
      /\bDemocrats?(?:\s+\w+){0,12}\s+(?:refus(?:e|ed|al)|dodg(?:e|ed|ing)|claiming we should believe|protecting careers?|will not answer|won't answer)\b/i,
      /\belite institutions?(?:\s+\w+){0,10}\s+(?:love certainty|cannot be trusted|can't be trusted|failed|censor|silence)\b/i,
    ],
  },
  {
    issue: 'economic power', side: 'left', weight: 1.25,
    label: 'ordinary people and workers need protection from concentrated power',
    patterns: [
      /\bdefend(?:ing)? ordinary people(?:['’]s)? rights?[\s\S]{0,100}\bpower (?:gets|is) abused\b/i,
      /\b(?:workers?|tenants?)(?:\s+\w+){0,10}\s+(?:race to the bottom|carry the cost|bear the cost|need bargaining power)\b/i,
    ],
  },
  {
    issue: 'taxpayer restraint', side: 'right', weight: 1.25,
    label: 'opposition to politicized government spending',
    patterns: [
      /\b(?:do not|don't) want (?:my|our) tax dollars funding(?:\s+\w+){0,8}\s+(?:political payback|partisan|weaponiz)/i,
      /\btax dollars?(?:\s+\w+){0,8}\s+(?:political payback|slush fund|partisan retaliation)\b/i,
    ],
  },
  {
    issue: 'education', side: 'right', weight: 1.25,
    label: 'greater parental oversight of institutions',
    patterns: [
      /\bofficials? answer to families\b/i,
      /\bparents?(?:\s+\w+){0,10}\s+(?:judge what should change|read the curriculum|demand transparency)\b/i,
      /\bphone-free schools?[\s\S]{0,120}\b(?:works?|test scores? up|fights? down|paternalists? are right)\b/i,
    ],
  },
  {
    issue: 'public safety', side: 'right', weight: 1.1,
    label: 'victim protection and swift enforcement',
    patterns: [
      /\bprotect victims?[\s\S]{0,100}\b(?:leadership decides fast|decide fast|immediate consequences)\b/i,
      /\bmisconduct(?:\s+\w+){0,8}\s+(?:consequences|protect victims|witnesses unpressured)\b/i,
    ],
  },
  {
    issue: 'energy', side: 'right', weight: 1.25,
    label: 'domestic production, jobs, and energy reliability',
    patterns: [
      /\benergy (?:workers?|jobs?)(?:\s+\w+){0,14}\s+(?:domestic production|reliability|energy security)\b/i,
      /\breliability beats rhetoric(?:\s+\w+){0,12}\s+domestic production\b/i,
      /\bjobs? tied to domestic production\b/i,
    ],
  },
  {
    issue: 'climate', side: 'left', weight: 1.25,
    label: 'public investment in climate resilience and transition',
    patterns: [
      /\bfire management budgets?(?:\s+\w+){0,8}\s+(?:actual|real) lever\b/i,
      /\benergy transition(?:\s+\w+){0,14}\s+(?:policy failure|needs? public investment|requires? grid investment)\b/i,
      /\bclimate(?:\s+\w+){0,12}\s+(?:public health|respiratory admissions?|fund prevention)\b/i,
      /\bgrid interconnection queues?[\s\S]{0,160}\b(?:energy transition|policy failure)\b/i,
      /\b(?:wildfire smoke|smoke-alert|smoke alert)[\s\S]{0,140}\brespiratory admissions?\b/i,
    ],
  },
  {
    issue: 'voting', side: 'left', weight: 1.1,
    label: 'skepticism of unsupported election-fraud claims',
    patterns: [
      /\belection fraud(?:\s+\w+){0,10}\s+(?:filings?|claims?|cases?)[\s\S]{0,100}\b(?:dismissed|no evidence|unsupported)\b/i,
    ],
  },
  {
    issue: 'drug enforcement', side: 'left', weight: 1.1,
    label: 'evidence-led enforcement at legal ports of entry',
    patterns: [
      /\bfentanyl(?:\s+\w+){0,12}\s+legal ports? of entry[\s\S]{0,120}\bfund (?:the )?scanners?\b/i,
    ],
  },
  {
    issue: 'fiscal policy', side: 'right', weight: 1.1,
    label: 'concern about entitlement solvency',
    patterns: [
      /\bSocial Security(?:\s+\w+){0,10}\s+trust fund cliff[\s\S]{0,120}\bmath (?:does not|doesn't) care\b/i,
    ],
  },
  {
    issue: 'agriculture', side: 'right', weight: 1.1,
    label: 'rural-cost skepticism of farm subsidies',
    patterns: [
      /\bfarm bill[\s\S]{0,120}\bsubsidies[\s\S]{0,120}\binput costs? (?:doubled|rose|increased)\b/i,
    ],
  },
]

function stripQuotes(text: string): string {
  return text.replace(/["“]([^"“”]{2,600}?)["”]/g, ' ')
}

const EXPLICIT_NO_POSITION = /\b(?:I|we) (?:have not|haven't|do not|don't) (?:taken|take|have) (?:a |any )?position\b/i
const OPPOSITION_BEFORE = /\b(?:oppose|reject|against|do not support|don't support|cannot support|can't support)\b/i
const INDIRECT_ATTRIBUTION = /\b(?:said|says|reported|according to|argued|claims?|called for|wants? to|proposed|announced)\b/i
const AUTHORIAL_CUE = /\b(?:I|we|our|should|must|need to|support|oppose|reject)\b/i

function beforeMatch(value: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0
  const clauseStart = Math.max(
    value.lastIndexOf('.', index - 1),
    value.lastIndexOf('?', index - 1),
    value.lastIndexOf('!', index - 1),
    value.lastIndexOf(';', index - 1)
  )
  return value.slice(clauseStart + 1, index)
}

function rejectedOrAttributed(value: string, match: RegExpMatchArray): boolean {
  const prefix = beforeMatch(value, match)
  if (OPPOSITION_BEFORE.test(prefix)) return true
  return INDIRECT_ATTRIBUTION.test(prefix) && !AUTHORIAL_CUE.test(prefix)
}

function snippet(value: string, match: RegExpMatchArray | null): string {
  if (!match || match.index == null) return value.slice(0, 150).trim()
  const start = Math.max(0, match.index - 45)
  const end = Math.min(value.length, match.index + match[0].length + 65)
  const compact = value.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${compact}${end < value.length ? '…' : ''}`
}

function uniqueHits(hits: StanceHit[]): StanceHit[] {
  const priority = { pattern: 4, compositional: 3, prototype: 2, context: 1 }
  const byPosition = new Map<string, StanceHit>()
  for (const hit of hits) {
    const key = `${hit.issue}:${hit.side}`
    const current = byPosition.get(key)
    if (!current || priority[hit.method] > priority[current.method] || hit.confidence > current.confidence) {
      byPosition.set(key, hit)
    }
  }
  return [...byPosition.values()]
}

export function detectStances(text: string): StanceHit[] {
  const unquoted = stripQuotes(text.replace(/\s+/g, ' ').trim())
  if (EXPLICIT_NO_POSITION.test(unquoted)) return []
  const hits: StanceHit[] = []

  for (const { patterns, excludes, ...base } of RULES) {
    if (excludes?.some((pattern) => pattern.test(unquoted))) continue
    const match = patterns.map((pattern) => unquoted.match(pattern)).find(Boolean) ?? null
    if (!match) continue
    if (rejectedOrAttributed(unquoted, match)) continue
    hits.push({
      ...base,
      method: 'pattern',
      confidence: 0.96,
      evidence: snippet(unquoted, match),
    })
  }

  const clauses = unquoted.split(/(?<=[.!?;])\s+|\s+[—–-]\s+/).filter(Boolean)
  for (const { subjects, predicates, excludes, ...base } of COMPOSITIONAL_RULES) {
    let matched: { clause: string; predicate: RegExpMatchArray } | null = null
    for (const clause of clauses) {
      if (!subjects.some((subject) => subject.test(clause))) continue
      if (excludes?.some((exclude) => exclude.test(clause))) continue
      const predicate = predicates.map((pattern) => clause.match(pattern)).find(Boolean) ?? null
      if (!predicate || rejectedOrAttributed(clause, predicate)) continue
      matched = { clause, predicate }
      break
    }
    if (!matched) continue
    hits.push({
      ...base,
      method: 'compositional',
      confidence: 0.88,
      evidence: snippet(matched.clause, matched.predicate),
    })
  }

  for (const { patterns, ...base } of CONTEXT_RULES) {
    const match = patterns.map((pattern) => unquoted.match(pattern)).find(Boolean) ?? null
    if (!match || rejectedOrAttributed(unquoted, match)) continue
    hits.push({
      ...base,
      method: 'context',
      confidence: 0.74,
      evidence: snippet(unquoted, match),
    })
  }

  hits.push(...detectSemanticStances(unquoted))
  return uniqueHits(hits)
}
