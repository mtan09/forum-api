// Read-only comparison of stored post placements against the current scorer.
// Usage: npm run audit:posts
//        npm run audit:posts -- --details

import 'dotenv/config'
import pool, { query } from '../db'
import { demoPerspective } from '../demo/activity'
import { POST_SCORING_EVALUATION } from './evaluation-corpus'
import { POST_SCORER_VERSION, scorePost } from './score'

type Band = 'left' | 'center' | 'right' | 'unclassified'

type PostRow = {
  username: string
  content: string | null
  position: number | null
  scorer_version: string | null
  is_demo_generated: boolean
  persona_lean: number | null
}

const band = (position: number | null): Band => {
  if (position == null) return 'unclassified'
  if (position < 0.45) return 'left'
  if (position > 0.55) return 'right'
  return 'center'
}

const emptyCounts = (): Record<Band, number> => ({
  left: 0,
  center: 0,
  right: 0,
  unclassified: 0,
})

function evaluationMetrics() {
  const results = POST_SCORING_EVALUATION.map((entry) => ({
    expected: entry.label,
    actual: band(scorePost(entry.text).position),
  }))
  const directional = results.filter((entry) => entry.expected === 'left' || entry.expected === 'right')
  const neutral = results.filter((entry) => entry.expected === 'unclassified')
  const center = results.filter((entry) => entry.expected === 'center')
  return {
    cases: results.length,
    directional_accuracy: directional.filter((entry) => entry.actual === entry.expected).length / directional.length,
    center_accuracy: center.filter((entry) => entry.actual === 'center').length / center.length,
    neutral_false_placement_rate: neutral.filter((entry) => entry.actual !== 'unclassified').length / neutral.length,
  }
}

async function main() {
  const { rows } = await query(
    `SELECT u.username, p.content, p.position, p.scorer_version,
            p.is_demo_generated, dp.lean AS persona_lean
     FROM posts p
     JOIN userdata u ON u.id = p.user_id
     LEFT JOIN demo_personas dp ON dp.user_id = p.user_id
     WHERE NOT p.hidden
     ORDER BY p.created_at DESC`
  )

  const posts = rows as PostRow[]
  const stored = emptyCounts()
  const proposed = emptyCounts()
  let newlyClassified = 0
  let newlyUnclassified = 0
  let changedBand = 0
  let demoDirectional = 0
  let demoDirectionMatches = 0

  const details = posts.map((post) => {
    const score = scorePost(post.content ?? '')
    const currentBand = band(post.position == null ? null : Number(post.position))
    const proposedBand = band(score.position)
    stored[currentBand]++
    proposed[proposedBand]++
    if (currentBand === 'unclassified' && proposedBand !== 'unclassified') newlyClassified++
    if (currentBand !== 'unclassified' && proposedBand === 'unclassified') newlyUnclassified++
    if (currentBand !== proposedBand && currentBand !== 'unclassified' && proposedBand !== 'unclassified') changedBand++

    if (post.is_demo_generated && post.persona_lean != null) {
      const expected = demoPerspective(Number(post.persona_lean))
      if (expected !== 'center') {
        demoDirectional++
        if (proposedBand === expected) demoDirectionMatches++
      }
    }

    return {
      author: post.username,
      stored: post.position == null ? '—' : Number(post.position).toFixed(3),
      proposed: score.position == null ? '—' : score.position.toFixed(3),
      currentBand,
      proposedBand,
      version: post.scorer_version ?? 'none',
      evidence: score.signals.filter((signal) => /^(stance-|left:|right:)/.test(signal)).join('; '),
      post: (post.content ?? '').length > 160
        ? `${(post.content ?? '').slice(0, 157)}…`
        : (post.content ?? ''),
    }
  })

  console.log(JSON.stringify({
    scorer: POST_SCORER_VERSION,
    visible_posts: posts.length,
    stored,
    proposed,
    transitions: { newly_classified: newlyClassified, newly_unclassified: newlyUnclassified, changed_band: changedBand },
    generated_demo_direction: {
      directional_posts: demoDirectional,
      matches: demoDirectionMatches,
      rate: demoDirectional > 0 ? demoDirectionMatches / demoDirectional : null,
    },
    evaluation: evaluationMetrics(),
  }, null, 2))

  if (process.argv.includes('--details')) {
    const selected = process.argv.includes('--missing')
      ? details.filter((entry) => entry.proposedBand === 'unclassified')
      : process.argv.includes('--changed')
        ? details.filter((entry) => entry.currentBand !== entry.proposedBand)
      : details
    console.table(selected)
  }
}

main()
  .catch((err) => {
    console.error('[audit:posts] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
