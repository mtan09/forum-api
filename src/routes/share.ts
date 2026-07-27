import { Hono } from 'hono'
import { query } from '../db'

// Public share pages. Every share link out of the app points here, so a
// tap from iMessage/X/etc lands on a page with real OG preview tags, an
// "Open in forum" deep link (forum:// scheme), and a get-the-app pitch.
// This doubles as the product's minimal web presence at GET /.
const share = new Hono()

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(opts: {
  title: string
  description: string
  image?: string | null
  deepLink?: string
  body: string
}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
${opts.image ? `<meta property="og:image" content="${esc(opts.image)}">` : ''}
<meta property="og:site_name" content="forum">
<meta name="twitter:card" content="${opts.image ? 'summary_large_image' : 'summary'}">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px;
         margin: 0 auto; padding: 40px 20px; line-height: 1.6; }
  .brand { color: #B647FF; font-weight: 800; font-size: 28px; margin-bottom: 24px; }
  .card { border: 1px solid rgba(182,71,255,0.3); border-radius: 16px; padding: 20px; margin-bottom: 24px; }
  .btn { display: inline-block; background: #B647FF; color: #fff; padding: 14px 28px;
         border-radius: 14px; text-decoration: none; font-weight: 800; }
  .muted { opacity: 0.6; font-size: 14px; margin-top: 16px; }
  img.media { max-width: 100%; border-radius: 12px; margin-top: 12px; }
</style></head><body>
<div class="brand">forum</div>
${opts.body}
${opts.deepLink ? `<a class="btn" href="${esc(opts.deepLink)}">Open in forum</a>` : ''}
<p class="muted">forum — the political discussion app where you see the whole spectrum, not just your side. Every post is placed on a left–right spectrum by a transparent, deterministic scorer.</p>
</body></html>`
}

// GET / — minimal product landing page
share.get('/', (c) =>
  c.html(
    page({
      title: 'forum — see the whole spectrum',
      description:
        'A political discussion app where every post and article shows where it sits on the spectrum — scored transparently, no black box.',
      body: `<div class="card">
        <h2 style="margin-top:0">See the whole conversation.</h2>
        <p>One feed with every side of the story: real news from ~59 outlets across the spectrum, community debate, daily stance rooms, and an AI that answers from the left, center, and right — every time.</p>
      </div>`,
      deepLink: 'forum://',
    })
  )
)

// Public App Store support URL. This remains useful inside the beta even
// before a branded domain is selected.
share.get('/support', (c) => {
  const email =
    process.env.SUPPORT_EMAIL ??
    process.env.LEGAL_CONTACT_EMAIL ??
    'michael.tan0953@gmail.com'
  return c.html(
    page({
      title: 'forum support',
      description: 'Account, beta, and troubleshooting help for forum.',
      body: `<div class="card">
        <h2 style="margin-top:0">How can we help?</h2>
        <p><strong>Beta feedback:</strong> use Settings → Send Beta Feedback to include your app version and an optional screenshot, or use TestFlight’s Send Beta Feedback action after taking a screenshot.</p>
        <p><strong>Account deletion:</strong> open Settings → Delete Account. Your account data is removed immediately and associated media is cleared from active storage within 24 hours.</p>
        <p><strong>Login or email trouble:</strong> confirm you have a network connection, request one new verification/reset message, then check spam. Only the newest verification link or reset code remains valid.</p>
        <p><strong>Crashes or blank screens:</strong> relaunch the app, note the screen and action that caused it, then send beta feedback. Include a screenshot when possible.</p>
        <p>Email: <a href="mailto:${esc(email)}">${esc(email)}</a></p>
        <p><a href="/legal/privacy">Privacy Policy</a> · <a href="/legal/terms">Terms of Service</a></p>
      </div>`,
    })
  )
})

// GET /p/:id — a shared post
share.get('/p/:id', async (c) => {
  const result = await query(
    `SELECT p.id, p.content, p.media_url, p.position, u.username
     FROM posts p JOIN userdata u ON u.id = p.user_id
     WHERE p.id::text = $1 AND NOT p.hidden`,
    [c.req.param('id')]
  )
  const row = result.rows[0]
  if (!row) return c.html(page({ title: 'Post not found — forum', description: '', body: '<p>This post is no longer available.</p>', deepLink: 'forum://' }), 404)

  const text = String(row.content ?? '')
  return c.html(
    page({
      title: `${row.username} on forum`,
      description: text.slice(0, 160),
      image: row.media_url,
      deepLink: `forum://post/${row.id}`,
      body: `<div class="card">
        <strong>${esc(row.username)}</strong>
        <p>${esc(text.slice(0, 500))}</p>
        ${row.media_url ? `<img class="media" src="${esc(row.media_url)}" alt="">` : ''}
      </div>`,
    })
  )
})

// GET /a/:id — a shared article
share.get('/a/:id', async (c) => {
  const result = await query(
    `SELECT id, title, source, media FROM articles WHERE id::text = $1 AND status = 'ready'`,
    [c.req.param('id')]
  )
  const row = result.rows[0]
  if (!row) return c.html(page({ title: 'Article not found — forum', description: '', body: '<p>This article is no longer available.</p>', deepLink: 'forum://' }), 404)

  return c.html(
    page({
      title: `${row.title} — via forum`,
      description: `${row.source} coverage, with spectrum context on forum.`,
      image: row.media,
      deepLink: `forum://article/${row.id}`,
      body: `<div class="card">
        <strong>${esc(row.source ?? '')}</strong>
        <h2 style="margin:8px 0 0">${esc(row.title ?? '')}</h2>
        ${row.media ? `<img class="media" src="${esc(row.media)}" alt="">` : ''}
      </div>`,
    })
  )
})

export default share
