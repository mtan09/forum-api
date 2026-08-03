import 'dotenv/config'
import pool from '../src/db'

const apply = process.env.DEMO_ACCOUNT_DELETE === 'DELETE_FICTIONAL_DEMO_ACCOUNTS'

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const summary = await client.query(
      `SELECT
         count(*)::int AS accounts,
         (SELECT count(*)::int FROM posts p JOIN userdata u ON u.id = p.user_id WHERE u.is_demo) AS posts,
         (SELECT count(*)::int FROM comments c JOIN userdata u ON u.id = c.user_id WHERE u.is_demo) AS comments,
         (SELECT count(*)::int FROM debate_votes v JOIN userdata u ON u.id = v.user_id WHERE u.is_demo) AS floor_votes
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
    await client.query('COMMIT')
    console.log(`Deleted ${accounts.rows.length} fictional demo account(s) and cascaded activity.`)
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
