import { isoCBOR } from "@simplewebauthn/server/helpers";

const encode = (value: Uint8Array | ArrayBuffer) =>
  Buffer.from(value as Uint8Array).toString("base64url");
const digest = async (value: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", value));
const join = (...values: Uint8Array[]) => new Uint8Array(Buffer.concat(values));
const text = (value: string) => new TextEncoder().encode(value);

// A real software authenticator for protocol integration tests: ceremonies are
// signed with a fresh P-256 key and verified by the unmocked WebAuthn library.
export async function authenticator() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cose = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(publicKey.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(publicKey.y!, "base64url"))],
    ]),
  );
  const envelope = {
    id: encode(id),
    rawId: encode(id),
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
  return {
    async register(challenge: string, origin: string, rpID: string, uv = true) {
      const clientDataJSON = text(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const authData = join(
        await digest(text(rpID)),
        new Uint8Array([uv ? 0x45 : 0x41, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, id.length]),
        id,
        cose,
      );
      const attestationObject = isoCBOR.encode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        ...envelope,
        response: {
          clientDataJSON: encode(clientDataJSON),
          attestationObject: encode(attestationObject),
          transports: ["internal"],
        },
      };
    },
    async sign(
      challenge: string,
      origin: string,
      rpID: string,
      { uv = true, counter = 1 } = {},
    ) {
      const clientDataJSON = text(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, counter);
      const authenticatorData = join(
        await digest(text(rpID)),
        new Uint8Array([uv ? 5 : 1]),
        count,
      );
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          join(authenticatorData, await digest(clientDataJSON)),
        ),
      );
      const integer = (part: Uint8Array) => {
        let value = part;
        while (value.length > 1 && value[0] === 0) value = value.slice(1);
        if (value[0] & 128) value = join(new Uint8Array([0]), value);
        return join(new Uint8Array([2, value.length]), value);
      };
      const rs = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
      const signature = join(new Uint8Array([0x30, rs.length]), rs);
      return {
        ...envelope,
        response: {
          clientDataJSON: encode(clientDataJSON),
          authenticatorData: encode(authenticatorData),
          signature: encode(signature),
          userHandle: null,
        },
      };
    },
  };
}
