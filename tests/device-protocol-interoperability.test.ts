import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signRequest, enrollProof } from "../device-daemon/protocol.mjs";
import { deviceSigningText, verifySignature } from "../src/devices/protocol";

describe("Node daemon and Worker crypto interoperability", () => {
  it("verifies Node-generated enrollment and request proofs with Web Crypto", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const code = "pair-code";
    expect(
      await verifySignature(
        publicDer,
        enrollProof(code, publicDer, privateKey),
        `durableclaw-enroll-v1\n${code}\n${publicDer}`,
      ),
    ).toBe(true);
    const body = JSON.stringify({ stdout: "Unicode output: 日本語 👋" });
    const url = "https://app.example.invalid/api/devices/result";
    const headers = signRequest({
      deviceId: crypto.randomUUID(),
      privateKey,
      url,
      body,
    });
    const request = new Request(url, { method: "POST", headers, body });
    const proof = request.headers.get("X-Device-Signature")!;
    expect(
      await verifySignature(
        publicDer,
        proof,
        await deviceSigningText(request, body),
      ),
    ).toBe(true);
    expect(
      await verifySignature(
        publicDer,
        proof,
        await deviceSigningText(request, body + " "),
      ),
    ).toBe(false);
    expect(
      await verifySignature(
        publicDer,
        proof,
        await deviceSigningText(
          new Request(url + "?retarget=1", { method: "POST", headers }),
          body,
        ),
      ),
    ).toBe(false);
  });
});
