/**
 * Adds resource_metadata to a 401's WWW-Authenticate header (RFC 9728 section 5.1),
 * so MCP and OAuth clients can discover the authorization server on their own.
 *
 * - No header: returns a new Bearer challenge.
 * - A Bearer challenge without resource_metadata: appends the parameter.
 * - Already has resource_metadata: returns the header unchanged.
 * - Another scheme, such as Basic: adds a Bearer challenge after it.
 */
export function withResourceMetadata(existing: string | null, metadataUrl: string): string {
  const param = `resource_metadata="${metadataUrl}"`;
  if (!existing || existing.trim() === "") return `Bearer ${param}`;
  if (/resource_metadata\s*=/i.test(existing)) return existing;
  if (/^\s*Bearer\s*$/i.test(existing)) return `Bearer ${param}`;
  if (/^\s*Bearer\s+/i.test(existing)) return `${existing.trim()}, ${param}`;
  return `${existing.trim()}, Bearer ${param}`;
}

/**
 * Adds the scopes a refusal needs, when the challenge does not already name them.
 *
 * Poppy section 7 asks for them in both refusals, and is specific about the 401: a request
 * with no token gets 401 "with no error code", and "the challenge's `scope` attribute names
 * the scopes needed [...] The Personal Agent handles it as `insufficient_scope`."
 *
 * A bare 401 is the difference between an agent that goes and asks the person for the right
 * scope and one that retries, fails again, and falls back to asking them to sign in — which
 * reads as a broken integration rather than a missing attribute.
 *
 * An existing `scope` is left alone: the origin knows which scopes *this* operation needs,
 * and the configured list is only the resource's whole vocabulary.
 */
export function withScope(existing: string, scopes: string[]): string {
  if (scopes.length === 0) return existing;
  if (/[,\s]scope\s*=/i.test(existing) || /^\s*\w+\s+scope\s*=/i.test(existing)) return existing;
  return `${existing.trim()}, scope="${scopes.join(" ")}"`;
}

/**
 * Returns a copy of a refusal with the discovery challenge added, and the resource's scopes
 * when the origin named none.
 */
export function addDiscoveryChallenge(response: Response, metadataUrl: string, scopes: string[] = []): Response {
  const updated = new Response(response.body, response);
  updated.headers.set(
    "www-authenticate",
    withScope(withResourceMetadata(response.headers.get("www-authenticate"), metadataUrl), scopes),
  );
  return updated;
}
