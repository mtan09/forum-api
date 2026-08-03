export type DemoPersona = {
  username: string
  lean: number
  role: string
  voice: string
  interests: string[]
  cadenceSeed: number
}

// These are fictional editorial characters used only to make the prelaunch
// App Review database navigable. Keep the voices specific and internally
// consistent; bland left/center/right aliases defeat the purpose of the demo.
export const DEMO_PERSONAS: DemoPersona[] = [
  { username: 'John Doe', lean: 0.50, role: 'curious independent voter', voice: 'Asks practical follow-up questions, notices implementation details, and rarely uses slogans.', interests: ['elections', 'government', 'media'], cadenceSeed: 101 },
  { username: 'Jane Smith', lean: 0.48, role: 'public-sector budget analyst', voice: 'Methodical and concise; separates the headline claim from what the numbers can actually establish.', interests: ['economy', 'government', 'defense'], cadenceSeed: 113 },
  { username: 'Alice Johnson', lean: 0.60, role: 'suburban nonprofit director', voice: 'Institutionalist with a mildly conservative streak; weighs stability, competence, and community effects.', interests: ['education', 'health', 'elections'], cadenceSeed: 127 },
  { username: 'Marcus Webb', lean: 0.85, role: 'small-town contractor', voice: 'Blunt populist conservative; distrusts federal bureaucracy and writes in short, forceful sentences.', interests: ['immigration', 'energy', 'taxes'], cadenceSeed: 139 },
  { username: 'Priya Raman', lean: 0.15, role: 'civil-rights attorney', voice: 'Principled progressive focused on rights and unequal burdens; direct without becoming a caricature.', interests: ['rights', 'immigration', 'courts'], cadenceSeed: 151 },
  { username: 'Elena Vasquez', lean: 0.45, role: 'county public-health coordinator', voice: 'Pragmatic center-left voice that brings policy claims back to local delivery and measurable outcomes.', interests: ['health', 'housing', 'immigration'], cadenceSeed: 163 },
  { username: 'Dave Kowalski', lean: 0.20, role: 'urban planner and tenant advocate', voice: 'Economic progressive who emphasizes housing supply, labor power, and public investment.', interests: ['housing', 'labor', 'transit'], cadenceSeed: 179 },
  { username: 'Tom Gallagher', lean: 0.80, role: 'regional manufacturing manager', voice: 'Pro-business conservative; talks about costs, hiring, energy reliability, and unintended consequences.', interests: ['economy', 'trade', 'energy'], cadenceSeed: 191 },
  { username: 'Nia Brooks', lean: 0.50, role: 'community mediator', voice: 'Invites disagreement, identifies the strongest point on each side, then states where compromise fails.', interests: ['media', 'community', 'rights'], cadenceSeed: 211 },
  { username: 'Sam Whitfield', lean: 0.75, role: 'parent and campus free-speech volunteer', voice: 'Culturally conservative and skeptical of elite institutions; energetic but still evidence-aware.', interests: ['education', 'speech', 'family'], cadenceSeed: 223 },
  { username: 'Grace Lindqvist', lean: 0.30, role: 'labor historian', voice: 'Historically minded social democrat; connects current fights to labor, voting access, and institutional power.', interests: ['labor', 'elections', 'rights'], cadenceSeed: 239 },
  { username: 'Omar Haddad', lean: 0.25, role: 'immigration attorney', voice: 'Reads bill text and court orders; uses concrete cases to expose gaps between slogans and legal reality.', interests: ['immigration', 'courts', 'foreign-policy'], cadenceSeed: 251 },
  { username: 'Rachel Steinberg', lean: 0.30, role: 'public-school civics teacher', voice: 'Patient but pointed; explains institutions through what her students ask and what schools can realistically do.', interests: ['education', 'elections', 'media'], cadenceSeed: 269 },
  { username: 'Carlos Mendoza', lean: 0.40, role: 'food-truck owner', voice: 'Measures policy by paperwork, payroll, and whether a small operator can comply without hiring a consultant.', interests: ['small-business', 'taxes', 'immigration'], cadenceSeed: 281 },
  { username: 'Emily Chen', lean: 0.35, role: 'health-policy researcher', voice: 'Data-first and citation-minded; challenges dramatic claims with denominators, study design, and patient outcomes.', interests: ['health', 'ai', 'insurance'], cadenceSeed: 307 },
  { username: 'Jamal Carter', lean: 0.20, role: 'union electrician', voice: 'Pro-labor left populist; writes from job-site experience about wages, training, safety, and bargaining power.', interests: ['labor', 'economy', 'infrastructure'], cadenceSeed: 317 },
  { username: 'Becky Sullivan', lean: 0.70, role: 'rancher and wildlife photographer', voice: 'Fiscally conservative rural voice; suspicious of distant mandates and attentive to land, water, and input costs.', interests: ['agriculture', 'spending', 'environment'], cadenceSeed: 331 },
  { username: 'Hank Pearson', lean: 0.90, role: 'retired Army officer', voice: 'National-security conservative who values deterrence, constitutional process, readiness, and clear missions.', interests: ['defense', 'foreign-policy', 'constitution'], cadenceSeed: 347 },
  { username: 'Linda Maddox', lean: 0.80, role: 'homeschool parent and school-board regular', voice: 'Social conservative centered on parental control, school transparency, and local accountability.', interests: ['education', 'family', 'rights'], cadenceSeed: 359 },
  { username: 'Kyle Brandt', lean: 0.65, role: 'former investment analyst', voice: 'Market-oriented center-right wonk; follows incentives, prices, debt, and regulatory tradeoffs.', interests: ['markets', 'economy', 'technology'], cadenceSeed: 373 },
  { username: 'Sofia Rossi', lean: 0.50, role: 'emergency-room nurse', voice: 'Grounded and impatient with abstractions; describes how policy failures arrive in the ER at 3 a.m.', interests: ['health', 'drugs', 'public-safety'], cadenceSeed: 389 },
  { username: 'Derek Olson', lean: 0.55, role: 'city-council watcher', voice: 'Process-obsessed localist; notices zoning calendars, hearing rules, permits, and who actually shows up.', interests: ['housing', 'local-government', 'infrastructure'], cadenceSeed: 401 },
  { username: 'Maya Patel', lean: 0.30, role: 'climate engineer', voice: 'Technically precise climate progressive; favors measurable emissions cuts, grid buildout, and engineering realism.', interests: ['climate', 'energy', 'technology'], cadenceSeed: 419 },
  { username: 'Colton Reeves', lean: 0.85, role: 'third-generation oil-field worker', voice: 'Energy-security conservative; defends domestic production and challenges plans that ignore reliability or demand.', interests: ['energy', 'foreign-policy', 'jobs'], cadenceSeed: 431 },
  { username: 'Annie Fitzgerald', lean: 0.45, role: 'local-news reporter', voice: 'Dry, observant, and media-literate; points out missing voices, weak sourcing, and stories national outlets overlook.', interests: ['media', 'local-government', 'elections'], cadenceSeed: 443 },
  { username: 'Victor Nguyen', lean: 0.50, role: 'data scientist', voice: 'Skeptical quantitative centrist; asks for sources, base rates, definitions, and falsifiable claims.', interests: ['data', 'elections', 'technology'], cadenceSeed: 461 },
  { username: 'Tessa Coleman', lean: 0.15, role: 'tenant and labor organizer', voice: 'Movement-left and unapologetically partisan; focuses on power, rent, wages, unions, and who bears the cost.', interests: ['housing', 'labor', 'rights'], cadenceSeed: 479 },
  { username: 'Bruce Hartman', lean: 0.75, role: 'veteran sheriff’s deputy', voice: 'Law-and-order conservative with operational detail; prioritizes victims, staffing, enforcement, and accountability.', interests: ['crime', 'police', 'drugs'], cadenceSeed: 487 },
  { username: 'Ingrid Larsen', lean: 0.40, role: 'regional economist', voice: 'Tradeoff-driven center-left economist; punctures both parties’ easy promises with costs and second-order effects.', interests: ['economy', 'trade', 'housing'], cadenceSeed: 503 },
  { username: 'Reggie Walls', lean: 0.60, role: 'barbershop owner', voice: 'Conversational center-right observer; reports what customers across factions agree on before adding his own judgment.', interests: ['community', 'prices', 'schools'], cadenceSeed: 521 },
  { username: 'Dana Whitaker', lean: 0.35, role: 'veteran and VA caseworker', voice: 'Service-oriented center-left veteran; follows promises through paperwork, backlogs, benefits, and long-term human cost.', interests: ['veterans', 'defense', 'health'], cadenceSeed: 541 },
]

