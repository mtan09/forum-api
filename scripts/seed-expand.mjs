import { readFileSync } from 'node:fs'

// Second community wave: 20 more users (31 total), more posts, deeper
// threads, and interactions everywhere the app has them — post/article/
// comment votes, bookmarks, and debate pins + threads on The Floor.
// Every user has a persona lean (0=left..1=right) that drives how they
// vote and where they pin, so the aggregate data looks lived-in instead
// of random. All via the real API; idempotent like seed-community.
//
// Usage: node scripts/seed-expand.mjs   (server must be running)

const API = process.env.API_URL || 'http://localhost:3000'
const PASSWORD = 'password123'
const STANCE_POSTS = JSON.parse(
  readFileSync(new URL('./stance-posts.json', import.meta.url), 'utf8')
)

// Original 11 (login only) with inferred persona leans, then 20 new.
const USERS = [
  { username: 'John Doe',        email: 'john@example.dev',    lean: 0.50, avatar: 'https://randomuser.me/api/portraits/men/32.jpg' },
  { username: 'Jane Smith',      email: 'jane@example.dev',    lean: 0.50, avatar: 'https://randomuser.me/api/portraits/women/44.jpg' },
  { username: 'Alice Johnson',   email: 'alice@example.dev',   lean: 0.60, avatar: 'https://randomuser.me/api/portraits/women/68.jpg' },
  { username: 'Marcus Webb',     email: 'marcus@example.dev',  lean: 0.85, avatar: 'https://randomuser.me/api/portraits/men/75.jpg' },
  { username: 'Priya Raman',     email: 'priya@example.dev',   lean: 0.15, avatar: 'https://randomuser.me/api/portraits/women/21.jpg' },
  { username: 'Elena Vasquez',   email: 'elena@example.dev',   lean: 0.45, avatar: 'https://randomuser.me/api/portraits/women/57.jpg' },
  { username: 'Dave Kowalski',   email: 'dave@example.dev',    lean: 0.20, avatar: 'https://randomuser.me/api/portraits/men/11.jpg' },
  { username: 'Tom Gallagher',   email: 'tom@example.dev',     lean: 0.80, avatar: 'https://randomuser.me/api/portraits/men/29.jpg' },
  { username: 'Nia Brooks',      email: 'nia@example.dev',     lean: 0.50, avatar: 'https://randomuser.me/api/portraits/women/12.jpg' },
  { username: 'Sam Whitfield',   email: 'sam@example.dev',     lean: 0.75, avatar: 'https://randomuser.me/api/portraits/men/52.jpg' },
  { username: 'Grace Lindqvist', email: 'grace@example.dev',   lean: 0.30, avatar: 'https://randomuser.me/api/portraits/women/33.jpg' },
  // --- new wave ---
  { username: 'Omar Haddad',     email: 'omar@example.dev',    lean: 0.25, avatar: 'https://randomuser.me/api/portraits/men/64.jpg',
    bio: 'Immigration attorney. I read the bill text so you don’t have to.' },
  { username: 'Rachel Steinberg',email: 'rachel@example.dev',  lean: 0.30, avatar: 'https://randomuser.me/api/portraits/women/79.jpg',
    bio: 'Public school teacher, chronic optimist about civics.' },
  { username: 'Carlos Mendoza',  email: 'carlos@example.dev',  lean: 0.40, avatar: 'https://randomuser.me/api/portraits/men/41.jpg',
    bio: 'Small business, big opinions about paperwork.' },
  { username: 'Emily Chen',      email: 'emilyc@example.dev',  lean: 0.35, avatar: 'https://randomuser.me/api/portraits/women/90.jpg',
    bio: 'Health policy researcher. Charts or it didn’t happen.' },
  { username: 'Jamal Carter',    email: 'jamal@example.dev',   lean: 0.20, avatar: 'https://randomuser.me/api/portraits/men/83.jpg',
    bio: 'Union electrician. Ask me about apprenticeships.' },
  { username: 'Becky Sullivan',  email: 'becky@example.dev',   lean: 0.70, avatar: 'https://randomuser.me/api/portraits/women/50.jpg',
    bio: 'Ranch life. Fiscal hawk, wildlife photographer.' },
  { username: 'Hank Pearson',    email: 'hank@example.dev',    lean: 0.90, avatar: 'https://randomuser.me/api/portraits/men/22.jpg',
    bio: 'Retired Army. Constitution first, everything else second.' },
  { username: 'Linda Maddox',    email: 'linda@example.dev',   lean: 0.80, avatar: 'https://randomuser.me/api/portraits/women/17.jpg',
    bio: 'Homeschool mom of four. School board regular.' },
  { username: 'Kyle Brandt',     email: 'kyle@example.dev',    lean: 0.65, avatar: 'https://randomuser.me/api/portraits/men/90.jpg',
    bio: 'Finance bro in recovery. Markets over mandates.' },
  { username: 'Sofia Rossi',     email: 'sofia@example.dev',   lean: 0.50, avatar: 'https://randomuser.me/api/portraits/women/65.jpg',
    bio: 'ER nurse. I see the policy failures at 3am.' },
  { username: 'Derek Olson',     email: 'derek@example.dev',   lean: 0.55, avatar: 'https://randomuser.me/api/portraits/men/36.jpg',
    bio: 'City council watcher. Zoning is destiny.' },
  { username: 'Maya Patel',      email: 'maya@example.dev',    lean: 0.30, avatar: 'https://randomuser.me/api/portraits/women/26.jpg',
    bio: 'Climate engineer. Numbers, not vibes.' },
  { username: 'Colton Reeves',   email: 'colton@example.dev',  lean: 0.85, avatar: 'https://randomuser.me/api/portraits/men/57.jpg',
    bio: 'Oil patch, third generation. Energy realism.' },
  { username: 'Annie Fitzgerald',email: 'annie@example.dev',   lean: 0.45, avatar: 'https://randomuser.me/api/portraits/women/38.jpg',
    bio: 'Local news reporter. Read past the headline.' },
  { username: 'Victor Nguyen',   email: 'victor@example.dev',  lean: 0.50, avatar: 'https://randomuser.me/api/portraits/men/46.jpg',
    bio: 'Data scientist. Will ask for your source.' },
  { username: 'Tessa Coleman',   email: 'tessa@example.dev',   lean: 0.15, avatar: 'https://randomuser.me/api/portraits/women/8.jpg',
    bio: 'Organizer. Housing is a human right.' },
  { username: 'Bruce Hartman',   email: 'bruce@example.dev',   lean: 0.75, avatar: 'https://randomuser.me/api/portraits/men/14.jpg',
    bio: 'Sheriff’s deputy, 22 years. Back the blue.' },
  { username: 'Ingrid Larsen',   email: 'ingrid@example.dev',  lean: 0.40, avatar: 'https://randomuser.me/api/portraits/women/71.jpg',
    bio: 'Economist. Everything is a tradeoff.' },
  { username: 'Reggie Walls',    email: 'reggie@example.dev',  lean: 0.60, avatar: 'https://randomuser.me/api/portraits/men/70.jpg',
    bio: 'Barbershop owner. My chair hears every side.' },
  { username: 'Dana Whitaker',   email: 'dana@example.dev',    lean: 0.35, avatar: 'https://randomuser.me/api/portraits/women/55.jpg',
    bio: 'Veteran, now VA caseworker. Bureaucracy whisperer.' },
]

