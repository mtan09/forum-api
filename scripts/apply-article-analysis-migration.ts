import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pool from '../src/db'

async function main() {
  const filename = '018-article-evidence-media.sql'
  const sql = await readFile(join(process.cwd(), 'migrations', filename), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
    console.log(`Applied ${filename}`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Article analysis migration failed:', error)
  process.exitCode = 1
})

