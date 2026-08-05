// ============================================================
// Curated news sources: RSS feeds + outlet-level lean priors.
//
// The `lean` value (0 = left, 1 = right) is a hand-mapped
// approximation of published outlet ratings from AllSides
// (allsides.com/media-bias/ratings) and Ad Fontes Media
// (adfontesmedia.com) as of mid-2026. These priors anchor the
// article scorer; the article's own text can shift the final score
// by at most ±0.25 (see scoring/score.ts). Editing a prior is a
// scale change — bump SCORER_VERSION and `npm run rescore`.
//
// Rough mapping used: Left ≈ 0.15, Lean Left ≈ 0.33, Center ≈ 0.50,
// Lean Right ≈ 0.67, Right ≈ 0.80, Far Right ≈ 0.90.
// ============================================================

export type Source = {
  name: string        // stored in articles.source — must stay stable
  slug: string
  lean: number        // 0..1 outlet prior
  feeds: string[]     // politics-focused RSS/Atom endpoints
}

export const SOURCES: Source[] = [
  // --- Left ---
  { name: 'Mother Jones', slug: 'mother-jones', lean: 0.15,
    feeds: ['https://www.motherjones.com/feed/'] },
  { name: 'Democracy Now', slug: 'democracy-now', lean: 0.15,
    feeds: ['https://www.democracynow.org/democracynow.rss'] },
  { name: 'The Nation', slug: 'the-nation', lean: 0.15,
    feeds: ['https://www.thenation.com/feed/?post_type=article'] },
  { name: 'The Intercept', slug: 'intercept', lean: 0.18,
    feeds: ['https://theintercept.com/feed/?rss'] },
  { name: 'Salon', slug: 'salon', lean: 0.18,
    feeds: ['https://www.salon.com/feed/'] },
  { name: 'The New Republic', slug: 'new-republic', lean: 0.18,
    feeds: ['https://newrepublic.com/rss.xml'] },
  { name: 'HuffPost', slug: 'huffpost', lean: 0.20,
    feeds: ['https://chaski.huffpost.com/us/auto/vertical/politics'] },
  { name: 'Talking Points Memo', slug: 'tpm', lean: 0.20,
    feeds: ['https://talkingpointsmemo.com/feed'] },
  { name: 'Vox', slug: 'vox', lean: 0.22,
    feeds: ['https://www.vox.com/rss/index.xml'] },
  { name: 'Slate', slug: 'slate', lean: 0.22,
    feeds: ['https://slate.com/feeds/news-and-politics.rss'] },
  { name: 'Daily Beast', slug: 'daily-beast', lean: 0.22,
    feeds: ['https://www.thedailybeast.com/arc/outboundfeeds/rss/articles/?outputType=xml'] },
  { name: 'The New Yorker', slug: 'new-yorker', lean: 0.25,
    feeds: ['https://www.newyorker.com/feed/news'] },
  { name: 'The Atlantic', slug: 'atlantic', lean: 0.28,
    feeds: ['https://www.theatlantic.com/feed/all/'] },

  // --- Lean left ---
  { name: 'The Guardian', slug: 'guardian', lean: 0.33,
    feeds: ['https://www.theguardian.com/us-news/rss'] },
  { name: 'The New York Times', slug: 'nyt', lean: 0.35,
    feeds: ['https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml'] },
  { name: 'ProPublica', slug: 'propublica', lean: 0.35,
    feeds: ['https://www.propublica.org/feeds/propublica/main'] },
  { name: 'Time', slug: 'time', lean: 0.35,
    feeds: ['https://time.com/feed/'] },
  { name: 'The Independent', slug: 'independent', lean: 0.35,
    feeds: ['https://www.independent.co.uk/news/world/americas/us-politics/rss'] },
  { name: 'NBC News', slug: 'nbc', lean: 0.37,
    feeds: ['https://feeds.nbcnews.com/nbcnews/public/politics'] },
  { name: 'CBS News', slug: 'cbs', lean: 0.40,
    feeds: ['https://www.cbsnews.com/latest/rss/politics'] },
  { name: 'ABC News', slug: 'abc', lean: 0.40,
    feeds: ['https://abcnews.go.com/abcnews/politicsheadlines'] },
  { name: 'NPR', slug: 'npr', lean: 0.40,
    feeds: ['https://feeds.npr.org/1014/rss.xml'] },  // 1014 = politics
  { name: 'Al Jazeera', slug: 'al-jazeera', lean: 0.40,
    feeds: ['https://www.aljazeera.com/xml/rss/all.xml'] },
  { name: 'Politico', slug: 'politico', lean: 0.42,
    feeds: ['https://rss.politico.com/politics-news.xml'] },
  { name: 'Axios', slug: 'axios', lean: 0.45,
    feeds: ['https://api.axios.com/feed/'] },
  { name: 'PBS NewsHour', slug: 'pbs', lean: 0.45,
    feeds: ['https://www.pbs.org/newshour/feeds/rss/politics'] },

  // --- Center ---
  { name: 'The Economist', slug: 'economist', lean: 0.48,
    feeds: ['https://www.economist.com/united-states/rss.xml'] },
  { name: 'BBC News', slug: 'bbc', lean: 0.50,
    feeds: ['https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml'] },
  { name: 'The Hill', slug: 'the-hill', lean: 0.50,
    feeds: ['https://thehill.com/homenews/feed/'] },
  { name: 'Christian Science Monitor', slug: 'csm', lean: 0.50,
    feeds: ['https://rss.csmonitor.com/feeds/usa'] },
  { name: 'CNBC', slug: 'cnbc', lean: 0.50,
    feeds: ['https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000113'] },
  { name: 'Roll Call', slug: 'roll-call', lean: 0.50,
    feeds: ['https://rollcall.com/feed/'] },
  { name: 'NewsNation', slug: 'newsnation', lean: 0.50,
    feeds: ['https://www.newsnationnow.com/feed/'] },
  { name: 'Straight Arrow News', slug: 'san', lean: 0.50,
    feeds: ['https://san.com/feed/'] },
  { name: 'Sky News', slug: 'sky-news', lean: 0.50,
    feeds: ['https://feeds.skynews.com/feeds/rss/us.xml'] },
  { name: 'Newsweek', slug: 'newsweek', lean: 0.52,
    feeds: ['https://www.newsweek.com/rss'] },
  { name: 'The Free Press', slug: 'free-press', lean: 0.55,
    feeds: ['https://www.thefp.com/feed'] },

  // --- Lean right ---
  { name: 'RealClearPolitics', slug: 'rcp', lean: 0.60,
    feeds: ['https://www.realclearpolitics.com/index.xml'] },
  { name: 'The Dispatch', slug: 'dispatch', lean: 0.60,
    feeds: ['https://thedispatch.com/feed/'] },
  { name: 'Reason', slug: 'reason', lean: 0.62,
    feeds: ['https://reason.com/feed/'] },
  { name: 'Just the News', slug: 'just-the-news', lean: 0.65,
    feeds: ['https://justthenews.com/rss.xml'] },
  { name: 'Daily Mail', slug: 'daily-mail', lean: 0.65,
    feeds: ['https://www.dailymail.co.uk/news/us-politics/index.rss'] },
  { name: 'Washington Examiner', slug: 'washington-examiner', lean: 0.67,
    feeds: ['https://www.washingtonexaminer.com/feed'] },
  { name: 'New York Post', slug: 'ny-post', lean: 0.68,
    feeds: ['https://nypost.com/politics/feed/'] },
  { name: 'Washington Times', slug: 'washington-times', lean: 0.70,
    feeds: ['https://www.washingtontimes.com/rss/headlines/news/politics/'] },
  { name: 'The American Conservative', slug: 'american-conservative', lean: 0.70,
    feeds: ['https://www.theamericanconservative.com/feed/'] },

  // --- Right ---
  { name: 'Fox News', slug: 'fox-news', lean: 0.75,
    feeds: ['https://moxie.foxnews.com/google-publisher/politics.xml'] },
  { name: 'National Review', slug: 'national-review', lean: 0.75,
    feeds: ['https://www.nationalreview.com/feed/'] },
  { name: 'Washington Free Beacon', slug: 'free-beacon', lean: 0.75,
    feeds: ['https://freebeacon.com/feed/'] },
  { name: 'Daily Caller', slug: 'daily-caller', lean: 0.75,
    feeds: ['http://feeds.dailycaller.com/dailycaller'] },
  { name: 'The Daily Wire', slug: 'daily-wire', lean: 0.80,
    feeds: ['https://www.dailywire.com/feeds/rss.xml'] },
  { name: 'The Federalist', slug: 'federalist', lean: 0.80,
    feeds: ['https://thefederalist.com/feed/'] },
  { name: 'Newsmax', slug: 'newsmax', lean: 0.80,
    feeds: ['https://www.newsmax.com/rss/Politics/1/'] },
  { name: 'The Blaze', slug: 'the-blaze', lean: 0.80,
    feeds: ['https://www.theblaze.com/feeds/feed.rss'] },
  { name: 'PJ Media', slug: 'pj-media', lean: 0.82,
    feeds: ['https://pjmedia.com/feed'] },
  { name: 'RedState', slug: 'redstate', lean: 0.85,
    feeds: ['https://redstate.com/feed'] },
  { name: 'American Thinker', slug: 'american-thinker', lean: 0.85,
    feeds: ['https://feeds.feedburner.com/americanthinker'] },
  { name: 'Breitbart', slug: 'breitbart', lean: 0.90,
    feeds: ['http://feeds.feedburner.com/breitbart'] },
]

