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

/** Returns a copy of a 401 response with the discovery challenge added. */
export function addDiscoveryChallenge(response: Response, metadataUrl: string): Response {
  const updated = new Response(response.body, response);
  updated.headers.set(
    "www-authenticate",
    withResourceMetadata(response.headers.get("www-authenticate"), metadataUrl),
  );
  return updated;
}
