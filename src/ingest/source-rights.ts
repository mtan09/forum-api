// Source provenance and processing policy for every publisher in the curated
// registry. The status and note preserve the result of the publisher-policy
// audit; the runtime modes describe forum's actual product behavior.
//
// forum does not publish or retain article bodies. Eligible publisher text is
// read transiently during ingestion, converted into non-reconstructive
// structured evidence, and discarded. Publisher images are retained only as
// bounded card/carousel thumbnails with provenance and expiry.

export const RIGHTS_POLICY_VERSION = '2026-07-29.2'
export const RIGHTS_REVIEWED_AT = '2026-07-29'

export type SourceRightsStatus = 'conditional' | 'restricted' | 'unverified'
export type TextAcquisitionMode = 'feed_metadata' | 'feed_text' | 'full_page' | 'disabled'
export type PublicTextMode = 'headline_only' | 'feed_description' | 'full_text'
export type AnalysisMode =
  | 'metadata_only'
  | 'feed_text_transient'
  | 'full_page_transient'
export type AiMode =
  | 'metadata_only'
  | 'structured_evidence'
  | 'permitted_text'
  | 'denied'
export type ImageMode =
  | 'none'
  | 'remote_no_cache'
  | 'managed_thumbnail'
  | 'licensed_cache'

export type SourceRights = {
  status: SourceRightsStatus
  acquisition: TextAcquisitionMode
  publicText: PublicTextMode
  analysis: AnalysisMode
  ai: AiMode
  image: ImageMode
  termsUrl: string | null
  reviewedAt: string
  note: string
}

type PolicyInput = Pick<SourceRights, 'status' | 'termsUrl' | 'note'> &
  Partial<Pick<SourceRights, 'acquisition' | 'publicText' | 'analysis' | 'ai' | 'image'>>

const policy = ({
  status,
  termsUrl,
  note,
  acquisition = 'full_page',
  publicText = 'headline_only',
  analysis = 'full_page_transient',
  ai = 'structured_evidence',
  image = 'managed_thumbnail',
}: PolicyInput): SourceRights => ({
  status,
  acquisition,
  publicText,
  analysis,
  ai,
  image,
  termsUrl,
  reviewedAt: RIGHTS_REVIEWED_AT,
  note,
})

const conditional = (termsUrl: string, note: string) =>
  policy({ status: 'conditional', termsUrl, note })
const restricted = (termsUrl: string, note: string) =>
  policy({ status: 'restricted', termsUrl, note })
const unverified = (note: string) =>
  policy({ status: 'unverified', termsUrl: null, note })

