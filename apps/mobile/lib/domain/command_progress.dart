import 'package:commander_contracts/commander_contracts.dart';

/// Buyruq holatining UI ko'rinishi (yangi sessiya, prompt, stop).
enum CommandPhase {
  /// "Telegram'da tasdiqlang": step-up ikkinchi tasdiq kutilmoqda.
  awaitingTelegram,
  inProgress,
  done,
  failed,
}

class CommandProgress {
  const CommandProgress(this.phase, this.text);
  final CommandPhase phase;
  final String text;
  bool get terminal =>
      phase == CommandPhase.done || phase == CommandPhase.failed;
}

CommandProgress commandProgress(CommandDto c) {
  switch (c.status) {
    case CommandState.awaitingConfirmation:
      return const CommandProgress(
        CommandPhase.awaitingTelegram,
        "Telegram'da tasdiqlang",
      );
    case CommandState.pending ||
        CommandState.sent ||
        CommandState.acked ||
        CommandState.running:
      return const CommandProgress(CommandPhase.inProgress, 'Bajarilmoqda…');
    case CommandState.done:
      return const CommandProgress(CommandPhase.done, 'Bajarildi');
    case CommandState.expired:
      return CommandProgress(
        CommandPhase.failed,
        c.stepUp.required_ ? "Tasdiqlanmadi: muddat o'tdi" : "Muddati o'tdi",
      );
    case CommandState.failed || CommandState.rejected:
      return CommandProgress(
        CommandPhase.failed,
        commandErrorText(c.errorCode, c.errorMessage),
      );
    case CommandState.unknown:
      return const CommandProgress(CommandPhase.inProgress, 'Kutilmoqda…');
  }
}

String commandErrorText(String? code, String? message) => switch (code) {
  'machine_offline' => 'Mashina oflayn',
  'policy_disabled' => "Masofaviy boshqaruv mashinada o'chiq",
  'agent_outdated' => 'agentd eskirgan: yangilang',
  'interactive_session' => "Terminal sessiyasi: faqat ko'rish",
  'session_busy' => 'Sessiya band: avval to\'xtating yoki tugashini kuting',
  'lockdown' => 'Lockdown yoqiq',
  'step_up_unavailable' => "Telegram tasdig'i mavjud emas (kanal sozlanmagan)",
  'step_up_cancelled' => "Tasdiq bekor qilindi",
  'step_up_expired' => "Tasdiqlanmadi: muddat o'tdi",
  'center_restarted' => 'Markaz qayta ishga tushdi, qayta urinib ko\'ring',
  'action_not_allowed' =>
    "Mashinaning lokal siyosati bu amalga ruxsat bermaydi",
  'cwd_not_allowed' => "Papka ruxsat etilgan ro'yxatda emas",
  'not_owned' => "Jarayon agentd egasiniki emas",
  'remote_control_unsupported' =>
    "Bu sessiyada Remote Control qo'llab-quvvatlanmaydi",
  'remote_control_unverified' =>
    "Remote Control holati tasdiqlanmadi (claude.ai'ga kirilganini tekshiring)",
  'remote_control_failed' => 'Remote Control ishlamadi',
  _ => message ?? code ?? 'Xato',
};

/// Buyruq natijasidan sessiya `claudeSessionId` (yangi sessiyani ochish uchun).
String? startedClaudeSessionId(CommandDto c) => c.result?.claudeSessionId;
