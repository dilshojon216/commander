import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAuthSettings } from "@/lib/auth/settings";
import { setupCodeHash } from "../scripts/auth-cli.mjs";
import { saveSetup } from "@/lib/auth/store";

/** Har test uchun alohida auth papka (0700), tugagach o'chiriladi. */
export function tempAuthDir(): { dir: () => string; reset: () => void; cleanup: () => void } {
  let dir = "";
  const reset = () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "commander-auth-test-"));
    process.env.DASHBOARD_AUTH_DIR = dir;
  };
  return { dir: () => dir, reset, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}

export const settings = () => getAuthSettings({});

/** Sozlash kodini CLI'dagidek diskka yozadi (kod matni qaytariladi). */
export function plantSetupCode(code: string, now: number, ttlMs = 10 * 60_000): void {
  saveSetup({ codeHash: setupCodeHash(code), expiresAt: now + ttlMs, attempts: 0, createdAt: now });
}

// ---- minimal CBOR kodlovchi (faqat WebAuthn testi uchun) -----------------------------------------------------------

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** Dasturiy "Touch ID": ES256 kalit, hisoblagich, UV bayrog'i boshqariladi. */
export class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;
  counter = 0;
  userVerified = true;

  constructor(private readonly rpId = "localhost", private readonly origin = "http://localhost:4318") {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.priv = kp.privateKey;
    this.pub = kp.publicKey;
  }

  private flags(attested: boolean): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  private authData(attested: boolean): Buffer {
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(this.rpId), Buffer.from([this.flags(attested)]), cnt];
    if (attested) {
      const jwk = this.pub.export({ format: "jwk" });
      const cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, cbor(cose));
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, origin = this.origin) {
    this.counter = 0;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const attObj = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(true)]]));
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  assert(challenge: string, opts: { origin?: string; type?: string } = {}) {
    this.counter += 1;
    const clientData = Buffer.from(JSON.stringify({ type: opts.type ?? "webauthn.get", challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    const ad = this.authData(false);
    const signature = sign("sha256", new Uint8Array(Buffer.concat([ad, sha256(clientData)])), this.priv);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
