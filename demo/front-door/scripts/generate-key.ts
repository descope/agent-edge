// Prints a new ES256 private key as a JWK, for the PRIVATE_KEY_JWK secret.
// Register the public half with each inbound app by pointing it at the front door's /jwks.json.
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const kid = `front-door-${new Date().toISOString().slice(0, 10)}`;
console.log(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid }));