// user = index into USERS
const POSTS = [
  { user: 11, hashtags: ['immigration', 'courts'],
    content: 'Immigration court backlog just passed 3 million cases. Average wait: four years. You can be for or against any policy, but a system this slow serves nobody.' },
  { user: 12, hashtags: ['education', 'civics'],
    content: 'My students can name every influencer feud but not their own governor. Civics education collapsed a generation ago and we are living in the results.' },
  { user: 13, hashtags: ['smallbusiness', 'regulation'],
    content: 'Filed my quarterly taxes in three states this week for one food truck. Whoever simplifies compliance for small operators gets my vote, red or blue.' },
  { user: 14, hashtags: ['healthcare', 'insurance'],
    content: 'New study: prior authorization delays care for 94% of physicians surveyed. This is not a left-right issue, it is an everyone-with-a-body issue.' },
  { user: 15, hashtags: ['labor', 'trades'],
    content: 'We cannot find apprentices because every kid was told college or bust. The trades pay six figures now. The stigma is the labor shortage.' },
  { user: 16, hashtags: ['spending', 'agriculture'],
    content: 'City folks discover the farm bill once every five years, get outraged about subsidies, then forget. Meanwhile input costs doubled. Walk a season in our boots.' },
  { user: 17, hashtags: ['military', 'iran'],
    content: 'Two soldiers dead in Jordan. Congress has not voted on any of this. War powers exist for a reason — where is the authorization debate?' },
  { user: 18, hashtags: ['education', 'parentalrights'],
    content: 'School board meeting ran five hours last night because parents read the curriculum for once. More of this, everywhere, always. Sunlight works.' },
  { user: 19, hashtags: ['economy', 'markets'],
    content: 'The market shrugged off the Iran escalation in a day. Either investors know something the headlines do not, or nobody is pricing tail risk anymore.' },
  { user: 20, hashtags: ['healthcare', 'er'],
    content: 'Worked the ER through another smoke-alert weekend. Respiratory admissions triple and the political fight is about whose fault the smoke is. Patients do not care whose fault it is.' },
  { user: 21, hashtags: ['housing', 'zoning'],
    content: 'Our council approved 40 units of housing after two years of hearings. A data center got approved in three weeks. Tells you everything about who zoning actually serves.' },
  { user: 22, hashtags: ['climate', 'wildfires'],
    content: 'Wildfire smoke does not check passports. Tariffs on Canada over smoke is theater — fire management budgets on BOTH sides of the border are the actual lever.' },
  { user: 23, hashtags: ['energy', 'oil'],
    content: 'Everyone hates oil until the price spikes during a war. We are one refinery outage from $6 gas and the strategic reserve is at a 40-year low. Energy security IS national security.' },
  { user: 24, hashtags: ['media', 'localnews'],
    content: 'Covered a city council vote that affects 200,000 people. Twelve views. My tweet about a pothole got 40k. We get the news ecosystem we click on.' },
  { user: 25, hashtags: ['elections', 'data'],
    content: 'Looked at the actual election fraud filings from the speech last night. 3 of the 14 cited cases were already dismissed. Primary sources matter, folks.' },
  { user: 26, hashtags: ['housing', 'renters'],
    content: 'A quarter of renters in this city spend HALF their income on rent. When people say the economy is good, ask them who it is good for.' },
  { user: 27, hashtags: ['crime', 'police'],
    content: '22 years on the job. Recruiting is at rock bottom because every applicant watched five years of cops-are-the-enemy coverage. You get the policing you respect.' },
  { user: 28, hashtags: ['economy', 'tariffs'],
    content: 'Tariffs are taxes on your own consumers. That was true when the left said it about steel and it is true now with Canada. An economist is someone both parties ignore.' },
  { user: 29, hashtags: ['community', 'dialogue'],
    content: 'Twenty years cutting hair: Democrats and Republicans in my chair complain about the same three things — prices, schools, and feeling unheard. The parties need us divided more than we need to be.' },
  { user: 30, hashtags: ['veterans', 'va'],
    content: 'Processed 40 VA claims this month. The backlog is not a scandal that trends, it is a scandal that grinds. Support the troops should mean support the paperwork.' },
  { user: 17, hashtags: ['borders', 'sovereignty'],
    content: 'A country that cannot control its borders is not a country. Every nation on earth enforces theirs. Only here is it controversial to say so.' },
  { user: 15, hashtags: ['minimumwage', 'labor'],
    content: 'The $25 minimum wage bill is DOA but the conversation moved. Ten years ago $15 was radical. The floor rises because people push, not because employers volunteer.' },
  { user: 23, hashtags: ['climate', 'nuclear'],
    content: 'You want to beat oil? Out-build it. Permit nuclear in 2 years instead of 12 and I will personally celebrate. Strangling supply while demand grows just exports the drilling.' },
  { user: 14, hashtags: ['ai', 'healthcare'],
    content: 'AI reading radiology scans outperformed the average human panel in the new trial. The interesting policy question is not IF we use it, but who is liable when it misses.' },
  { user: 25, hashtags: ['elections', 'turnout'],
    content: 'Unpopular data point: strict voter ID states and loose ones have nearly identical turnout once you control for demographics. Both parties are fighting over a rounding error.' },
  { user: 11, hashtags: ['daca', 'immigration'],
    content: 'Client update: brought here at 2, honor roll, EMT at 24, still no path to anything permanent. Tell me what policy goal her limbo serves. I will wait.' },
  { user: 18, hashtags: ['tech', 'kids'],
    content: 'Phone-free school pilot in our district: test scores up, fights down, kids report LIKING it. Sometimes the paternalists are just right.' },
  { user: 26, hashtags: ['unions', 'organizing'],
    content: 'The warehouse vote failed by 43 ballots out of 6,000 after mandatory anti-union meetings every shift for a month. Call it what you want, I call it a rigged conversation.' },
  { user: 16, hashtags: ['water', 'west'],
    content: 'The Colorado River compact math has never added up and now the reservoirs are proving it. Seven states, one river, zero honest budgets. This is THE western issue.' },
  { user: 19, hashtags: ['crypto', 'regulation'],
    content: 'The stablecoin bill quietly moving through committee matters more than 90% of what trends here. Payments infrastructure is politics wearing a boring costume.' },
  { user: 27, hashtags: ['fentanyl', 'border'],
    content: 'Fentanyl seizures at legal ports of entry dwarf what comes between them. If you care about the actual drug flow, fund the scanners. Boring answers save lives.' },
  { user: 22, hashtags: ['insurance', 'climate'],
    content: 'State Farm just non-renewed half my town. Climate risk is hitting your insurance bill years before it hits your ideology. The market is done debating.' },
  // Major live stories need enough genuinely different community positions
  // for search, summaries, and spectrum placement to feel representative.
  // Keep these after the indexed comment fixtures above so their references
  // remain stable.
  { user: 15, hashtags: ['iran', 'warpowers', 'congress'],
    content: 'The Iran war has no congressional authorization and no credible end state. Opposing an unauthorized Trump war is not isolationism; it is Congress doing the constitutional job it keeps surrendering.' },
  { user: 17, hashtags: ['iran', 'warpowers', 'constitution'],
    content: 'I want Iran deterred, but the Constitution does not contain a commander-in-chief exception for politically convenient wars. Congress must vote on this Iran war before another service member is sent into it.' },
  { user: 23, hashtags: ['iran', 'security', 'military'],
    content: 'Half-measures in the Iran war will cost more lives than decisive action. If the mission is to destroy the regime’s military capacity, say so, fund it, and finish it instead of managing escalation by press release.' },
  { user: 11, hashtags: ['iran', 'civilians', 'diplomacy'],
    content: 'Coverage of the Iran war keeps treating civilian deaths as a footnote to strategy. Diplomacy is not weakness when ordinary Iranian families are paying for decisions made by leaders in Tehran and Washington.' },
  { user: 25, hashtags: ['iran', 'evidence', 'foreignpolicy'],
    content: 'Before choosing a side on the Iran war, I want three facts the administration still has not supplied: the legal authority, the measurable objective, and the condition that ends U.S. involvement.' },
  { user: 3, hashtags: ['iran', 'trump', 'nationaldefense'],
    content: 'Trump is right that Iran cannot be allowed to threaten U.S. forces and allies without consequences. The Iran war should be judged by whether it restores deterrence, not by reflexive opposition to any use of American power.' },
  { user: 30, hashtags: ['iran', 'veterans', 'warcosts'],
    content: 'Every Iran war briefing talks about targets and timelines; almost none discuss the veterans the campaign will create. If Congress will not budget for lifelong care now, it has no business authorizing another open-ended war.' },
  ...STANCE_POSTS.map((post) => ({
    ...post,
    user: USERS.findIndex((user) => user.username === post.username),
  })),
]

