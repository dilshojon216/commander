/**
 * Deploy (6.5) va checkpoint (6.9) xato kodlari -> o'zbekcha matn (barg fayl: `control-ui.ts` ham, `deploy-ui.ts` ham import qiladi;
 * aylanma bog'liqlik bo'lmasligi uchun hech narsani import qilmaydi).
 */
export const DEPLOY_ERROR_TEXT: Record<string, string> = {
  deploy_busy: "Bu loyihada boshqa deploy bajarilmoqda: tugashini kuting",
  commit_changed: "Repo HEAD'i o'zgargan: retseptni qaytadan tekshiring",
  recipe_changed: "Retsept o'zgargan (xesh mos kelmadi): qaytadan tekshiring va tasdiqlang",
  dirty_worktree: "Ishchi daraxtda commit qilinmagan o'zgarish bor: commit/stash qiling, so'ng qaytadan tekshiring",
  machine_mismatch: "Maqsad mashina bu loyiha mashinasiga mos emas (retsept: machine)",
  shell_not_allowed: "Retsept shell: qadamlarini ishlatadi; mashinada: `agentd policy allow-deploy-shell`",
  action_not_allowed: "Mashina siyosati bu amalga ruxsat bermaydi (deploy uchun: `agentd policy allow-deploy`)",
  target_not_found: "Retseptda bunday maqsad (target) yo'q",
  recipe_missing: "Retsept topilmadi: `.commander/deploy.yml` shu commit'da yo'q",
  recipe_invalid: "Retsept yaroqsiz: muammolar ro'yxatini ko'ring",
  preflight_failed: "Deploy boshlanmadi: oldindan tekshiruv (preflight) bajarilmadi",
  deploy_failed: "Deploy qadami bajarilmadi",
  health_check_failed: "Deploy tugadi, lekin sog'liq tekshiruvi (health) o'tmadi",
  agent_outdated: "Mashinadagi agentd eski: yangilang",
  machine_offline: "Mashina oflayn: agentd ulanmagan",
  agent_timeout: "Mashina javob bermadi (vaqt tugadi)",
  lockdown: "Lockdown yoqiq: masofaviy amallar bloklangan",
  checkpoint_failed: "Checkpoint amali bajarilmadi (mashinada git xatosi)",
  checkpoint_not_found: "Checkpoint topilmadi (o'chirilgan bo'lishi mumkin): ro'yxatni yangilang",
  branch_changed: "Branch o'zgargan: ro'yxatni yangilab qayta urinib ko'ring",
  head_diverged: "HEAD checkpoint'dan ajralib ketgan: avval commit'larni saqlang",
  no_commits: "Repoda hali commit yo'q: checkpoint olib bo'lmaydi",
  step_up_unavailable: "Telegram tasdig'i yuborilmadi (bot ulanmagan)",
  step_up_expired: "Tasdiqlash vaqti tugadi (2 daqiqa)",
  step_up_cancelled: "Tasdiqlash bekor qilindi",
};
