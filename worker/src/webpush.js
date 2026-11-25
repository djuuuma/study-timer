// Minimal Web Push sender using only WebCrypto (runs in Cloudflare Workers and Node 20+).
//   - VAPID authentication (RFC 8292): ES256-signed JWT
//   - Payload encryption "aes128gcm" (RFC 8291 + RFC 8188)

const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

/** VAPID "Authorization" header value for a push endpoint. */
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }) {
  const pub = b64u.decode(publicKey); // 65 bytes: 0x04 || X || Y
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: privateKey,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA returns the raw r||s (64 bytes) signature that JWT ES256 expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.encode(sig)}, k=${publicKey}`;
}

/** Encrypt a payload for a subscription (RFC 8291, aes128gcm, single record). */
export async function encryptPayload(subscription, payload) {
  const uaPublic = b64u.decode(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64u.decode(subscription.keys.auth); // 16 bytes

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info" || 0x00 || ua_public || as_public)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 256);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 96);

  const plaintext = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 = last record
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // Header: salt (16) || record size (uint32 BE) || key id length (1) || key id (as_public, 65)
  const rs = 4096;
  const header = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/** Send one push message. Returns the push service's HTTP status. */
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high' } = {}) {
  const body = await encryptPayload(subscription, payload);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return res.status;
}
