import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/repositories.dart';

enum ApprovalActionStatus { submitting, done, failed }

class ApprovalAction extends Equatable {
  const ApprovalAction(
    this.status, {
    this.message,
    this.delivered = true,
    this.behavior,
  });
  final ApprovalActionStatus status;
  final String? message;
  final bool delivered;
  final ApprovalBehavior? behavior;
  @override
  List<Object?> get props => [status, message, delivered, behavior];
}

class ApprovalActionsState extends Equatable {
  const ApprovalActionsState([this.actions = const {}]);
  final Map<String, ApprovalAction> actions;
  ApprovalAction? of(String id) => actions[id];
  @override
  List<Object?> get props => [actions];
}

/// Ruxsat qarorlari: har so'rov uchun alohida holat (yuborilmoqda / xato / tayyor).
class ApprovalActionsCubit extends Cubit<ApprovalActionsState> {
  ApprovalActionsCubit({
    required ControlRepository control,
    required void Function(ApprovalDto) onResolved,
    required void Function() onConflict,
  }) : _control = control,
       _onResolved = onResolved,
       _onConflict = onConflict,
       super(const ApprovalActionsState());

  final ControlRepository _control;
  final void Function(ApprovalDto) _onResolved;
  final void Function() _onConflict;

  void _set(String id, ApprovalAction? a) {
    final m = Map<String, ApprovalAction>.of(state.actions);
    if (a == null) {
      m.remove(id);
    } else {
      m[id] = a;
    }
    emit(ApprovalActionsState(m));
  }

  Future<void> decide(
    ApprovalDto approval,
    ApprovalBehavior behavior, {
    String? message,
    List<AskAnswer>? answers,
  }) async {
    if (state.of(approval.id)?.status == ApprovalActionStatus.submitting)
      return;
    _set(
      approval.id,
      ApprovalAction(ApprovalActionStatus.submitting, behavior: behavior),
    );
    try {
      final res = await _control.decide(
        approval.id,
        behavior,
        message: message,
        answers: answers,
      );
      _onResolved(res.approval);
      _set(
        approval.id,
        ApprovalAction(
          ApprovalActionStatus.done,
          delivered: res.delivered,
          behavior: behavior,
        ),
      );
    } on ApiException catch (e) {
      if (e.failure == ApiFailure.conflict) _onConflict();
      _set(
        approval.id,
        ApprovalAction(
          ApprovalActionStatus.failed,
          message: e.userMessage,
          behavior: behavior,
        ),
      );
    }
  }

  void clear(String id) => _set(id, null);
}
