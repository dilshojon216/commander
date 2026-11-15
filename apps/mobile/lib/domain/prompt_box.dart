import 'package:commander_contracts/commander_contracts.dart';

import 'session_labels.dart';

enum PromptBoxKind {
  /// Yuborish mumkin.
  enabled,

  /// Claude band: maydon bor, lekin yuborish yopiq (backend `session_busy` qaytaradi).
  busy,

  /// Boshqarib bo'lmaydi: sabab ko'rsatiladi.
  blocked,
}

class PromptBoxState {
  const PromptBoxState(this.kind, [this.reason]);
  final PromptBoxKind kind;
  final String? reason;
  bool get canSend => kind == PromptBoxKind.enabled;
}

/// `controls/controlReason` bo'yicha prompt maydoni holati (dashboard bilan bir xil qoida).
PromptBoxState promptBoxFor(
  SessionDto s, {
  required bool canControl,
  required bool lockdown,
}) {
  if (!canControl)
    return const PromptBoxState(
      PromptBoxKind.blocked,
      "Bu qurilmada boshqaruv ruxsati (control) yo'q",
    );
  if (lockdown)
    return const PromptBoxState(
      PromptBoxKind.blocked,
      'Lockdown yoqiq: masofadan yuborib bo\'lmaydi',
    );
  if (s.status == SessionStatus.ended)
    return const PromptBoxState(PromptBoxKind.blocked, 'Sessiya yopilgan');
  if (!s.controls.prompt)
    return PromptBoxState(
      PromptBoxKind.blocked,
      controlReasonText(s.controlReason),
    );
  if (s.status == SessionStatus.working ||
      s.status == SessionStatus.awaitingApproval) {
    return const PromptBoxState(
      PromptBoxKind.busy,
      'Claude ishlamoqda. Tugashini kuting yoki "To\'xtatish" bosing.',
    );
  }
  return const PromptBoxState(PromptBoxKind.enabled);
}

bool canStopSession(
  SessionDto s, {
  required bool canControl,
  required bool lockdown,
}) =>
    canControl &&
    !lockdown &&
    s.controls.stop &&
    s.status != SessionStatus.ended;

bool canToggleRemoteControl(
  SessionDto s, {
  required bool canControl,
  required bool lockdown,
}) =>
    canControl &&
    !lockdown &&
    s.controls.remoteControl == true &&
    s.status != SessionStatus.ended;
