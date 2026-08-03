/**
 * Hono's logger receives the complete path, including query parameters.
 * Redact the values before they can reach Railway logs so searches, reset
 * tokens, and other request parameters are not retained as log content.
 */
export function redactRequestLog(line: string): string {
  return line.replace(/(\s\/[^?\s]*)\?[^\s]*/g, '$1?[query-redacted]')
}
