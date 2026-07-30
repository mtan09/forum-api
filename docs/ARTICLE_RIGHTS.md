# Article processing, provenance, and media policy

forum is a social news-context product. It attributes and links publisher
reporting, uses transient analysis to organize coverage, and does not provide a
replacement full-article reader.

The executable source registry is
[`src/ingest/source-rights.ts`](../src/ingest/source-rights.ts). It records the
publisher-policy review status and terms note separately from the runtime
acquisition, public-text, internal-analysis, forumAI, and image modes.

## Runtime modes

| Field | Modes |
|---|---|
| Acquisition | `feed_metadata`, `feed_text`, `full_page`, `disabled` |
| Public text | `headline_only`, `feed_description`, `full_text` |
| Internal analysis | `metadata_only`, `feed_text_transient`, `full_page_transient` |
| forumAI | `metadata_only`, `structured_evidence`, `permitted_text`, `denied` |
| Images | `none`, `remote_no_cache`, `managed_thumbnail`, `licensed_cache` |

Curated sources currently use `full_page_transient`,
`structured_evidence`, and `managed_thumbnail`, with the publisher remaining
the destination for the complete article. A missing registry entry is
metadata-only with a remote-preview fallback.

## Text-processing boundary

The pre-conservative extractor behavior was restored selectively from Git
commit `29b905f`:

1. Prefer a substantial RSS body.
2. Otherwise fetch the publisher page with a 15-second timeout and readability
   extraction.
3. Reject obvious video-playlist chrome.
4. Use the transient text for deterministic political relevance, lean,
   content-type scoring, topic matching, and evidence extraction.
5. Persist compact structured evidence, then release the text.

`articles.content` is always `NULL` for the current policy version. Raw text
must never be written to Postgres, R2, logs, Sentry, analytics, public/admin
responses, or forumAI prompts after ingestion. `article_evidence` stores only:

- a one-way source-text hash and word count;
- an original short evidence summary;
- attributed claims, timeline facts, entity relationships, and disputed points;
- entities, event terms, search text, extraction method, confidence, and
  generator/version metadata.

OpenAI evidence extraction is optional and daily-capped. Missing credentials,
cap exhaustion, malformed model output, or provider failure produces
deterministic metadata evidence and does not drop the article.

## Image boundary

The extractor restores feed-image-first/page-image-fallback selection and keeps
the source-independent malformed URL guard that fixed The Hill's encoded
caption failures.

`managed_thumbnail`:

- downloads at most 15 MB with a 12-second timeout;
- requires an image content type and successful Sharp decoding;
- rotates correctly and strips source metadata;
- stores only 640px and 1280px WebP variants under
  `articles/<article-id>/...`;
- records the publisher image URL, source hash, original dimensions, cache
  time, expiry, and status;
- falls back to `remote_no_cache` when download, decoding, R2, or configuration
  fails.

The client disk-caches only managed/licensed variants. Remote fallbacks use no
disk cache. Summary carousels label the publisher and open the associated
publisher URL. `npm run expire:article-images` is dry-run by default; an admin
can also purge one article immediately through
`POST /admin/articles/:id/purge-media`.

## Feature flags and cost controls

```dotenv
ARTICLE_TRANSIENT_ANALYSIS_ENABLED=true
ARTICLE_STRUCTURED_EVIDENCE_ENABLED=true
ARTICLE_ANALYSIS_MODEL=gpt-5.4-nano
ARTICLE_ANALYSIS_DAILY_LIMIT=500
ARTICLE_MANAGED_IMAGES_ENABLED=true
ARTICLE_IMAGE_CACHE_DAYS=30
```

Turning off transient analysis keeps ingestion alive with metadata evidence.
Turning off managed images preserves remote previews. The ingest run records
AI-evidence/fallback and managed-image/fallback totals for monitoring.

## Staged database rollout

Migration 018 is additive except for expanding existing mode constraints.
Validate code and migration before processing old rows:

```bash
npm run migrate:article-analysis
npm run verify:article-analysis
npm run backfill:article-evidence
```

The backfill command is a read-only preview unless explicitly enabled:

```bash
ARTICLE_BACKFILL_LIMIT=50 \
ARTICLE_BACKFILL_DAYS=14 \
APPLY_ARTICLE_ANALYSIS_BACKFILL=true \
npm run backfill:article-evidence
```

Run small recent-first batches. The backfill ignores legacy rows below the
political-relevance gate, rescores each selected article while transient text
is available, then transactionally writes evidence/media, sets
`articles.content` to `NULL`, and moves the row to the current policy. Then:

```bash
npm run verify:article-analysis
npm run rescore
npm run cluster
```

Image expiry is also dry-run first:

```bash
npm run expire:article-images
APPLY_ARTICLE_IMAGE_EXPIRY=true npm run expire:article-images
```

Do not run the older blanket cleanup before evidence coverage and regenerated
clusters are verified.

## Review and source changes

Changing a source still requires an updated review date, terms URL/note,
policy-version bump, and tests. Keep publisher text, image, AI-processing, and
cache decisions separate. The status is a risk record; do not describe a
conservative engineering choice as an Apple App Store requirement.
