import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pool from '../src/db'

const file = fileURLToPath(new URL('../migrations/026-reposts-and-quotes.sql', import.meta.url))

async function main() {
  const sql = await readFile(file, 'utf8')
  await pool.query(sql)
  console.log('Migration 026 applied: reposts and quote-post references are ready.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
