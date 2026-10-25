import type { AgentNavigationPolicy } from './types'

type AllowedUrlResult =
  | { valid: true }
  | { valid: false; error: string }

export function isAllowedUrl(url: string, policy: AgentNavigationPolicy): AllowedUrlResult {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { valid: false, error: `Invalid URL scheme: ${parsedUrl.protocol}` }
    }

    const hostname = parsedUrl.hostname.toLowerCase()
    const isAllowed = policy.allowedHostnames.some((allowedHostname) => {
      const normalizedAllowedHostname = allowedHostname.toLowerCase()
      return hostname === normalizedAllowedHostname || (
        policy.allowSubdomains === true && hostname.endsWith(`.${normalizedAllowedHostname}`)
      )
    })

    if (!isAllowed) {
      return {
        valid: false,
        error: `Navigation to ${hostname} is not allowed. Stay within ${policy.allowedHostnames.join(', ')}.`
      }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}
