import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import {
  deletePrefix,
  putFeedbackObject,
  signedFeedbackUrl,
} from '../src/lib/r2'

async function main() {
  const prefix = `release-probes/${randomUUID()}/`
  const key = `${prefix}private.txt`
  const expected = Buffer.from('forum private feedback storage probe')
  try {
    await putFeedbackObject(key, expected, 'text/plain')
    const url = await signedFeedbackUrl(key, 60)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Signed download returned ${response.status}`)
    const actual = Buffer.from(await response.arrayBuffer())
    if (!actual.equals(expected)) throw new Error('Signed download content did not match')
    console.log('Private feedback upload and signed download verified')
  } finally {
    const deleted = await deletePrefix(process.env.R2_FEEDBACK_BUCKET_NAME!, prefix)
    if (deleted !== 1) throw new Error(`Expected to remove one probe object; removed ${deleted}`)
    console.log('Private feedback cleanup verified')
  }
}

main().catch((err) => {
  console.error('Private feedback storage verification failed:', err)
  process.exitCode = 1
})
