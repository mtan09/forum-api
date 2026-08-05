import 'dotenv/config'
import pool from '../src/db'

const apply = process.env.DEMO_ACCOUNT_DELETE === 'DELETE_FICTIONAL_DEMO_ACCOUNTS'

async function main() {
  if (apply && process.env.DEMO_ACTIVITY_ENABLED === 'yes') {
    throw new Error('Disable DEMO_ACTIVITY_ENABLED before applying demo cleanup.')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('forum-demo-activity'))")
    await client.query(
      `CREATE TEMP TABLE demo_article_targets ON COMMIT DROP AS
       SELECT DISTINCT c.article_id
       FROM comments c JOIN userdata u ON u.id = c.user_id
       WHERE u.is_demo AND c.article_id IS NOT NULL
       UNION
       SELECT DISTINCT v.article_id
       FROM article_votes v JOIN userdata u ON u.id = v.user_id
       WHERE u.is_demo`
    )
    const summary = await client.query(
      `SELECT
         count(*)::int AS accounts,
         (SELECT count(*)::int FROM posts p JOIN userdata u ON u.id = p.user_id WHERE u.is_demo) AS posts,
         (SELECT count(*)::int FROM comments c JOIN userdata u ON u.id = c.user_id WHERE u.is_demo) AS comments,
         (SELECT count(*)::int FROM votes v JOIN userdata u ON u.id = v.user_id WHERE u.is_demo) AS post_votes,
         (SELECT count(*)::int FROM article_votes v JOIN userdata u ON u.id = v.user_id WHERE u.is_demo) AS article_votes,
         (SELECT count(*)::int FROM comments c JOIN userdata u ON u.id = c.user_id WHERE u.is_demo AND c.article_id IS NOT NULL) AS article_comments,
         (SELECT count(*)::int FROM comment_votes v JOIN userdata u ON u.id = v.user_id WHERE u.is_demo) AS comment_votes,
         (SELECT count(*)::int FROM debate_votes v JOIN userdata u ON u.id = v.user_id WHERE u.is_demo) AS floor_votes,
         (SELECT count(*)::int FROM demo_activity_jobs) AS jobs,
         (SELECT count(*)::int FROM demo_article_targets) AS affected_articles
       FROM userdata WHERE is_demo = TRUE`
    )
    const accounts = await client.query(
      `SELECT id, username FROM userdata WHERE is_demo = TRUE ORDER BY username FOR UPDATE`
    )
    console.log(JSON.stringify({ apply, ...summary.rows[0], usernames: accounts.rows.map((row) => row.username) }, null, 2))

    if (!apply) {
      await client.query('ROLLBACK')
      console.log('Dry run only. Set DEMO_ACCOUNT_DELETE=DELETE_FICTIONAL_DEMO_ACCOUNTS to delete.')
      return
    }

    await client.query('DELETE FROM userdata WHERE is_demo = TRUE')
    await client.query(
      `UPDATE articles article
       SET upvotes = (
             SELECT count(*) FROM article_votes vote
             WHERE vote.article_id = article.id AND vote.direction = 'up'
           ),
           downvotes = (
             SELECT count(*) FROM article_votes vote
             WHERE vote.article_id = article.id AND vote.direction = 'down'
           ),
           commentcount = (
             SELECT count(*) FROM comments comment
             WHERE comment.article_id = article.id
           )
       FROM demo_article_targets target
       WHERE article.id = target.article_id`
    )
    await client.query('COMMIT')
    console.log(
      `Deleted ${accounts.rows.length} fictional demo account(s), cascaded their activity, ` +
      `and reconciled ${summary.rows[0].affected_articles} affected article counter(s).`
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Could not clean up demo accounts:', error)
  process.exitCode = 1
})
