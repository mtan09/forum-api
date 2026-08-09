import { query } from '../db'
import { briefPath } from './notification-routes'
import { dailyBriefUnsubscribeToken } from './brief-unsubscribe'
import { type DailyBrief, generateDailyBrief, validTimezone } from './daily-brief'
import { sendEmail } from './email'
import { sendPushToUser } from './push'
import { captureException, captureMessage } from './sentry'

/** Give up on an edition after this many failed sends on a channel. */
const MAX_DELIVERY_ATTEMPTS = 4

const escape = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const countLine = (count: number, singular: string, plural = `${singular}s`) =>
  count > 0 ? `<li>${count} ${count === 1 ? singular : plural}</li>` : ''

export function dailyBriefEmail(
  brief: DailyBrief,
  webBase: string,
  unsubscribeUrl: string
): { subject: string; html: string; headers: Record<string, string> } {
  const briefUrl = `${webBase}${briefPath(brief.brief_date)}`
  const stories = brief.stories.map((story) =>
    `<li style="margin:0 0 12px"><a href="${webBase}/summary/${story.id}" style="color:#B647FF;font-weight:700;text-decoration:none">${escape(story.title)}</a><br><span style="color:#666;font-size:13px">${Number(story.outlet_count ?? 0)} outlets · ${Number(story.article_count ?? 0)} articles</span></li>`
  ).join('')
  const post = brief.posts[0]
  const floor = brief.floor[0]
  const a = brief.activity
  const activity = [
    countLine(a.replies, 'reply', 'replies'), countLine(a.comments, 'comment'),
    countLine(a.post_upvotes + a.comment_upvotes, 'new upvote'), countLine(a.reposts, 'repost'),
    countLine(a.quotes, 'quote'), countLine(a.followers, 'new follower'),
    countLine(a.follow_requests, 'follow request'), countLine(a.unread_dms, 'unread message'),
  ].join('')
  return {
    subject: `Your forum Daily Brief — ${brief.brief_date}`,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#171717">
      <h1 style="color:#B647FF;font-size:28px;margin:0 0 4px">forum</h1>
      <p style="color:#666;margin:0 0 24px">Your morning Daily Brief</p>
      ${stories ? `<h2 style="font-size:18px">Across forum</h2><ol style="padding-left:22px">${stories}</ol>` : ''}
      ${post ? `<h2 style="font-size:18px">Worth reading</h2><p><a href="${webBase}/post/${post.id}" style="color:#B647FF;text-decoration:none;font-weight:700">${escape(post.username)}</a>: ${escape(String(post.content ?? '').slice(0, 180))}</p>` : ''}
      ${floor ? `<h2 style="font-size:18px">On The Floor</h2><p><a href="${webBase}/debate/${floor.id}" style="color:#B647FF;text-decoration:none;font-weight:700">${escape(floor.title)}</a></p>` : ''}
      ${activity ? `<h2 style="font-size:18px">Around you</h2><ul>${activity}</ul>` : ''}
      <p style="margin-top:24px"><a href="${briefUrl}" style="display:inline-block;background:#B647FF;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:700">Open your Daily Brief</a></p>
      <p style="font-size:12px;color:#777;margin-top:28px">You opted into Daily Brief email in forum Settings. <a href="${unsubscribeUrl}" style="color:#777">Unsubscribe from this email</a>.</p>
    </div>`,
  }
}

/** Exported for tests: the gating matrix and both dedupe claims live here. */
export async function deliverBrief(userId: string, brief: DailyBrief): Promise<void> {
  const prefs = await query(
    `SELECT p.push_enabled, p.email_enabled, p.push_daily_brief, p.email_daily_brief,
            a.email, a.email_verified, b.emailed_at, b.pushed_at
     FROM notification_prefs p JOIN auth_credentials a ON a.user_id = p.user_id
     JOIN daily_briefs b ON b.user_id = p.user_id AND b.id = $2
     WHERE p.user_id = $1`,
    [userId, brief.id]
  )
  const row = prefs.rows[0]
  if (!row) return
  let error: string | null = null
  const webBase = (process.env.WEB_APP_URL ?? 'https://forumeveryside.com').replace(/\/$/, '')

  if (row.email_enabled && row.email_daily_brief && row.email_verified && row.email) {
    // Claim the send before making it. Reading `emailed_at` and writing it
    // after the await is a race: the job takes longer than its 15-minute cron
    // period at a few hundred users, and any overlapping run — a manual
    // invocation, a redeploy — re-selects the not-yet-emailed tail and sends
    // a second copy. `UNIQUE (user_id, brief_date)` guarantees one brief row,
    // not one email.
    const claim = await query(
      `UPDATE daily_briefs SET emailed_at = NOW(), email_attempts = email_attempts + 1
       WHERE id = $1 AND emailed_at IS NULL RETURNING id`,
      [brief.id]
    )
    if (claim.rowCount) {
      try {
        const token = dailyBriefUnsubscribeToken(userId)
        const unsubscribe = `${process.env.PUBLIC_API_URL ?? webBase}/legal/unsubscribe-daily-brief?token=${encodeURIComponent(token)}`
        await sendEmail({ to: row.email, ...dailyBriefEmail(brief, webBase, unsubscribe) })
      } catch (err: any) {
        error = String(err?.message ?? err)
        // Release the claim so it retries. The `due` query bounds this by
        // email_attempts, so a hard bounce stops instead of retrying every
        // 15 minutes until the edition is pruned.
        await query(
          `UPDATE daily_briefs SET emailed_at = NULL, last_delivery_error = $2 WHERE id = $1`,
          [brief.id, error.slice(0, 500)]
        )
        captureException(err, { component: 'daily-brief-email', user_id: userId })
      }
    }
  }

  if (row.push_enabled && row.push_daily_brief) {
    const claim = await query(
      `UPDATE daily_briefs SET pushed_at = NOW(), push_attempts = push_attempts + 1
       WHERE id = $1 AND pushed_at IS NULL RETURNING id`,
      [brief.id]
    )
    if (claim.rowCount) {
      try {
        const total = Object.values(brief.activity).reduce((sum, value) => sum + Number(value), 0)
        const accepted = await sendPushToUser(userId, 'daily_brief', {
          title: 'Your forum Daily Brief is ready',
          body: total > 0 ? `${brief.stories.length} top stories and ${total} updates around you.` : `${brief.stories.length} top stories and today’s Floor discussions.`,
          data: { url: briefPath(brief.brief_date) },
        })
        // sendPushToUser never throws: no registered tokens, a 502 from Expo
        // and a rejected ticket all return normally. Without checking the
        // count the brief is marked pushed when nothing was delivered, the
        // `due` query stops selecting it, and the user silently gets nothing.
        if (accepted === 0) {
          error = 'no push accepted by Expo (no live tokens or upstream failure)'
          await query(
            `UPDATE daily_briefs SET pushed_at = NULL, last_delivery_error = $2 WHERE id = $1`,
            [brief.id, error]
          )
        }
      } catch (err: any) {
        error = String(err?.message ?? err)
        await query(
          `UPDATE daily_briefs SET pushed_at = NULL, last_delivery_error = $2 WHERE id = $1`,
          [brief.id, error.slice(0, 500)]
        )
        captureException(err, { component: 'daily-brief-push', user_id: userId })
      }
    }
  }

  if (!error) await query('UPDATE daily_briefs SET last_delivery_error = NULL WHERE id = $1', [brief.id])
}

export async function processDailyBriefDeliveries(limit = 100): Promise<number> {
  if (process.env.DAILY_BRIEF_ENABLED === 'no') return 0
  const due = await query(
    `SELECT p.user_id, p.timezone
     FROM notification_prefs p
     JOIN auth_credentials a ON a.user_id = p.user_id
     LEFT JOIN daily_briefs b ON b.user_id = p.user_id
       AND b.brief_date = (NOW() AT TIME ZONE p.timezone)::date
     WHERE p.timezone IS NOT NULL
       AND (NOW() AT TIME ZONE p.timezone)::time >= time '07:00'
       -- Attempt caps bound retries. A hard-bounced address would otherwise be
       -- re-selected every 15 minutes until the edition ages out — 672 sends
       -- and 672 Sentry events for one brief, while occupying a batch slot
       -- ahead of users who would have received theirs.
       AND ((p.email_enabled AND p.email_daily_brief AND a.email_verified
             AND b.emailed_at IS NULL AND COALESCE(b.email_attempts, 0) < $2)
         OR (p.push_enabled AND p.push_daily_brief
             AND b.pushed_at IS NULL AND COALESCE(b.push_attempts, 0) < $2))
     ORDER BY b.generated_at NULLS FIRST, p.user_id
     LIMIT $1`, [limit, MAX_DELIVERY_ATTEMPTS]
  )
  let processed = 0
  for (const row of due.rows) {
    const timezone = validTimezone(row.timezone)
    if (!timezone) continue
    try {
      const brief = await generateDailyBrief(row.user_id, timezone)
      if (brief) {
        await deliverBrief(row.user_id, brief)
        processed++
      }
    } catch (err) {
      captureException(err, { component: 'daily-brief-worker', user_id: row.user_id })
    }
  }
  if (due.rows.length >= limit) captureMessage('Daily Brief worker reached batch limit', 'warning', { limit })
  return processed
}