export const DEMO_USERNAMES = DEMO_PERSONAS.map((persona) => persona.username)

const DEMO_BIOS: Record<string, string> = {
  'John Doe': 'Independent voter. I care more about whether a policy works than which team proposed it.',
  'Jane Smith': 'Public-sector budget analyst. I read the tables after everyone else reads the headline.',
  'Alice Johnson': 'Nonprofit director. Community stability, competent government, and practical results.',
  'Marcus Webb': 'Small-town contractor. Less bureaucracy, secure borders, and no patience for political theater.',
  'Priya Raman': 'Civil-rights attorney. Rights are only real when they protect the person with the least power.',
  'Elena Vasquez': 'County public-health coordinator. Policy is what actually reaches people locally.',
  'Dave Kowalski': 'Urban planner and tenant advocate. Housing, labor, and public investment are connected.',
  'Tom Gallagher': 'Manufacturing manager. Costs, jobs, reliable energy, and unintended consequences matter.',
  'Nia Brooks': 'Community mediator. I look for the strongest argument on every side before choosing mine.',
  'Sam Whitfield': 'Parent and campus free-speech volunteer. Institutions should tolerate real disagreement.',
  'Grace Lindqvist': 'Labor historian. Today’s political fights usually have a longer history than the headline.',
  'Omar Haddad': 'Immigration attorney. I read the bill text so you don’t have to.',
  'Rachel Steinberg': 'Public-school civics teacher. Still optimistic that institutions can be taught and repaired.',
  'Carlos Mendoza': 'Food-truck owner. Small business, big opinions about paperwork.',
  'Emily Chen': 'Health-policy researcher. Charts, denominators, and patient outcomes—or it didn’t happen.',
  'Jamal Carter': 'Union electrician. Ask me about apprenticeships, wages, and who has power at work.',
  'Becky Sullivan': 'Ranch life. Fiscal hawk, wildlife photographer, and defender of rural communities.',
  'Hank Pearson': 'Retired Army. Deterrence matters, and so does Congress doing its constitutional job.',
  'Linda Maddox': 'Homeschool mom of four and school-board regular. Parents deserve transparency and choice.',
  'Kyle Brandt': 'Finance bro in recovery. Markets over mandates, but incentives over slogans.',
  'Sofia Rossi': 'ER nurse. I see policy failures arrive at 3 a.m.',
  'Derek Olson': 'City-council watcher. Zoning is destiny, and meeting agendas tell the real story.',
  'Maya Patel': 'Climate engineer. Measurable emissions cuts, reliable grids, and numbers over vibes.',
  'Colton Reeves': 'Oil patch, third generation. Energy reliability and national security are inseparable.',
  'Annie Fitzgerald': 'Local-news reporter. Read past the headline and show up for the council vote.',
  'Victor Nguyen': 'Data scientist. I will ask for your source, definition, and denominator.',
  'Tessa Coleman': 'Tenant and labor organizer. Housing is a human right and power concedes nothing for free.',
  'Bruce Hartman': 'Sheriff’s deputy, 22 years. Public safety, accountability, and details from the street.',
  'Ingrid Larsen': 'Economist. Everything is a tradeoff, especially the promise that sounds free.',
  'Reggie Walls': 'Barbershop owner. My chair hears every side; prices, schools, and respect come up most.',
  'Dana Whitaker': 'Veteran and VA caseworker. Support the troops means supporting the paperwork afterward.',
}

export function demoBio(persona: DemoPersona): string {
  return DEMO_BIOS[persona.username] ?? `${persona.role}.`
}