// [postIndex (into POSTS above), userIndex, content]
const COMMENTS = [
  [0, 27, 'Fund the courts AND the enforcement. The backlog is amnesty by paperwork and everyone in the system knows it.'],
  [0, 4, 'Four years of limbo is also four years of exploitation risk. Slow systems hurt the rule-followers most.'],
  [1, 18, 'Civics died when it became safer for teachers to skip it than risk a complaint. Bring it back, arguments and all.'],
  [1, 8, 'Media literacy is the missing half. Naming your governor matters less than spotting a doctored clip.'],
  [2, 28, 'Three states for one truck is the case study every compliance-reform hearing needs to open with.'],
  [3, 20, 'Prior auth denials get reversed on appeal most of the time — which proves the first denial was never medical.'],
  [3, 7, 'My back surgery: approved, scheduled, then un-approved the week of. Nobody defends this system on the merits.'],
  [4, 12, 'We started a trades track at our school and the waitlist filled in a day. The demand is there, the counselors are behind.'],
  [5, 25, 'Subsidy data is public — the top 10% of farms take 78% of payments. Family farms are the brochure, not the recipient.'],
  [6, 3, 'Finally someone said it. Congress ducks every war vote because accountability is the one thing they all fear.'],
  [6, 4, 'The authorization from 2001 is old enough to enlist. That is the whole argument in one sentence.'],
  [7, 12, 'Five-hour meetings are democracy working as designed. The empty-room votes are the scary ones.'],
  [9, 22, 'The respiratory data from smoke weeks is going to reshape air quality standards more than any climate bill.'],
  [10, 26, 'The data center comparison should be a campaign ad. Money moves the queue, people wait in it.'],
  [11, 23, 'Forest management IS the common ground here. Both countries underfund it, both blame each other.'],
  [12, 4, 'Strategic reserve at 40-year lows while exporting record crude is a policy choice nobody wants to own.'],
  [13, 29, 'Local news dying is upstream of half the polarization everyone complains about. Subscribe to something local.'],
  [14, 3, 'Three dismissed cases means eleven live ones. The dismissals are not the exoneration you think.'],
  [14, 24, 'I read the filings too — the eleven "live" ones include two duplicates and four with no named defendant. Primary sources indeed.'],
  [15, 28, 'Rent burden stats always skip that new construction fell off a cliff in exactly those cities. Supply is the story.'],
  [16, 6, 'Respect is earned by accountability. The recruiting crisis followed the accountability crisis, not the coverage.'],
  [17, 9, 'Consumers pay tariffs, but they also pay for hollowed-out industrial towns. The ledger has two sides.'],
  [18, 0, 'The barbershop consensus is more representative than any poll I have seen this cycle.'],
  [19, 17, 'The VA backlog outlasted four administrations of both parties. Structural problems need structural fixes, not slogans.'],
  [20, 11, 'Every country enforces borders. Most also have functioning legal pathways — that half of the sentence keeps getting dropped.'],
  [21, 16, 'Labor costs are a third of my margin. The floor rising is real money — just say who pays it instead of pretending nobody does.'],
  [22, 22, 'Two-year nuclear permitting with real safety review is the deal to make. Watch both fringes reject it.'],
  [23, 14, 'Liability is everything. The scan AI is fine until the 0.1% miss, and then whose malpractice policy answers?'],
  [24, 7, 'If it is a rounding error then the ID requirement costs nothing and settles the trust issue. Deal?'],
  [24, 25, 'The cost is never the ID itself, it is the June DMV line in a county with one office. Details, always details.'],
  [25, 12, 'The EMT detail is what gets me. We trained her, she serves us, and the system shrugs.'],
  [26, 14, 'The phone pilot data matches the international studies almost exactly. Rare to see policy evidence this clean.'],
  [27, 15, 'Mandatory meetings on the clock versus organizers banned from the parking lot. The playing field is the story.'],
  [28, 13, 'Water rights predate the data. Senior claims from 1922 beat any spreadsheet from 2026. That is the real fight.'],
  [29, 28, 'Payments plumbing is exactly where the next crisis hides. Boring is where the leverage lives.'],
  [30, 6, 'Port-of-entry scanners poll at zero because they photograph badly. Effective and boring loses to useless and dramatic.'],
  [31, 19, 'Insurance actuaries are the least ideological people alive. When they flee, believe them.'],
]