const byName = new Map(SOURCES.map((s) => [s.name.toLowerCase(), s]))

// These publishers' reviewed terms expressly restrict AI use, automated
// analysis, aggregation, or a closely related operation. They remain useful as
// attributed headline/link sources in the app, but neither their headlines nor
// any transiently extracted text may be placed in an OpenAI prompt. Keep this
// list aligned with forum/docs/PUBLISHER_CONTENT_RIGHTS.md. Unknown sources fail
// closed until their policy has been reviewed.
export const AI_CONTEXT_BLOCKED_SOURCES = new Set([
  'The New Republic',
  'HuffPost',
  'Vox',
  'The New Yorker',
  'The Atlantic',
  'The Guardian',
  'NBC News',
  'ABC News',
  'CNBC',
  'Sky News',
  'New York Post',
  'The Daily Wire',
  'Newsmax',
  'The Blaze',
  'Breitbart',
])

// This is intentionally explicit instead of treating every non-blocked source
// as allowed. Adding a publisher to SOURCES must be accompanied by a reviewed
// allow or block decision, otherwise the synchronization test fails and the
// runtime continues to fail closed.
export const AI_CONTEXT_ALLOWED_SOURCES = new Set([
  'Mother Jones',
  'Democracy Now',
  'The Nation',
  'The Intercept',
  'Salon',
  'Talking Points Memo',
  'Slate',
  'Daily Beast',
  'The New York Times',
  'ProPublica',
  'Time',
  'The Independent',
  'CBS News',
  'NPR',
  'Al Jazeera',
  'Politico',
  'Axios',
  'PBS NewsHour',
  'The Economist',
  'BBC News',
  'The Hill',
  'Christian Science Monitor',
  'Roll Call',
  'NewsNation',
  'Straight Arrow News',
  'Newsweek',
  'The Free Press',
  'RealClearPolitics',
  'The Dispatch',
  'Reason',
  'Just the News',
  'Daily Mail',
  'Washington Examiner',
  'Washington Times',
  'The American Conservative',
  'Fox News',
  'National Review',
  'Washington Free Beacon',
  'Daily Caller',
  'The Federalist',
  'PJ Media',
  'RedState',
  'American Thinker',
])

