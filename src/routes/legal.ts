import { Hono } from 'hono'
import { query } from '../db'
import { verifyDailyBriefUnsubscribeToken } from '../lib/brief-unsubscribe'

// Terms + Privacy served straight from the API, so once the API is deployed
// these are real public URLs — which is exactly what App Store review asks
// for (a hosted privacy policy) and what the in-app Settings rows open.
const legal = new Hono()

const EFFECTIVE_DATE = 'August 2, 2026'
const CONTACT_EMAIL =
  process.env.LEGAL_CONTACT_EMAIL ??
  process.env.SUPPORT_EMAIL ??
  'michael.tan0953@gmail.com'

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — forum</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 680px;
         margin: 0 auto; padding: 32px 20px 64px; line-height: 1.6; }
  h1 { color: #B647FF; margin-bottom: 4px; }
  h2 { margin-top: 28px; font-size: 1.15em; }
  .date { opacity: 0.6; font-size: 0.9em; margin-bottom: 24px; }
  a { color: #B647FF; }
</style></head><body>
<h1>${title}</h1>
<div class="date">Effective ${EFFECTIVE_DATE}</div>
${body}
<p style="margin-top:40px;opacity:0.6">Questions: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</body></html>`

/**
 * A valid token means the request is authentic. Whether a prefs row happened
 * to exist is a separate question — reporting "invalid link" when the row is
 * simply missing tells a user their unsubscribe failed when it did not, on a
 * compliance surface. Upsert so the opt-out is recorded either way.
 */
const unsubscribeUser = async (token: string) => {
  const userId = verifyDailyBriefUnsubscribeToken(token)
  if (!userId) return false
  await query(
    `INSERT INTO notification_prefs (user_id, email_daily_brief)
     VALUES ($1, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET email_daily_brief = FALSE`,
    [userId]
  )
  return true
}

legal.get('/unsubscribe-daily-brief', (c) => {
  const token = c.req.query('token') ?? ''
  if (!verifyDailyBriefUnsubscribeToken(token)) {
    return c.html(page('Invalid link', '<p>This unsubscribe link is invalid.</p>'), 400)
  }
  return c.html(page('Daily Brief email', `
    <p>Stop receiving the Daily Brief by email? The briefing will remain available inside forum.</p>
    <form method="post" action="/legal/unsubscribe-daily-brief?token=${encodeURIComponent(token)}">
      <button type="submit" style="border:0;border-radius:12px;background:#B647FF;color:white;padding:12px 18px;font-weight:700">Unsubscribe</button>
    </form>`))
})

legal.post('/unsubscribe-daily-brief', async (c) => {
  const token = c.req.query('token') ?? ''
  // RFC 8058: `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is a header
  // the SENDER puts on the email. The mail client then POSTs with that string
  // in the REQUEST BODY, not as a request header — so reading it from the
  // headers meant this branch never fired for a real Gmail or Yahoo one-click
  // unsubscribe.
  const body = await c.req.text().catch(() => '')
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body)
  const ok = await unsubscribeUser(token)
  if (oneClick) return ok ? c.body(null, 204) : c.json({ error: 'Invalid unsubscribe token.' }, 400)
  return ok
    ? c.html(page('Unsubscribed', '<p>You will no longer receive Daily Brief email. You can turn it back on in forum Settings.</p>'))
    : c.html(page('Invalid link', '<p>This unsubscribe link is invalid.</p>'), 400)
})

legal.get('/terms', (c) =>
  c.html(
    page(
      'Terms of Service',
      `
<p>Welcome to <strong>forum</strong>, a political discussion app. By creating an account or using the app you agree to these terms.</p>

<h2>1. Your account</h2>
<p>You must provide accurate information and are responsible for activity on your account. You may use forum only if applicable law and any device, family, or App Store age restrictions permit you to do so. If the law where you live requires permission from a parent or guardian, you may use forum only with that permission. The signup screen asks you to agree to these Terms and the Privacy Policy. You can delete your account at any time from Settings; your account and app data are removed immediately and associated media is removed from active storage within 24 hours.</p>

<h2>2. Your content</h2>
<p>You own what you post. By posting you grant us a non-exclusive license to display your content inside the app (that's how a forum works). You are responsible for what you post.</p>

<h2>3. Rules</h2>
<p>Do not post: spam; harassment, threats, or bullying; hate speech; deliberately deceptive content presented as fact; pornographic or sexually explicit content; sexual content involving minors; illegal content; or other people's personal information. User submissions pass narrow safety rules operated by forum. If you explicitly allow OpenAI processing, text submissions also receive an additional check from OpenAI's moderation service. Without that permission, text posts, comments, direct messages, and profile edits remain available under forum's rules; image uploads and forumAI remain unavailable because those features require OpenAI processing. We may hide content, and suspend or ban accounts, that break these rules. Every piece of content has a Report action; reports are reviewed by moderators.</p>

<h2>4. Spectrum placements</h2>
<p>The app computes a political-lean placement for content and accounts from a deterministic, published scoring method (see the "Why this placement?" receipts on any score). Placements are estimates for discussion purposes, not statements of fact about you.</p>

<h2>5. forumAI</h2>
<p>forumAI answers are generated by an AI model presenting multiple political perspectives. They can be wrong. They are not professional, legal, or medical advice.</p>

<h2>6. News content</h2>
<p>Article headlines, publisher names, publication dates, preview images, and links are aggregated from news feeds and publisher pages and remain the property of their publishers. forum does not present copied article bodies as its own reporting. Tapping through opens the complete article at the original source.</p>

<h2>7. Disclaimers</h2>
<p>The service is provided "as is" without warranties. To the maximum extent permitted by law we are not liable for indirect or consequential damages arising from your use of the app. We may modify or discontinue features, and may update these terms — continued use after an update is acceptance.</p>
`
    )
  )
)