// [commentIndex (into COMMENTS above), userIndex, content]
const REPLIES = [
  [0, 11, 'Half agree — but the backlog also traps people with winning cases. Speed serves enforcement AND relief.'],
  [2, 12, 'The complaint-avoidance point is real. Admin cover for teaching hard topics would fix more than any mandate.'],
  [5, 14, 'Reversal-on-appeal rates should be a public scorecard per insurer. Sunlight is the cheapest regulation.'],
  [8, 16, 'And the payment cap reform dies in committee every single farm bill. Ask why.'],
  [10, 17, 'Old enough to enlist is the line of the year. Stealing this for the next town hall.'],
  [14, 26, 'Both underfund it because prevention has no ribbon-cutting. Politics rewards the response, never the prevention.'],
  [17, 15, 'The towns argument deserves better than tariffs though. Trade adjustment was funded at a joke level for decades.'],
  [20, 27, 'Legal pathways take a decade because the caps are from 1990. Update the caps and watch the line shorten.'],
  [23, 20, 'In the ER we already use the triage AI. It flags, humans decide, liability stays human. That model works.'],
  [24, 24, 'That trade has been offered and refused twice in my state. Neither side actually wants it settled.'],
  [27, 26, 'The parking lot ban detail is the tell. Equal access or it is not a real vote.'],
  [29, 13, 'Same reason banking regs put me through hoops a hedge fund skips: the boring rules hit the small guys first.'],
  [31, 22, 'Actuaries as the last honest referees is dark but accurate.'],
]

