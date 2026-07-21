const VIDEO_PLAYER_LABEL_RE = /\bnow playing\b|\bup next\b|\bwatch live\b/i
const TIMECODE_RE = /\b\d{1,2}:\d{2}\b/g

// Article extractors can mistake a publisher's video rail for story text.
// Repeated duration stamps are a strong source-independent signal; player
// labels make the threshold stricter without rejecting ordinary prose that
// happens to mention a time of day.
export function looksLikeVideoPlaylistChrome(text: string): boolean {
  const timecodes = text.match(TIMECODE_RE)?.length ?? 0
  return timecodes >= 3 && VIDEO_PLAYER_LABEL_RE.test(text)
}
