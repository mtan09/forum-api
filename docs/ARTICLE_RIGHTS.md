# Article rights and metadata policy

forum is a link-and-context product. Publisher access is controlled separately
for discovery, text analysis, public display, AI grounding, and images.
Availability through RSS or HTML is never treated as a blanket reuse license.

The executable registry is
[`src/ingest/source-rights.ts`](../src/ingest/source-rights.ts). It records a
review date, policy status, terms URL, note, and the active modes for every
curated publisher. A missing source is denied by default.

## Runtime modes

| Field | Modes |
|---|---|
| Acquisition | `feed_metadata`, `feed_text`, `full_page`, `disabled` |
| Public text | `headline_only`, `feed_description`, `full_text` |
| Internal analysis | `metadata_only`, `permitted_text` |
| forumAI | `metadata_only`, `permitted_text`, `denied` |
| Images | `none`, `remote_no_cache`, `licensed_cache` |

The initial policy keeps all publishers at headline/link metadata. It does not
enable article-page extraction or publisher images. Conditional policies are
documented expansion paths, not active grants.

## Invariants

- Ingestion consults policy before reading optional feed fields.
- There is no article-page extraction dependency.
- Public article projections never select `articles.content`.
- Legacy summaries are hidden unless they carry the current policy version.
- forumAI receives headline/source/date/event metadata unless `ai_mode`
  explicitly permits additional text.
- Article media is returned only for an approved image mode.
- `remote_no_cache` images must not be written to device disk caches.
- The mobile client independently rejects media whose policy mode is absent.
- Policy changes require a terms/license review, an updated note and date, a
  policy-version bump, and tests.

## Database rollout

The safe order is:

```bash
npm run migrate:rights
npm run backfill:article-metadata
npm run verify:rights
npm run rescore
npm run cluster
npm run audit:article-cleanup
```

Migration 017 is non-destructive. The audit prints the exact legacy-body and
media impact without changing data. Permanent cleanup requires an explicit
operator action:

```bash
npm run cleanup:articles
```

Never run cleanup before the migrated API, metadata backfill, new cluster
summaries, search, and app fallbacks have been verified.

## Adding or licensing a source

Before broadening any mode, retain written evidence that covers the exact use:

- headline and description display;
- internal classification and clustering;
- AI grounding and downstream processors;
- image display, proxying, and caching;
- retention period, attribution, platforms, territories, and termination.

Photograph permission is reviewed independently from article text. A publisher
feed image may be owned by a photographer or wire agency and is not enabled
merely because the image URL is present.
