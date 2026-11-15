/** Klaviatura yorliqlari yordamchilari (sof). */

const CHORDS: Record<string, string> = {
  o: "/",
  s: "/sessions",
  p: "/projects",
  t: "/tokens",
  m: "/machines",
};

/** `g` dan keyingi harf -> sahifa (yo'q bo'lsa null). */
export function chordTarget(key: string): string | null {
  return CHORDS[key.toLowerCase()] ?? null;
}

/** Matn kiritish elementlarida yorliqlar o'chadi. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}
