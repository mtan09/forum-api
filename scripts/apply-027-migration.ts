import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pool from '../src/db'

const file = fileURLToPath(new URL('../migrations/027-daily-brief.sql', import.meta.url))

async function main() {
  await pool.query(await readFile(file, 'utf8'))
  console.log('Migration 027 applied: Daily Brief storage and preferences are ready.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => pool.end())
