import 'package:commander_contracts/commander_contracts.dart';

import '../core/util/format.dart';
import 'ask_question.dart';

/// Ruxsat so'rovi UI holatlari.
enum ApprovalUiState { pending, approved, denied, expired, cancelled }

ApprovalUiState approvalUiState(ApprovalDto a, {DateTime? now}) {
  switch (a.status) {
    case ApprovalStatus.pending:
      final d = parseIso(a.deadline);
      if (d != null && !d.isAfter(now ?? DateTime.now()))
        return ApprovalUiState.expired;
      return ApprovalUiState.pending;
    case ApprovalStatus.approved:
      return ApprovalUiState.approved;
    case ApprovalStatus.denied:
      return ApprovalUiState.denied;
    case ApprovalStatus.expired:
      return ApprovalUiState.expired;
    case ApprovalStatus.cancelled:
    case ApprovalStatus.unknown:
      return ApprovalUiState.cancelled;
  }
}

String approvalStateLabel(ApprovalUiState s) => switch (s) {
  ApprovalUiState.pending => 'Ruxsat kutmoqda',
  ApprovalUiState.approved => 'Ruxsat berildi',
  ApprovalUiState.denied => 'Rad etildi',
  ApprovalUiState.expired => "Muddati o'tdi",
  ApprovalUiState.cancelled => 'Bekor qilindi (terminalda hal bo\'ldi)',
};

Duration approvalRemaining(ApprovalDto a, {DateTime? now}) {
  final d = parseIso(a.deadline);
  if (d == null) return Duration.zero;
  final r = d.difference(now ?? DateTime.now());
  return r.isNegative ? Duration.zero : r;
}

/// "Ruxsat" faqat `approve` scope bor, lockdown yo'q va so'rov hali pending bo'lsa. Rad etish lockdown'da ham mumkin.
/// Savol (question) so'rovida oddiy "Ruxsat" yo'q: center javobsiz allow'ni rad etadi (422).
bool canAllow(
  ApprovalDto a, {
  required bool hasApproveScope,
  required bool lockdown,
  DateTime? now,
}) =>
    !isQuestion(a) &&
    hasApproveScope &&
    !lockdown &&
    approvalUiState(a, now: now) == ApprovalUiState.pending;

/// Variant tanlab javob berish: allow bilan bir xil shartlar + savol bitta va bitta tanlovli.
bool canAnswer(
  ApprovalDto a, {
  required bool hasApproveScope,
  required bool lockdown,
  DateTime? now,
}) =>
    isAnswerableQuestion(a) &&
    hasApproveScope &&
    !lockdown &&
    approvalUiState(a, now: now) == ApprovalUiState.pending;

bool canDeny(ApprovalDto a, {required bool hasApproveScope, DateTime? now}) =>
    hasApproveScope && approvalUiState(a, now: now) == ApprovalUiState.pending;

bool isPlan(ApprovalDto a) => a.kind == ApprovalKind.plan;

/// Ko'rsatiladigan matn: reja bo'lsa reja matni, aks holda tool kiritmasi (redakt qilingan, "ochish" yo'q).
String approvalBody(ApprovalDto a) {
  if (isPlan(a) && a.plan != null) return a.plan!;
  if (isQuestion(a)) return questionSummary(a);
  return a.toolInputRedacted;
}