// Generic media-literacy comments that fit under any news article
const ARTICLE_COMMENT_POOL = [
  'Compare the verbs in this headline with how the other side wrote it. Same facts, different fight.',
  'The key number is in paragraph eight, as usual. Headlines bury what nuance survives.',
  'Read the primary source linked halfway down — the paraphrase here drops an important qualifier.',
  'Notably absent: any quote from the people the policy actually affects.',
  'This outlet was on the other side of this exact issue two years ago. Archive is undefeated.',
  'Solid reporting until the last three paragraphs turn into an op-ed.',
  'The correction appended at the bottom changes more than they admit.',
  'Who funded the study cited here? That footnote deserves its own article.',
  'Fair piece overall. The quote selection leans one way but the facts are all present.',
  'This is why I read across the spectrum — no single version of this story is complete.',
]

// Stance comments for the daily debate threads, keyed to the story so
// every room reads like its own conversation. First matching set wins;
// rooms with no match fall back to one of two generic sets.
const DEBATE_THREADS = [
  {
    // before the strikes set: "add Iran to Russia sanctions bill"
    // contains "Iran" and must not match the war-powers thread
    match: /sanction|add iran/i,
    comments: [
      [17, 'Sanctions are the tool you use so the bombs are not necessary. Congress should have led with this.'],
      [10, 'Sanctions hit civilians hardest and regimes least. Decades of evidence and we keep pretending otherwise.'],
      [19, 'Markets barely moved on the news, which tells you how much anyone believes this changes behavior.'],
      [0,  'Genuine question for the room: has a broad sanctions regime ever actually changed a government it targeted?'],
      [18, 'At least this one goes through Congress. That is already more process than the strikes got.'],
    ],
    replies: [
      [3, 25, 'Containment sometimes, capitulation basically never. South Africa is the interesting exception.'],
      [4, 21, 'The process point is underrated. Bills have text you can read. Strikes have leaks and vibes.'],
    ],
  },
  {
    match: /bomb|strike|tehran/i,
    comments: [
      [17, 'Eight nights in. You cannot call this a limited strike anymore — either ask Congress for authorization or bring them home.'],
      [4,  'Two soldiers are dead and the AUMF being cited is old enough to vote. This is exactly what the war powers clause exists for.'],
      [9,  'Deterrence only works if the other side believes you will keep going. Pulling back mid-campaign invites something worse.'],
      [25, 'The left and right coverage disagree on the basic timeline of who escalated first. Read both before you pin.'],
      [27, 'Served with guys still in theater. The commentary class scores points while they fly the sorties.'],
      [12, 'Taught war powers to my seniors this week. They asked why the vote never happens. I had no good answer.'],
    ],
    replies: [
      [0, 3,  'Congress had months to force a vote and chose fundraising instead. This is not one branch failing.'],
      [3, 0,  'Did this — the timeline gap between the wings on this story is genuinely wild.'],
    ],
  },
  {
    match: /graham/i,
    comments: [
      [3,  'Whatever you thought of the pivots, he showed up for every fight for forty years. That Senate is gone.'],
      [26, 'We can mark a death and still be honest about the record. Both are allowed at once.'],
      [8,  'Watching people who mocked him for a decade post tributes tonight is the most Washington thing I have ever seen.'],
      [19, 'The Graham-McCain friendship ran hotter than most marriages. Say what you want — that loyalty was real.'],
      [24, 'Filed the local angle tonight. His 2017 town hall was the rowdiest room I ever covered.'],
    ],
    replies: [
      [1, 7,  'The record is forty years of showing up. Start the honesty there.'],
      [2, 5,  'It is Washington. Performance is the native language.'],
    ],
  },
  {
    match: /tariff|canada|trade/i,
    comments: [
      [28, 'A tariff is a tax on your own consumers. That is not ideology, that is arithmetic.'],
      [23, 'Everyone finds free trade religion when it is their sector. Steel country heard crickets for thirty years.'],
      [13, 'My supplier repriced everything 12 percent "pending clarity" this morning. Small shops eat this first.'],
      [6,  'Watch the auto parts towns on BOTH sides of the border. Supply chains do not care where the line is.'],
      [16, 'Beef prices already tell the story. Ranchers get squeezed on both ends of every trade fight.'],
    ],
    replies: [
      [0, 19, 'Arithmetic, sure — but leverage is real too. Question is whether it ever converts into a deal.'],
      [2, 25, 'The repricing emails are the real economic data. Posting this to my group chat.'],
    ],
  },
  {
    match: /epstein|blanche|survivor/i,
    comments: [
      [26, 'The survivors asked for one thing for years: names, under oath. A meeting is not accountability.'],
      [17, 'No partisan angle from me on this one. Every enabler under oath, whichever party they wrote checks to.'],
      [24, 'The story is what discovery produces, not the meeting itself. Watch the filings, not the photo op.'],
      [1,  'Rare thread where the room mostly agrees. Look at that distribution and remember it is possible.'],
      [21, 'Institutions protect themselves first, every time. The only fix is sunlight with subpoena power.'],
    ],
    replies: [
      [0, 27, 'Under oath and on the record. Twenty-two years in law enforcement and this case still stinks.'],
      [1, 4,  'And the donations cut across both parties — which is exactly the point.'],
    ],
  },
  {
    match: /world cup|fifa|spain|argentina|final/i,
    comments: [
      [8,  'Petition to keep exactly one room on this app where nobody says the word policy. This is that room.'],
      [13, 'Spain by two. My cousin in Madrid has not slept since the semifinal.'],
      [23, 'Watched the semi in a bar in Midland with roughnecks chanting for Messi. Sport does what politics cannot.'],
      [12, 'My class did the math on Argentina inflation versus ticket prices. I sneak civics into everything, sorry.'],
      [25, 'The model says Spain, my heart says Argentina, and the model has been wrong all tournament.'],
    ],
    replies: [
      [0, 20, 'Seconded. The ER goes quiet during matches too. Blessed ninety minutes.'],
      [4, 0,  'A model that admits it has been wrong is the only kind worth trusting.'],
    ],
  },
]

