import 'dotenv/config'
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { r2Client } from '../src/lib/r2'

async function main() {
  const bucket = process.env.R2_FEEDBACK_BUCKET_NAME ?? 'forum-feedback-private'
  const client = r2Client()
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    console.log(`Private feedback bucket already exists: ${bucket}`)
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    console.log(`Created private feedback bucket: ${bucket}`)
  }
}

main().catch((err) => {
  console.error('Could not provision private feedback bucket:', err)
  process.exitCode = 1
})
