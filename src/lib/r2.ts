import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function configured(bucket: string | undefined) {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    bucket
  )
}

export function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

export function publicStorageConfigured() {
  return configured(process.env.R2_BUCKET_NAME)
}

export function feedbackStorageConfigured() {
  return configured(process.env.R2_FEEDBACK_BUCKET_NAME)
}

export async function putFeedbackObject(key: string, body: Buffer, contentType: string) {
  if (!feedbackStorageConfigured()) throw new Error('Private feedback storage is not configured')
  await r2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_FEEDBACK_BUCKET_NAME!,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  )
}

export async function signedFeedbackUrl(key: string, expiresIn = 300) {
  if (!feedbackStorageConfigured()) throw new Error('Private feedback storage is not configured')
  return getSignedUrl(
    r2Client(),
    new GetObjectCommand({ Bucket: process.env.R2_FEEDBACK_BUCKET_NAME!, Key: key }),
    { expiresIn }
  )
}

export async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  if (!configured(bucket)) throw new Error(`R2 bucket for prefix ${prefix} is not configured`)
  const client = r2Client()
  let continuationToken: string | undefined
  let deleted = 0
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )
    const keys = (listed.Contents ?? []).flatMap((item) =>
      item.Key ? [{ Key: item.Key }] : []
    )
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        })
      )
      deleted += keys.length
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)
  return deleted
}

export async function deletePublicObject(key: string): Promise<void> {
  if (!publicStorageConfigured()) {
    throw new Error(`Public R2 storage is not configured for ${key}`)
  }
  await r2Client().send(
    new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key })
  )
}
