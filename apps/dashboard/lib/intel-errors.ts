/** Aqlli yordamchi yozuvlari (sozlamalar, qarorlar) uchun HTTP xato matni (sof). */
export function writeErrorText(status: number): string {
  if (status === 401) return "Qayta tasdiqlash bekor qilindi yoki muddati tugadi. Qayta urinib ko'ring.";
  if (status === 403) return "Ruxsat yo'q: boshqaruv token'i yoki lockdown.";
  if (status === 404) return "Topilmadi: ro'yxatni yangilab qayta urinib ko'ring.";
  if (status === 400 || status === 422) return "Maydonlar noto'g'ri: qiymatlarni tekshiring.";
  if (status === 409) return "Bu amalni hozir bajarib bo'lmaydi (holat o'zgargan).";
  if (status === 413) return "Ma'lumot juda katta.";
  if (status === 429) return "Juda tez-tez so'rov: birozdan keyin urinib ko'ring.";
  if (status === 502 || status === 503 || status === 504) return "Markazga ulanib bo'lmadi.";
  return "Saqlab bo'lmadi, qayta urinib ko'ring.";
}