// Fallback threads for stories with no topical set; parity-picked so
// two fallback rooms on the same day still read differently.
const FALLBACK_THREADS = [
  {
    comments: [
      [25, 'The coverage split on this one is worth the summary page before you pin anything.'],
      [7,  'Hot takes are free. Sourced takes are rare. Guess which one this thread will collect.'],
      [10, 'The people this actually affects are barely quoted in any version of the story.'],
      [21, 'Second-order effects will be the real story here in six months. Screenshot this.'],
    ],
    replies: [[0, 29, 'My chair hears every side of this one all day. Nobody quotes the barbershop.']],
  },
  {
    comments: [
      [5,  'Pinned dead center on this one, and not because I have no opinion — both wings have half the story.'],
      [30, 'Casework rule applies here: the press release and the reality are two different documents.'],
      [15, 'Ask how this lands on people who work for a living and the room gets a lot less confident.'],
      [2,  'The distribution on this room is more interesting than the comments so far. Wide spread, thin middle.'],
    ],
    replies: [[1, 22, 'The gap between announcement and implementation is where every story like this lives.']],
  },
]

// --- helpers ---------------------------------------------------------

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body && method === 'GET' ? 'POST' : method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data?.error ?? 'unknown'}`)
  return data
}

// Deterministic pseudo-randomness so reruns behave identically
function hash(a, b) {
  let h = (a * 2654435761 + b * 40503) >>> 0
  h = ((h ^ (h >> 16)) * 2246822507) >>> 0
  return ((h ^ (h >> 13)) >>> 0) / 4294967296
}

const sideOf = (v) => (v < 0.45 ? 'left' : v > 0.55 ? 'right' : 'center')

// A persona votes up on same-side or center content, down on the other
// side — with ~15% contrarian noise so nothing looks mechanical.
function directionFor(userLean, contentLean, salt) {
  const aligned = sideOf(userLean) === sideOf(contentLean) || sideOf(contentLean) === 'center'
  const flip = hash(Math.round(userLean * 100) + salt, Math.round(contentLean * 100)) < 0.15
  return aligned !== flip ? 'up' : 'down'
}

async function main() {
  // 1. Users: login-or-signup, set avatar + bio
  const tokens = []
  const userIds = []
  for (const u of USERS) {
    let auth
    try {
      auth = await call('/auth/login', { body: { email: u.email, password: PASSWORD } })
    } catch {
      auth = await call('/auth/signup', { body: { username: u.username, email: u.email, password: PASSWORD } })
      console.log(`created ${u.username}`)
    }
    tokens.push(auth.token)
    userIds.push(auth.user.id)
    const patch = { avatar_url: u.avatar }
    if (u.bio) patch.bio = u.bio
    await call('/users/me', { method: 'PATCH', token: auth.token, body: patch })
  }
  console.log(`${USERS.length} users ready`)

  // 2. New posts (skip existing by content)
  const existingPosts = await call('/posts?limit=100', { token: tokens[0] })
  const postIds = []
  for (const p of POSTS) {
    const found = existingPosts.find((e) => e.content === p.content)
    const post = found ?? await call('/posts', {
      token: tokens[p.user],
      body: { content: p.content, hashtags: p.hashtags },
    })
    postIds.push(post.id)
    if (p.expected) {
      const [min, max] = p.expected
      if (post.position == null || post.position < min || post.position > max) {
        throw new Error(
          `Seed stance outside expected range ${min}–${max}: ${post.position ?? 'unclassified'} — ${p.content}`
        )
      }
    }
  }
  console.log(`${postIds.length} wave-2 posts ready`)

  // 3. Comments + replies on the new posts
  const commentIds = []
  for (const [post, user, content] of COMMENTS) {
    const page = await call(`/comments?post_id=${postIds[post]}&limit=50`, { token: tokens[0] })
    const found = page.comments.find((cm) => cm.content === content)
    if (found) { commentIds.push(found.id); continue }
    const created = await call('/comments', { token: tokens[user], body: { post_id: postIds[post], content } })
    commentIds.push(created.id)
  }
  for (const [ci, user, content] of REPLIES) {
    const page = await call(`/comments?parent_comment_id=${commentIds[ci]}&limit=50`, { token: tokens[0] })
    if (page.comments.some((cm) => cm.content === content)) continue
    await call('/comments', { token: tokens[user], body: { parent_comment_id: commentIds[ci], content } })
  }
  console.log(`${COMMENTS.length} comments + ${REPLIES.length} replies ready`)

  // 4. Article comments spread across the newest 30 articles
  const articles = await call('/articles?limit=40', { token: tokens[0] })
  let articleComments = 0
  for (let i = 0; i < Math.min(30, articles.length); i++) {
    if (hash(7, i) > 0.6) continue // ~60% of articles get a comment
    const content = ARTICLE_COMMENT_POOL[Math.floor(hash(11, i) * ARTICLE_COMMENT_POOL.length)]
    const user = Math.floor(hash(13, i) * USERS.length)
    const page = await call(`/comments?article_id=${articles[i].id}&limit=50`, { token: tokens[0] })
    if (page.comments.some((cm) => cm.content === content)) continue
    await call('/comments', { token: tokens[user], body: { article_id: articles[i].id, content } })
    articleComments++
  }
  console.log(`${articleComments} article comments added`)

  // 5. Votes everywhere, persona-aligned
  const allPosts = await call('/posts?limit=100', { token: tokens[0] })
  let postVotes = 0
  for (let u = 0; u < USERS.length; u++) {
    for (let p = 0; p < allPosts.length; p++) {
      if (allPosts[p].user_id === userIds[u]) continue      // no self-votes
      if (hash(u * 31 + 1, p) > 0.45) continue              // each user votes on ~45% of posts
      const contentLean = allPosts[p].position ?? 0.5
      await call(`/posts/${allPosts[p].id}/vote`, {
        token: tokens[u],
        body: { direction: directionFor(USERS[u].lean, contentLean, p) },
      })
      postVotes++
    }
  }
  console.log(`${postVotes} post votes cast`)

  let articleVotes = 0
  for (let u = 0; u < USERS.length; u++) {
    for (let i = 0; i < Math.min(40, articles.length); i++) {
      if (hash(u * 53 + 2, i) > 0.35) continue              // ~35% of articles per user
      const lean = articles[i].political_lean ?? articles[i].source_lean ?? 0.5
      await call(`/articles/${articles[i].id}/vote`, {
        token: tokens[u],
        body: { direction: directionFor(USERS[u].lean, Number(lean), 1000 + i) },
      })
      articleVotes++
    }
  }
  console.log(`${articleVotes} article votes cast`)

  let commentVotes = 0
  for (let ci = 0; ci < commentIds.length; ci++) {
    const voters = 2 + Math.floor(hash(17, ci) * 5)
    for (let v = 0; v < voters; v++) {
      const voter = Math.floor(hash(ci, v * 7 + 3) * USERS.length)
      const direction = hash(ci * 3, v) < 0.8 ? 'up' : 'down'
      await call(`/comments/${commentIds[ci]}/vote`, { token: tokens[voter], body: { direction } })
      commentVotes++
    }
  }
  console.log(`${commentVotes} comment votes cast`)

  // 6. Bookmarks ("favorites") — 2-3 posts + 2 articles per user;
  // toggle flips, so check each user's current list first
  let bookmarks = 0
  for (let u = 0; u < USERS.length; u++) {
    const mine = await call('/bookmarks', { token: tokens[u] })
    const savedPosts = new Set(mine.filter((b) => b.kind === 'post').map((b) => b.item.id))
    const savedArticles = new Set(mine.filter((b) => b.kind === 'article').map((b) => b.item.id))
    for (let k = 0; k < 3; k++) {
      const post = allPosts[Math.floor(hash(u * 7 + 5, k) * allPosts.length)]
      if (post && !savedPosts.has(post.id)) {
        await call('/bookmarks/toggle', { token: tokens[u], body: { post_id: post.id } })
        savedPosts.add(post.id)
        bookmarks++
      }
    }
    for (let k = 0; k < 2; k++) {
      const article = articles[Math.floor(hash(u * 11 + 6, k) * Math.min(40, articles.length))]
      if (article && !savedArticles.has(article.id)) {
        await call('/bookmarks/toggle', { token: tokens[u], body: { article_id: article.id } })
        savedArticles.add(article.id)
        bookmarks++
      }
    }
  }
  console.log(`${bookmarks} bookmarks added`)

  // 7. The Floor. Each room must read like its own conversation:
  //  - jitter and participation are salted with the FULL debate id (a
  //    single charCode once made two rooms byte-identical)
  //  - not everyone joins every room — participation varies by kind
  //  - each room gets a small persona drift so medians differ
  //  - threads are topical (keyword-matched on the title), never shared
  const idSalt = (id) => [...String(id)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 100000, 7)
  // hash() skews low for phase-7's argument ranges (small a, large b) —
  // it once pushed every pin left and let everyone through the join
  // gate. Shader-style sin mix is uniform across this range.
  const mix = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
    return s - Math.floor(s)
  }
  const debates = await call('/debates', { token: tokens[0] })
  let debateVotes = 0
  let fallbackParity = 0
  for (const debate of debates) {
    const salt = idSalt(debate.id)
    const joinRate = debate.kind === 'biggest' ? 0.9
      : debate.kind === 'contested' ? 0.75
      : 0.4 + mix(salt, 11) * 0.3
    const roomDrift = (mix(salt, 13) - 0.5) * 0.2

    const thread = DEBATE_THREADS.find((t) => t.match.test(debate.title))
      ?? FALLBACK_THREADS[fallbackParity++ % FALLBACK_THREADS.length]

    // commenters always join their room; John (u=0) demos everywhere
    const participants = new Set([0])
    for (const [user] of thread.comments) participants.add(user)
    for (const [, user] of thread.replies) participants.add(user)
    for (let u = 0; u < USERS.length; u++) {
      if (mix(u * 7 + 3, salt) < joinRate) participants.add(u)
    }

    for (const u of participants) {
      const jitter = (mix(u * 19 + 8, salt) - 0.5) * 0.3
      const position = Math.min(Math.max(USERS[u].lean + roomDrift + jitter, 0.02), 0.98)
      await call(`/debates/${debate.id}/vote`, { token: tokens[u], body: { position: Number(position.toFixed(3)) } })
      debateVotes++
    }

    const debateCommentIds = []
    for (const [user, content] of thread.comments) {
      const page = await call(`/comments?debate_id=${debate.id}&limit=50`, { token: tokens[0] })
      const found = page.comments.find((cm) => cm.content === content)
      if (found) { debateCommentIds.push(found.id); continue }
      const created = await call('/comments', { token: tokens[user], body: { debate_id: debate.id, content } })
      debateCommentIds.push(created.id)
    }
    for (const [ci, user, content] of thread.replies) {
      const page = await call(`/comments?parent_comment_id=${debateCommentIds[ci]}&limit=50`, { token: tokens[0] })
      if (page.comments.some((cm) => cm.content === content)) continue
      await call('/comments', { token: tokens[user], body: { parent_comment_id: debateCommentIds[ci], content } })
    }
    // votes on debate comments, voters drawn from the room's participants
    const roster = [...participants]
    for (let ci = 0; ci < debateCommentIds.length; ci++) {
      const voters = 2 + Math.floor(mix(salt + 23, ci) * 4)
      for (let v = 0; v < voters; v++) {
        const voter = roster[Math.floor(mix(ci + salt, v * 5 + 1) * roster.length)]
        const direction = mix(ci * 9 + salt, v + 2) < 0.75 ? 'up' : 'down'
        await call(`/comments/${debateCommentIds[ci]}/vote`, { token: tokens[voter], body: { direction } })
      }
    }
  }
  console.log(`${debateVotes} debate pins + threads on ${debates.length} debates`)
  console.log('Expansion seed complete.')
}

main().catch((err) => {
  console.error('Seed failed:', err.message)
  process.exit(1)
})