export const SOURCE_POLICY_REVIEWED_AT = '2026-08-01'
export const PUBLISHER_IMAGE_MODE = 'remote_publisher_preview' as const
export const LOCAL_ARTICLE_ANALYSIS_MODE = 'transient_derived_features' as const

export function sourcePolicyDecision(sourceName: string | null | undefined) {
  if (!sourceName) return null
  const source = byName.get(sourceName.toLowerCase())
  if (!source) return null
  if (AI_CONTEXT_ALLOWED_SOURCES.has(source.name)) {
    return {
      reviewed_at: SOURCE_POLICY_REVIEWED_AT,
      ai_context: 'eligible_attributed_headlines' as const,
      image_mode: PUBLISHER_IMAGE_MODE,
      local_analysis: LOCAL_ARTICLE_ANALYSIS_MODE,
    }
  }
  if (AI_CONTEXT_BLOCKED_SOURCES.has(source.name)) {
    return {
      reviewed_at: SOURCE_POLICY_REVIEWED_AT,
      ai_context: 'blocked' as const,
      image_mode: PUBLISHER_IMAGE_MODE,
      local_analysis: LOCAL_ARTICLE_ANALYSIS_MODE,
    }
  }
  return null
}

export function sourceAllowsAiContext(sourceName: string | null | undefined): boolean {
  return sourcePolicyDecision(sourceName)?.ai_context === 'eligible_attributed_headlines'
}

export function sourcePrior(sourceName: string | null | undefined): number | undefined {
  if (!sourceName) return undefined
  return byName.get(sourceName.toLowerCase())?.lean
}
