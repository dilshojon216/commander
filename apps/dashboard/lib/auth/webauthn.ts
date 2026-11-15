import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AuthSettings } from "./settings";
import type { PasskeyRecord } from "./store";

/**
 * WebAuthn (passkey, platforma autentifikatori = Touch ID). `userVerification: "required"`: biometriya/parol har safar
 * shart (faqat "foydalanuvchi mavjud" yetmaydi). RP ID = `localhost` (IP manzil RP ID bo'lolmaydi).
 */
export const RP_NAME = "Commander";

export function registrationOptions(userId: string, existing: PasskeyRecord[], s: AuthSettings): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: s.rpId,
    userName: "owner",
    userDisplayName: "Commander egasi",
    userID: Buffer.from(userId, "base64url"),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    timeout: 90_000,
  });
}

export async function verifyRegistration(response: RegistrationResponseJSON, challenge: string, s: AuthSettings): Promise<Omit<PasskeyRecord, "name" | "createdAt"> | null> {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: s.origins,
    expectedRPID: s.rpId,
    requireUserPresence: true,
    requireUserVerification: true,
  });
  if (!v.verified) return null;
  const c = v.registrationInfo.credential;
  return { id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports };
}

export function authenticationOptions(passkeys: PasskeyRecord[], s: AuthSettings): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: s.rpId,
    userVerification: "required",
    allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    timeout: 90_000,
  });
}

/** Muvaffaqiyatli bo'lsa yangilangan hisoblagichni qaytaradi (klon aniqlash: kichik hisoblagich rad etiladi). */
export async function verifyAuthentication(response: AuthenticationResponseJSON, challenge: string, passkey: PasskeyRecord, s: AuthSettings): Promise<{ newCounter: number } | null> {
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: s.origins,
      expectedRPID: s.rpId,
      requireUserVerification: true,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: passkey.counter, transports: passkey.transports },
    });
    return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
  } catch {
    return null;
  }
}
