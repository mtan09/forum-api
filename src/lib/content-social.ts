/**
 * Shared projection fragments for the social state attached to posts and
 * articles. `$1` is the current viewer throughout the API's read queries.
 * Counts are derived from indexed source rows so repost/quote deletion and
 * moderation cannot leave denormalized totals behind.
 */
export function postSocialFields(postAlias = 'p', viewerSql = '$1'): string {
  return `
    (
      (SELECT count(*) FROM reposts r WHERE r.post_id = ${postAlias}.id) +
      (SELECT count(*) FROM posts quote_post
       WHERE quote_post.quoted_post_id = ${postAlias}.id AND NOT quote_post.hidden)
    )::int AS repost_count,
    EXISTS(
      SELECT 1 FROM reposts my_repost
      WHERE my_repost.post_id = ${postAlias}.id AND my_repost.user_id = ${viewerSql}
    ) AS my_repost,
    CASE
      WHEN ${postAlias}.quoted_post_id IS NOT NULL THEN
        COALESCE(
          (
            SELECT jsonb_build_object(
              'kind', 'post',
              'id', quoted.id,
              'available', TRUE,
              'author_id', quoted.user_id,
              'username', author.username,
              'avatar_url', author.avatar_url,
              'is_demo', author.is_demo,
              'text', quoted.content,
              'media', quoted.media_url,
              'position', quoted.position,
              'created_at', quoted.created_at
            )
            FROM posts quoted
            JOIN userdata author ON author.id = quoted.user_id
            WHERE quoted.id = ${postAlias}.quoted_post_id
              AND NOT quoted.hidden
              AND NOT EXISTS (
                SELECT 1 FROM blocks blocked
                WHERE (blocked.blocker_id = ${viewerSql} AND blocked.blocked_id = quoted.user_id)
                   OR (blocked.blocker_id = quoted.user_id AND blocked.blocked_id = ${viewerSql})
              )
          ),
          jsonb_build_object(
            'kind', 'post', 'id', ${postAlias}.quoted_post_id, 'available', FALSE
          )
        )
      WHEN ${postAlias}.quoted_article_id IS NOT NULL THEN
        COALESCE(
          (
            SELECT jsonb_build_object(
              'kind', 'article',
              'id', quoted.id,
              'available', TRUE,
              'title', quoted.title,
              'source', quoted.source,
              'media', quoted.media,
              'url', quoted.url,
              'political_lean', quoted.political_lean,
              'source_lean', quoted.source_lean,
              'published_at', quoted.published_at
            )
            FROM articles quoted
            WHERE quoted.id = ${postAlias}.quoted_article_id AND quoted.status = 'ready'
          ),
          jsonb_build_object(
            'kind', 'article', 'id', ${postAlias}.quoted_article_id, 'available', FALSE
          )
        )
      ELSE NULL
    END AS quoted_content`
}

export function articleSocialFields(articleAlias = 'a', viewerSql = '$1'): string {
  return `
    (
      (SELECT count(*) FROM reposts r WHERE r.article_id = ${articleAlias}.id) +
      (SELECT count(*) FROM posts quote_post
       WHERE quote_post.quoted_article_id = ${articleAlias}.id AND NOT quote_post.hidden)
    )::int AS repost_count,
    EXISTS(
      SELECT 1 FROM reposts my_repost
      WHERE my_repost.article_id = ${articleAlias}.id AND my_repost.user_id = ${viewerSql}
    ) AS my_repost`
}
