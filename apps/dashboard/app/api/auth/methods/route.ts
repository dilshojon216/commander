import { availableMethods } from "@/lib/auth/service";
import { json } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

/** Ommaviy: login sahifasi qaysi usullar sozlanganini bilishi uchun (sir yo'q, faqat bayroqlar). */
export function GET() {
  return json(availableMethods());
}
