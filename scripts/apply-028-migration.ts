import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pool from '../src/db'

const file = fileURLToPath(new URL('../migrations/028-daily-brief-delivery-index.sql', import.meta.url))

async function main() {
  await pool.query(await readFile(file, 'utf8'))
  console.log('Migration 028 applied: Daily Brief delivery predicate is indexed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => pool.end())
