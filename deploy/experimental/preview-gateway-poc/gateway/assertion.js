import { createPublicKey, verify } from 'node:crypto';

const MAX_TTL_MS = 10_000;
const MAX_JTI = 128;
const ASSERTION_HEADER = 'x-pilot-ingress-assertion';

// Verifies assertions from the private ingress channel. The caller must only
// invoke this on a request accepted by the private Unix listener.
export function createAssertionVerifier({ publicKey, ownerLogin, allowedNodeIds, now = Date.now, maxTtlMs = 5_000, maxReplayEntries = 10_000 }) {
  if (!publicKey || !ownerLogin || !Array.isArray(allowedNodeIds) || !allowedNodeIds.length ||
      !Number.isInteger(maxTtlMs) || maxTtlMs < 100 || maxTtlMs > MAX_TTL_MS ||
      !Number.isInteger(maxReplayEntries) || maxReplayEntries < 1 || maxReplayEntries > 100_000) {
    throw new Error('invalid ingress assertion configuration');
  }
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ingress key must be Ed25519');
  const seen = new Map();
  function verifyRequest(req, privateSource) {
    if (!privateSource) return null;
    const token = req.headers[ASSERTION_HEADER];
    if (typeof token !== 'string' || token.length > 4096 || token.split('.').length !== 2) return null;
    const [encoded, signature] = token.split('.');
    let claim;
    try {
      const data = Buffer.from(encoded, 'base64url');
      if (data.toString('base64url') !== encoded || !verify(null, data, key, Buffer.from(signature, 'base64url'))) return null;
      claim = JSON.parse(data.toString('utf8'));
    } catch { return null; }
    const time = now();
    if (!claim || !Number.isSafeInteger(claim.iat) || !Number.isSafeInteger(claim.exp) ||
      claim.iat > time + 1000 || claim.exp <= time || claim.exp <= claim.iat ||
      claim.exp - claim.iat > maxTtlMs || time - claim.iat > maxTtlMs ||
      typeof claim.jti !== 'string' || claim.jti.length < 16 || claim.jti.length > MAX_JTI ||
      typeof claim.login !== 'string' || claim.login !== ownerLogin ||
      typeof claim.nodeId !== 'string' || !allowedNodeIds.includes(claim.nodeId) ||
      claim.method !== req.method || claim.rawUrl !== req.url || claim.host !== req.headers.host) return null;
    for (const [id, expiry] of seen) if (expiry <= time) seen.delete(id);
    if (seen.has(claim.jti) || seen.size >= maxReplayEntries) return null;
    seen.set(claim.jti, claim.exp);
    return { login: claim.login, nodeId: claim.nodeId };
  }
  return { verifyRequest, seen };
}

export function assertionHeaderName() { return ASSERTION_HEADER; }
