import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pool from '../src/db'

async function main() {
  const filename = '017-ai-consent-push-receipts.sql'
  const sql = await readFile(join(process.cwd(), 'migrations', filename), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
    console.log(`Applied ${filename}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exitCode = 1
})
