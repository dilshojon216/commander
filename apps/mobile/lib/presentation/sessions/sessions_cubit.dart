import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';

enum SessionFilter { all, attention, working, idle, ended }

String sessionFilterLabel(SessionFilter f) => switch (f) {
  SessionFilter.all => 'Hammasi',
  SessionFilter.attention => 'Kutmoqda',
  SessionFilter.working => 'Ishlamoqda',
  SessionFilter.idle => "Bo'sh",
  SessionFilter.ended => 'Tugaganlar',
};

class SessionsState extends Equatable {
  const SessionsState({
    this.filter = SessionFilter.all,
    this.ended = const [],
    this.loadingEnded = false,
    this.error,
  });
  final SessionFilter filter;
  final List<SessionDto> ended;
  final bool loadingEnded;
  final String? error;

  SessionsState copyWith({
    SessionFilter? filter,
    List<SessionDto>? ended,
    bool? loadingEnded,
    String? error,
    bool clearError = false,
  }) => SessionsState(
    filter: filter ?? this.filter,
    ended: ended ?? this.ended,
    loadingEnded: loadingEnded ?? this.loadingEnded,
    error: clearError ? null : (error ?? this.error),
  );

  @override
  List<Object?> get props => [filter, ended, loadingEnded, error];
}

/// Filtrni qo'llaydi; jonli ro'yxat DashboardCubit'dan, tugaganlar alohida yuklanadi.
class SessionsCubit extends Cubit<SessionsState> {
  SessionsCubit(this._repo) : super(const SessionsState());
  final SessionsRepository _repo;

  Future<void> setFilter(SessionFilter f) async {
    emit(state.copyWith(filter: f, clearError: true));
    if (f == SessionFilter.ended) await loadEnded();
  }

  Future<void> loadEnded() async {
    emit(state.copyWith(loadingEnded: true, clearError: true));
    try {
      final done = await _repo.byStatus(SessionStatus.done);
      final ended = await _repo.byStatus(SessionStatus.ended);
      final all = [...done, ...ended]
        ..sort((a, b) => b.lastSeenAt.compareTo(a.lastSeenAt));
      emit(state.copyWith(ended: all, loadingEnded: false));
    } on ApiException catch (e) {
      emit(state.copyWith(loadingEnded: false, error: e.userMessage));
    }
  }

  /// Joriy filtr bo'yicha ro'yxat.
  static List<SessionDto> apply(
    SessionFilter f,
    DashboardState d,
    List<SessionDto> ended,
  ) {
    final live = d.sessions;
    final list = switch (f) {
      SessionFilter.all =>
        live.where((s) => s.status != SessionStatus.ended).toList(),
      SessionFilter.attention =>
        live
            .where(
              (s) =>
                  s.status == SessionStatus.waiting ||
                  s.status == SessionStatus.awaitingApproval,
            )
            .toList(),
      SessionFilter.working =>
        live.where((s) => s.status == SessionStatus.working).toList(),
      SessionFilter.idle =>
        live.where((s) => s.status == SessionStatus.idle).toList(),
      SessionFilter.ended => ended,
    };
    return list;
  }

  /// Loyiha bo'yicha guruhlash (tartib: ruxsat/kutayotgan loyihalar tepada).
  static Map<String, List<SessionDto>> groupByProject(List<SessionDto> list) {
    int rank(SessionStatus s) => switch (s) {
      SessionStatus.awaitingApproval => 0,
      SessionStatus.waiting => 1,
      SessionStatus.working => 2,
      SessionStatus.idle => 3,
      SessionStatus.done => 4,
      _ => 5,
    };
    final sorted = [...list]
      ..sort((a, b) {
        final r = rank(a.status).compareTo(rank(b.status));
        return r != 0 ? r : b.statusSince.compareTo(a.statusSince);
      });
    final out = <String, List<SessionDto>>{};
    for (final s in sorted) {
      out.putIfAbsent(s.projectName, () => []).add(s);
    }
    return out;
  }
}
