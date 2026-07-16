#!/usr/bin/env node
/**
 * Forum API — automated production setup script
 * (local dev doesn't need this: createdb forum + psql -f schema.sql is enough)
 *
 * Run AFTER:
 *   neonctl auth
 *   wrangler login
 *   railway login
 *
 * What this does:
 *   1. Checks all 3 CLIs are authenticated
 *   2. Creates Neon project + gets connection string
 *   3. Creates Cloudflare R2 bucket + API token (S3-compatible credentials)
 *   4. Generates a JWT_SECRET (reuses the existing one so sessions survive)
 *      and prompts for an Anthropic API key (optional, powers /ai/chat)
 *   5. Writes .env
 *   6. Runs schema.sql against Neon
 *   7. Prints next steps
 */

import { randomBytes } from 'crypto'
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── terminal colours ─────────────────────────────────────────────────────────
const G  = '\x1b[32m'   // green
const R  = '\x1b[31m'   // red
const Y  = '\x1b[33m'   // yellow
const C  = '\x1b[36m'   // cyan
const RS = '\x1b[0m'    // reset
const B  = '\x1b[1m'    // bold

const ok   = (msg) => console.log(`${G}✓${RS} ${msg}`)
const fail = (msg) => console.error(`${R}✗${RS} ${msg}`)
const info = (msg) => console.log(`${C}→${RS} ${msg}`)
const warn = (msg) => console.log(`${Y}!${RS} ${msg}`)
const hdr  = (msg) => console.log(`\n${B}${msg}${RS}`)

