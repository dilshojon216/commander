/** Sozlamalar sinxronlash (3.7) buyruq xato matnlari. Alohida fayl: `control-ui.ts` ham, `config-ui.ts` ham shuni import qiladi (aylanma bog'liqliksiz). */

/** Mashinada ruxsatni yoqish buyrug'i (agentd CLI). */
export const ALLOW_CONFIG_CLI = "agentd policy allow-config";
export const ALLOW_CONFIG_HINT = `Mashinada \`${ALLOW_CONFIG_CLI}\` buyrug'ini ishga tushiring`;

export const CONFIG_ERROR_TEXT: Record<string, string> = {
  config_not_allowed: `Mashina siyosati sozlamalarni o'qish/yozishga ruxsat bermaydi. ${ALLOW_CONFIG_HINT}.`,
  config_plan_changed: "Diff'dan keyin mashinadagi fayllar o'zgargan. \"Farqni ko'rish\" ni qayta bajaring va yangi rejani tasdiqlang.",
  config_bundle_missing: "Profil paketi markazda topilmadi (muddati o'tgan). Profilni mashinadan qayta oling.",
  config_bundle_invalid: "Profil paketi yaroqsiz yoki buzilgan (xesh mos kelmadi). Profilni qayta oling.",
  config_backup_not_found: "Zaxira mashinada topilmadi (o'chirilgan bo'lishi mumkin).",
  config_too_large: "Profil yoki fayl hajmi chegaradan katta.",
  config_write_failed: "Mashinada faylni yozib bo'lmadi (ruxsat yoki disk xatosi). O'zgarishlar qaytarildi.",
  config_profile_not_found: "Profil topilmadi",
  config_file_not_found: "Fayl profilda topilmadi",
  config_unsupported: "Mashinadagi agentd eski: sozlamalar sinxronlashni qo'llamaydi",
};

