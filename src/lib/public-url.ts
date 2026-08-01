const firstForwardedValue = (value: string | null): string | null => {
  const first = value?.split(',')[0]?.trim()
  return first || null
}

/**
 * Resolve the public API origin used in links sent outside the request cycle.
 * Railway terminates TLS before forwarding to Node, so `request.url` may use
 * http even when the user reached the public API over https.
 */
export function publicApiOrigin(request: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim()
  if (configured) {
    const url = new URL(configured)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('PUBLIC_API_URL must use http or https')
    }
    return url.origin
  }

  const requestUrl = new URL(request.url)
  const forwardedProtocol = firstForwardedValue(request.headers.get('x-forwarded-proto'))
  const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'))
  if (forwardedProtocol && forwardedHost) {
    return new URL(`${forwardedProtocol}://${forwardedHost}`).origin
  }

  return requestUrl.origin
}