// ── helpers ───────────────────────────────────────────────────────────────────
function capture(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

function tryCapture(cmd) {
  try { return capture(cmd) } catch { return null }
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

// Read a value from a simple key = "value" TOML file (no parser dependency)
function readTomlString(content, key) {
  const m = content.match(new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`))
  return m ? m[1] : null
}

// Safely parse JSON — returns null on failure
function tryJson(str) {
  try { return JSON.parse(str) } catch { return null }
}

// ── step 1: check CLIs ────────────────────────────────────────────────────────
function checkCLIs() {
  hdr('Step 1/6 — Checking CLIs')
  const missing = []
  for (const cli of ['neonctl', 'wrangler', 'railway']) {
    const path = tryCapture(`which ${cli}`)
    if (path) {
      ok(`${cli}  (${path})`)
    } else {
      fail(`${cli} not found`)
      missing.push(cli)
    }
  }
  if (missing.length) {
    console.log(`\nRun this first:\n  ${C}npm run setup:install${RS}\n`)
    process.exit(1)
  }
}

// ── step 2: neon ──────────────────────────────────────────────────────────────
async function setupNeon() {
  hdr('Step 2/6 — Neon database')

  // Verify auth
  const me = tryCapture('neonctl me --output json')
  if (!me) {
    fail('neonctl not authenticated')
    console.log(`\nRun:  ${C}neonctl auth${RS}\n`)
    process.exit(1)
  }
  const meData = tryJson(me)
  ok(`Authenticated as ${meData?.email ?? 'unknown'}`)

  // Try to create project; if it already exists, find it
  let projectId

  info('Creating Neon project "forum"...')
  const createOut = tryCapture('neonctl projects create --name forum --output json')
  if (createOut) {
    const data = tryJson(createOut)
    // neonctl may return { id } directly or { project: { id } }
    projectId = data?.id ?? data?.project?.id
    if (projectId) {
      ok(`Project created: ${projectId}`)
    }
  }

  if (!projectId) {
    warn('Could not create project (may already exist) — searching...')
    const listOut = tryCapture('neonctl projects list --output json')
    if (listOut) {
      const list = tryJson(listOut)
      // list may be an array or { projects: [] }
      const projects = Array.isArray(list) ? list : (list?.projects ?? [])
      const existing = projects.find(p => p.name === 'forum')
      if (existing) {
        projectId = existing.id
        ok(`Found existing project: ${projectId}`)
      }
    }
  }

  if (!projectId) {
    fail('Could not create or find a Neon project named "forum"')
    console.log('Try running:  neonctl projects create --name forum')
    process.exit(1)
  }

  // Get connection string
  info('Getting connection string...')
  let connStr = tryCapture(`neonctl connection-string --project-id ${projectId}`)

  if (!connStr) {
    fail('Could not retrieve connection string from neonctl')
    process.exit(1)
  }

  // Ensure sslmode=require is present (Neon usually includes it, but be safe)
  if (!connStr.includes('sslmode=require')) {
    connStr += connStr.includes('?') ? '&sslmode=require' : '?sslmode=require'
  }

  ok('Connection string obtained')
  return connStr
}

// ── step 3: cloudflare r2 ────────────────────────────────────────────────────
async function setupR2() {
  hdr('Step 3/6 — Cloudflare R2')

  // ── 3a: read wrangler OAuth token from disk ──────────────────────────────
  const candidates = [
    join(homedir(), '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.config', 'wrangler', 'config.toml'),
  ]
  let wranglerConfig = null
  for (const p of candidates) {
    if (existsSync(p)) { wranglerConfig = readFileSync(p, 'utf8'); break }
  }

  if (!wranglerConfig) {
    fail('wrangler not authenticated (config file not found)')
    console.log(`\nRun:  ${C}wrangler login${RS}\n`)
    process.exit(1)
  }

  const oauthToken = readTomlString(wranglerConfig, 'oauth_token')
  if (!oauthToken) {
    fail('Could not read oauth_token from wrangler config')
    console.log('Try:  wrangler logout  then  wrangler login')
    process.exit(1)
  }
  ok('wrangler authenticated')

  // ── 3b: get Cloudflare account ID via API ────────────────────────────────
  info('Fetching Cloudflare account ID...')
  const accountsResp = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: { Authorization: `Bearer ${oauthToken}` }
  })
  const accountsData = await accountsResp.json()

  if (!accountsData.success || !accountsData.result?.length) {
    fail('Could not fetch Cloudflare account — OAuth token may be expired')
    console.log('Run:  wrangler logout  then  wrangler login')
    process.exit(1)
  }

  const accountId   = accountsData.result[0].id
  const accountName = accountsData.result[0].name
  ok(`Account: ${accountName} (${accountId})`)

  // ── 3c: create R2 bucket ─────────────────────────────────────────────────
  info('Creating R2 bucket "forum-media"...')
  try {
    capture('wrangler r2 bucket create forum-media')
    ok('Bucket "forum-media" created')
  } catch (e) {
    const msg = e.stderr || e.message || ''
    if (msg.includes('already exists') || msg.includes('10006') || msg.includes('already created')) {
      warn('Bucket "forum-media" already exists — skipping')
    } else {
      fail('Failed to create R2 bucket')
      console.log(msg)
      process.exit(1)
    }
  }

  // ── 3d: create R2 API token for S3-compatible access ────────────────────
  // How this works:
  //   Cloudflare API tokens double as R2 S3 credentials:
  //     Access Key ID     = token.id
  //     Secret Access Key = token.value   (shown once at creation)
  //
  info('Fetching permission group IDs...')
  const pgResp = await fetch(
    'https://api.cloudflare.com/client/v4/user/tokens/permission_groups',
    { headers: { Authorization: `Bearer ${oauthToken}` } }
  )
  const pgData = await pgResp.json()

  if (!pgData.success) {
    fail('Could not fetch permission groups')
    console.log(JSON.stringify(pgData.errors))
    process.exit(1)
  }

  // Find the R2 read + write permission group IDs
  const allGroups = pgData.result ?? []
  const r2WriteGroup = allGroups.find(g => g.name === 'Workers R2 Storage Bucket Item Write')
  const r2ReadGroup  = allGroups.find(g => g.name === 'Workers R2 Storage Bucket Item Read')

  if (!r2WriteGroup || !r2ReadGroup) {
    const r2 = allGroups.filter(g => g.name.includes('R2')).map(g => `  ${g.name} (${g.id})`)
    warn('Expected permission group names not found. Available R2 groups:')
    r2.forEach(g => console.log(g))
    fail('Cannot create R2 token automatically')
    return await promptR2Credentials()
  }

  info('Creating R2 API token "forum-media"...')
  const tokenResp = await fetch('https://api.cloudflare.com/client/v4/user/tokens', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'forum-media',
      policies: [{
        effect: 'allow',
        resources: {
          [`com.cloudflare.api.account.${accountId}`]: '*',
        },
        permission_groups: [
          { id: r2WriteGroup.id },
          { id: r2ReadGroup.id },
        ],
      }],
    }),
  })
  const tokenData = await tokenResp.json()

  if (!tokenData.success) {
    warn('Automatic token creation failed:')
    console.log(JSON.stringify(tokenData.errors, null, 2))
    warn('Falling back to manual entry...')
    const creds = await promptR2Credentials()
    return { ...creds, accountId }
  }

  const accessKeyId     = tokenData.result.id
  const secretAccessKey = tokenData.result.value

  ok(`R2 API token created — Access Key ID: ${accessKeyId}`)

  return { accountId, accessKeyId, secretAccessKey }
}

// Fallback: ask user to paste R2 credentials manually (precise instructions)
async function promptR2Credentials() {
  console.log(`
${Y}Manual R2 credentials needed.${RS}
Follow these exact steps:

  1. Open: ${C}https://dash.cloudflare.com${RS}
  2. Click R2 in the left sidebar
  3. Click "Manage R2 API Tokens" (top right)
  4. Click "Create API Token"
  5. Name: forum-media
  6. Permissions: Object Read & Write
  7. Specify bucket: forum-media
  8. Click "Create API Token"
  9. Copy both values below
`)
  const accountId     = await prompt('Cloudflare Account ID (from URL bar — 32 hex chars): ')
  const accessKeyId   = await prompt('Access Key ID: ')
  const secretAccessKey = await prompt('Secret Access Key: ')
  return { accountId, accessKeyId, secretAccessKey }
}

// ── step 4: auth secret + AI key ─────────────────────────────────────────────
// Reuse the JWT secret from an existing .env so already-issued tokens stay
// valid; only mint a fresh one on first setup.
function resolveJwtSecret() {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^JWT_SECRET=(\S+)/m)
    if (m) {
      ok('Reusing existing JWT_SECRET (sessions stay valid)')
      return m[1]
    }
  }
  ok('Generated new JWT_SECRET')
  return randomBytes(32).toString('hex')
}

async function collectApiKeys() {
  hdr('Step 4/6 — Auth secret + Anthropic key')

  const jwtSecret = resolveJwtSecret()

  console.log(`
  Anthropic API key (optional — powers /ai/chat; leave blank to skip):
    ${C}https://console.anthropic.com/settings/api-keys${RS} → Create Key → copy the sk-ant-... value
`)
  const anthropicKey = await prompt('Paste Anthropic API Key (sk-ant-... or blank): ')

  if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
    warn("That doesn't look like an Anthropic key — double-check it starts with sk-ant-")
  }

  return { jwtSecret, anthropicKey }
}

// ── step 5: write .env ────────────────────────────────────────────────────────
function writeEnv({ connectionString, r2, jwtSecret, anthropicKey }) {
  hdr('Step 5/6 — Writing .env')

  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    warn('.env already exists — overwriting (JWT_SECRET is preserved)')
  }

  const content = [
    '# Neon Postgres',
    `DATABASE_URL=${connectionString}`,
    '',
    '# Auth — HMAC secret for signing JWTs',
    `JWT_SECRET=${jwtSecret}`,
    '',
    '# Cloudflare R2',
    `R2_ACCOUNT_ID=${r2.accountId}`,
    `R2_ACCESS_KEY_ID=${r2.accessKeyId}`,
    `R2_SECRET_ACCESS_KEY=${r2.secretAccessKey}`,
    'R2_BUCKET_NAME=forum-media',
    '# R2_PUBLIC_URL — set this after enabling public access on the bucket',
    'R2_PUBLIC_URL=',
    '',
    '# Anthropic — required for /ai/chat',
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    '',
    '# Server',
    'PORT=3000',
    'NODE_ENV=production',
    '',
  ].join('\n')

  writeFileSync(envPath, content, 'utf8')
  ok('.env written')
}

// ── step 6: run schema ────────────────────────────────────────────────────────
async function runSchema(connectionString) {
  hdr('Step 6/6 — Running database schema')

  const schemaPath = join(ROOT, 'schema.sql')
  if (!existsSync(schemaPath)) {
    fail(`schema.sql not found at ${schemaPath}`)
    process.exit(1)
  }

  info('Applying schema.sql to Neon...')
  try {
    // Use psql (confirmed installed via homebrew)
    execSync(`psql "${connectionString}" -f "${schemaPath}" -v ON_ERROR_STOP=1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    ok('Schema applied')
  } catch (e) {
    const stderr = e.stderr || ''
    // "already exists" errors are fine — schema uses IF NOT EXISTS
    if (stderr.includes('already exists') && !stderr.includes('ERROR')) {
      ok('Schema applied (some objects already existed — that\'s fine)')
    } else {
      fail('Schema failed')
      console.log(stderr || e.message)
      console.log(`\nRetry manually:\n  psql "$DATABASE_URL" -f schema.sql`)
      process.exit(1)
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${B}${C}Forum API — Automated Setup${RS}`)
  console.log('──────────────────────────────')

  checkCLIs()
  const connectionString = await setupNeon()
  const r2               = await setupR2()
  const { jwtSecret, anthropicKey } = await collectApiKeys()

  writeEnv({ connectionString, r2, jwtSecret, anthropicKey })
  await runSchema(connectionString)

  console.log(`
${B}${G}Setup complete!${RS}

${B}Verify locally:${RS}
  ${C}npm run dev${RS}
  ${C}curl http://localhost:3000/health${RS}
  ${C}curl http://localhost:3000/topics${RS}

${B}Deploy to Railway:${RS}
  Make sure you ran ${C}railway login${RS}, then:
  ${C}railway init${RS}        ← link this folder to a Railway project (one-time)
  ${C}railway variables set$(cat .env | grep -v '^#' | grep '=' | awk '{print " " $0}' | tr '\n' ' ')${RS}
  ${C}railway up${RS}
`)
}

main().catch(e => {
  console.error(`\n${R}Setup failed:${RS}`, e.message)
  process.exit(1)
})
