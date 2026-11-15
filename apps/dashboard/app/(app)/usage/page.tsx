import { redirect } from "next/navigation";

/** Eski manzil: dizaynda sahifa "Tokenlar" (`/tokens`). */
export default function UsageRedirect() {
  redirect("/tokens");
}