// The registry records policy risk without silently collapsing the app into a
// headline-only link list. A source can still be narrowed to metadata-only or
// disabled explicitly if a concrete operational or contractual reason arises.
const POLICIES: Record<string, SourceRights> = {
  'mother-jones': unverified('No affirmative commercial app, AI, or image grant located.'),
  'democracy-now': conditional(
    'https://www.democracynow.org/get_involved/spread_the_word/reprint_transcripts',
    'Transcript republication is encouraged with credit; images and automated AI processing are not covered.'
  ),
  'the-nation': restricted(
    'https://www.thenation.com/termsofuse/',
    'Published terms restrict automated extraction, reproduction, and derivative use.'
  ),
  intercept: unverified('No affirmative commercial app, AI, or image grant located.'),
  salon: restricted(
    'https://www.salon.com/about/tos',
    'Published terms restrict reproduction and commercial reuse.'
  ),
  'new-republic': restricted(
    'https://newrepublic.com/pages/terms-and-conditions',
    'Published terms restrict copying, republication, and commercial use.'
  ),
  huffpost: unverified('No affirmative commercial app, AI, or image grant located.'),
  tpm: restricted(
    'https://talkingpointsmemo.com/terms-of-use',
    'Content is licensed for personal, noncommercial use with only narrow excerpt exceptions.'
  ),
  vox: conditional(
    'https://www.voxmedia.com/licensing/',
    'Headline plus link is permitted; content and images require a broader license.'
  ),
  slate: unverified('No current affirmative commercial app, AI, or image grant located.'),
  'daily-beast': restricted(
    'https://www.thedailybeast.com/company/terms-of-use/',
    'Published terms restrict robots, storage, redistribution, and third-party wire content.'
  ),
  'new-yorker': restricted(
    'https://www.condenast.com/user-agreement',
    'Condé Nast terms restrict scraping, storage, republication, and AI/RAG use.'
  ),
  atlantic: restricted(
    'https://www.theatlantic.com/terms-and-conditions/',
    'RSS is personal/noncommercial and automated indexing or data mining requires permission.'
  ),
  guardian: restricted(
    'https://www.theguardian.com/help/feeds',
    'RSS reuse is limited to personal, noncommercial use absent permission.'
  ),
  nyt: restricted(
    'https://thenewyorktimeshelpcenter.helpjuice.com/115002797688-Policies/115014893428-Terms-of-Service/version/2?kb_language=en_US',
    'Terms restrict scraping, storage, commercial reuse, and AI/RAG use.'
  ),
  propublica: conditional(
    'https://www.propublica.org/steal-our-stories',
    'Eligible stories have narrow republication terms; automated app syndication and photographs are excluded.'
  ),
  time: unverified('No affirmative commercial app, AI, or image grant located.'),
  independent: unverified('No affirmative commercial app, AI, or image grant located.'),
  nbc: restricted(
    'https://www.nbcuniversal.com/terms/prohibited-actions',
    'NBCUniversal restricts scraping, extraction, aggregation, storage, and AI use.'
  ),
  cbs: restricted(
    'https://www.cbsnews.com/news/cbsnewscom-terms-of-service/',
    'Published terms restrict copying, reproduction, and automated access.'
  ),
  abc: conditional(
    'https://abcnews.go.com/Technology/RSS/story?id=32076',
    'A legacy RSS agreement is narrow and time-limited; written reconfirmation is required before enabling it.'
  ),
  npr: restricted(
    'https://www.vpm.org/npr-news/npr-news/2013-05-03/terms-of-use',
    'Published NPR terms restrict commercial RSS/API, scraping, and AI use.'
  ),
  'al-jazeera': restricted(
    'https://www.aljazeera.com/terms-and-conditions/',
    'Terms explicitly restrict scraping and text/data mining, including analytical use.'
  ),
  politico: unverified('No affirmative commercial app, AI, or image grant located.'),
  axios: unverified('No affirmative commercial app, AI, or image grant located.'),
  pbs: restricted(
    'https://www.pbs.org/about/about-pbs/terms-of-use/',
    'Permission is required for reuse of text, images, and clips.'
  ),
  economist: restricted(
    'https://developer.economist.com/docs',
    'Commercial text and image use is offered through contractual API entitlements.'
  ),
  bbc: restricted(
    'https://downloads.bbc.co.uk/usingthebbc/bbc_terms_of_use_31March2022english.pdf',
    'Business use of BBC metadata, RSS, text, images, and links requires permission or a license.'
  ),
  'the-hill': restricted(
    'https://www.nexstar.tv/terms-of-use/',
    'Nexstar terms restrict scraping, mining, storage, redistribution, and AI use.'
  ),
  csm: restricted(
    'https://www.csmonitor.com/About/Terms',
    'Commercial RSS and RSS photographs are restricted; third-party agency images require separate permission.'
  ),
  cnbc: restricted(
    'https://www.nbcuniversal.com/terms/prohibited-actions',
    'NBCUniversal restricts scraping, extraction, aggregation, storage, and AI use.'
  ),
  'roll-call': unverified('FiscalNote offers licensed products, but no affirmative Roll Call feed grant was located.'),
  newsnation: restricted(
    'https://www.nexstar.tv/terms-of-use/',
    'Nexstar terms restrict scraping, mining, storage, redistribution, and AI use.'
  ),
  san: restricted(
    'https://san.com/terms/',
    'Terms restrict automated access, systematic downloads, archives, and AI/data-mining use.'
  ),
  'sky-news': restricted(
    'https://www.sky.com/help/articles/skycom-terms-and-conditions',
    'Terms restrict bots, crawling, scraping, aggregation, data mining, and AI use.'
  ),
  newsweek: unverified('No affirmative commercial app, AI, or image grant located.'),
  'free-press': unverified('No affirmative commercial app, AI, or image grant located.'),
  rcp: unverified('No affirmative commercial app, AI, or image grant located.'),
  dispatch: unverified('No affirmative commercial app, AI, or image grant located.'),
  reason: restricted(
    'https://reason.com/terms-of-use/',
    'Links and citations are allowed, while content use is personal and noncommercial.'
  ),
  'just-the-news': unverified('No affirmative commercial app, AI, or image grant located.'),
  'daily-mail': unverified('No affirmative commercial app, AI, or image grant located.'),
  'washington-examiner': unverified('No affirmative commercial app, AI, or image grant located.'),
  'ny-post': unverified('No sufficiently stable source-specific commercial app and image grant was located.'),
  'washington-times': unverified('No affirmative commercial app, AI, or image grant located.'),
  'american-conservative': unverified('No affirmative commercial app, AI, or image grant located.'),
  'fox-news': restricted(
    'https://www.foxnews.com/terms-of-use',
    'Published terms restrict automated access, copying, and commercial republication.'
  ),
  'national-review': unverified('No affirmative commercial app, AI, or image grant located.'),
  'free-beacon': restricted(
    'https://freebeacon.com/terms-of-use/',
    'Published terms restrict copying, redistribution, and commercial use.'
  ),
  'daily-caller': restricted(
    'https://dailycaller.com/footer/terms-of-use/',
    'Published terms restrict copying, reproduction, and redistribution.'
  ),
  'daily-wire': unverified('No sufficiently clear source-wide commercial app, AI, or image grant was located.'),
  federalist: unverified('No affirmative commercial app, AI, or image grant located.'),
  newsmax: restricted(
    'https://www.newsmax.com/terms/',
    'Terms restrict scraping, database building, commercial RSS reuse, and AI use.'
  ),
  'the-blaze': restricted(
    'https://www.theblaze.com/terms',
    'Published terms restrict automated extraction and content reuse.'
  ),
  'pj-media': unverified('No affirmative commercial app, AI, or image grant located.'),
  redstate: unverified('No affirmative commercial app, AI, or image grant located.'),
  'american-thinker': unverified('No affirmative commercial app, AI, or image grant located.'),
  breitbart: restricted(
    'https://web.breitbart.com/terms-and-conditions',
    'Terms restrict archiving, reproduction, distribution, and derivative use.'
  ),
}

const DENY_BY_DEFAULT = unverified(
  'Source is absent from the reviewed registry; transient processing requires an explicit registry entry.'
)

export function rightsForSource(slug: string): SourceRights {
  return POLICIES[slug] ?? {
    ...DENY_BY_DEFAULT,
    acquisition: 'feed_metadata',
    analysis: 'metadata_only',
    ai: 'metadata_only',
    image: 'remote_no_cache',
  }
}

export function sourceRightsEntries(): ReadonlyArray<readonly [string, SourceRights]> {
  return Object.entries(POLICIES)
}

export function missingSourceRights(slugs: string[]): string[] {
  return slugs.filter((slug) => !POLICIES[slug])
}
