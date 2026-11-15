import 'package:commander_contracts/commander_contracts.dart';

import 'approval_rules.dart';

/// "Diqqat talab qiladi": kutayotgan ruxsatlar + javob kutayotgan sessiyalar.
class Attention {
  const Attention({required this.approvals, required this.waitingSessions});
  final List<ApprovalDto> approvals;
  final List<SessionDto> waitingSessions;
  bool get isEmpty => approvals.isEmpty && waitingSessions.isEmpty;
  int get badgeCount => approvals.length + waitingSessions.length;
}

Attention buildAttention(
  List<ApprovalDto> pending,
  List<SessionDto> sessions, {
  DateTime? now,
}) {
  final ap =
      pending
          .where((a) => approvalUiState(a, now: now) == ApprovalUiState.pending)
          .toList()
        ..sort((a, b) => a.deadline.compareTo(b.deadline));
  final waiting =
      sessions
          .where(
            (s) => s.status == SessionStatus.waiting && s.staleSince == null,
          )
          .toList()
        ..sort((a, b) => a.statusSince.compareTo(b.statusSince));
  return Attention(approvals: ap, waitingSessions: waiting);
}
