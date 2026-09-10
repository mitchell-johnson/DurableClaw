import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { acquireLock, privateRead, privateWrite } from "./store.mjs";
import { enrollProof, requestJson, validateOrigin } from "./protocol.mjs";

export async function pairDevice({
  directory,
  origin,
  code,
  allowLocalHttp = false,
  fetchImpl = fetch,
}) {
  if (process.getuid?.() === 0)
    throw new Error(
      "Pair as the regular user who will run the daemon, never root",
    );
  origin = validateOrigin(origin, allowLocalHttp);
  if (typeof code !== "string" || !/^[a-zA-Z0-9_-]{16,512}$/.test(code))
    throw new Error("Invalid pairing code");
  const release = await acquireLock(directory);
  try {
    try {
      await privateRead(join(directory, "config.json"));
      throw new Error(
        "This installation is already paired. Revoke and uninstall --purge before pairing again",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const public_key = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    // Write the key durably before sending the one-shot enrollment request.
    await privateWrite(
      join(directory, "private-key.pem"),
      privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const response = await requestJson(new URL("/api/devices/enroll", origin), {
      body: JSON.stringify({
        code,
        public_key,
        proof: enrollProof(code, public_key, privateKey),
      }),
      fetchImpl,
    });
    if (
      !response ||
      typeof response.device_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(response.device_id)
    )
      throw new Error("Invalid enrollment response");
    const config = {
      version: 1,
      origin,
      deviceId: response.device_id,
      allowLocalHttp,
    };
    await privateWrite(join(directory, "config.json"), JSON.stringify(config));
    return config;
  } finally {
    await release();
  }
}

export async function readPairCode(
  input = process.stdin,
  output = process.stderr,
) {
  output.write("Pairing code (input hidden): ");
  const wasRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = "";
      const finish = (error) => {
        input.off("data", data);
        input.off("end", end);
        input.off("error", fail);
        error ? reject(error) : resolve(value.trim());
      };
      const data = (chunk) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\u0003") return finish(new Error("Pairing cancelled"));
          if (char === "\r" || char === "\n") return finish();
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else value += char;
          if (value.length > 512)
            return finish(new Error("Pairing code too long"));
        }
      };
      const end = () => finish();
      const fail = (error) => finish(error);
      input.on("data", data);
      input.once("end", end);
      input.once("error", fail);
    });
  } finally {
    if (input.isTTY) input.setRawMode(Boolean(wasRaw));
    input.pause();
    output.write("\n");
  }
}