legal.get('/privacy', (c) =>
  c.html(
    page(
      'Privacy Policy',
      `
<p>This policy describes what <strong>forum</strong> collects and why. The short version: we collect what the product visibly needs, we don't sell it, and you can delete all of it yourself.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account:</strong> email address, username, password (stored as a scrypt hash — we can never read it), optional bio and profile images, account privacy setting, and follow requests.</li>
  <li><strong>Content and activity:</strong> your posts, comments, votes, bookmarks, debate stances, follows, and direct messages. If you use Daily Brief, forum keeps up to seven editions containing selected existing content references and grouped activity counts.</li>
  <li><strong>Search:</strong> the query you submit is used to return matching topics, posts, and articles. forum does not build a saved account search-history list, and URL query values are removed from server request logs.</li>
  <li><strong>Feed personalization:</strong> interests you choose, items shown in your feed, opens, approximate time visible, outbound publisher opens, and “Not interested” choices. These first-party signals are used to rank and diversify your feed; they are not used for advertising.</li>
  <li><strong>Computed data:</strong> a political-lean placement derived from your posts and votes by a deterministic algorithm. It exists only inside the app and is shown on your profile.</li>
  <li><strong>Device and diagnostics:</strong> a push-notification token if you enable notifications. Crash diagnostics may include app version, build, device model, operating-system version, and the screen where a problem occurred. We do not collect contacts or advertising identifiers. Uploaded photos have their metadata (including GPS EXIF) stripped on upload.</li>
  <li><strong>Feedback:</strong> feedback text, an optional screenshot, and the route, theme, app version/build, platform, OS, and device metadata attached to the report.</li>
</ul>

<h2>How it's used</h2>
<ul>
  <li>To operate the product: showing your content, computing placements, preparing the in-app Daily Brief, delivering notifications you opted into, and sending account emails (verification, password reset, optional Daily Brief).</li>
  <li><strong>Recommendations:</strong> forum locally creates numeric topic vectors from posts and article coverage, then combines them with your selected interests and in-app activity. Behavioral profiles are not sent to OpenAI or an advertising network. You can clear selected interests, viewing signals, and “Not interested” choices under Settings → Content → Reset feed personalization.</li>
  <li><strong>forumAI:</strong> if you explicitly allow OpenAI processing, your question, recent conversation context, eligible attributed publisher headlines, forum-generated story metadata, and relevant community-post context may be sent to OpenAI to generate the answer. Publisher article bodies are not stored or sent to OpenAI. Content from publishers with reviewed AI or automation restrictions is excluded from OpenAI context. Locally derived aggregate clustering signals may still help forum identify a covered topic, after which only eligible attributed headlines are supplied to OpenAI. These inputs are not used by forum to build an advertising profile.</li>
  <li><strong>Moderation:</strong> narrow safety rules run on forum's server first. If you explicitly allow OpenAI processing, profile text, posts, comments, direct messages, forumAI prompts, and uploaded images are also sent to OpenAI's moderation service. Signup usernames are checked only by forum's on-server rules. We store decision metadata and a one-way input hash for audit, not rejected raw content.</li>
  <li><strong>Product quality:</strong> structured feedback and crash diagnostics help us reproduce and fix problems.</li>
</ul>

<h2>Your OpenAI choice</h2>
<p>Before forum sends your personal data or user content to OpenAI, the app identifies OpenAI, explains the content and purposes involved, links to this policy, and asks you to allow or decline. Permission is versioned and recorded with the time of your decision. Existing users are not automatically opted in.</p>
<p>You may choose Not now and continue using browsing, text posts, comments, direct messages, profile editing, voting, saving, following, reporting, and blocking under forum's on-server safety rules. Image uploads, feedback screenshots, and forumAI require OpenAI processing for their image-safety or AI function and will ask again when needed. You can withdraw permission at any time under Settings → Privacy → OpenAI processing. Withdrawal stops new content from being sent; it does not reverse processing that occurred while permission was active.</p>

<h2>What we don't do</h2>
<ul>
  <li>No selling or renting personal data.</li>
  <li>No third-party advertising or tracking SDKs.</li>
  <li>No routine human reading of direct messages. forum's on-server rules process messages before delivery, and OpenAI provides an additional automated check only with your permission. A recipient can report a received message, in which case moderators may review that reported message and take action.</li>
</ul>

<h2>Service providers</h2>
<p>Infrastructure providers process data on our behalf: application hosting (Railway), database hosting (Neon), public and private image storage (Cloudflare R2), email delivery (Resend), push and build delivery (Expo), crash diagnostics (Sentry), TestFlight distribution (Apple), and AI responses and optional additional safety checks (OpenAI). Each receives only what its function requires. forum requires providers to protect personal data consistently with this policy and applicable privacy obligations and does not authorize them to use forum data for advertising.</p>

<h2>Retention and deletion</h2>
<p>Data is kept while your account exists, except Daily Brief editions, which rotate after seven days. Settings → Delete Account immediately removes your profile, posts, comments, votes, messages, Daily Brief editions, push tokens, and feedback text and metadata. Associated public media and private feedback screenshots are queued for deletion from active storage, retried on failure, and removed within 24 hours. Backups age out on a rolling basis.</p>

<h2>Your rights</h2>
<p>You can access and edit your profile in-app, export your content by request, and delete everything yourself. Contact us for anything else.</p>
`
    )
  )
)

export default legal
