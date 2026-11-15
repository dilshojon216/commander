import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';

class TokensState extends Equatable {
  const TokensState({
    this.phase = LoadPhase.initial,
    this.days = 14,
    this.series,
    this.error,
  });
  final LoadPhase phase;
  final int days;
  final UsageResponse? series;
  final String? error;

  /// Kunlik jami (cache read bilan) — chiziqli grafik uchun.
  List<({DateTime day, double total})> get points {
    final s = series;
    if (s == null || s.series.isEmpty) return const [];
    return [
      for (final p in s.series.first.points)
        (
          day:
              DateTime.tryParse(p.t)?.toLocal() ??
              DateTime.fromMillisecondsSinceEpoch(0),
          total:
              p.inputTokens +
              p.outputTokens +
              p.cacheReadTokens +
              p.cacheCreationTokens,
        ),
    ];
  }

  @override
  List<Object?> get props => [phase, days, series, error];
}

class TokensCubit extends Cubit<TokensState> {
  TokensCubit(this._repo) : super(const TokensState());
  final UsageRepository _repo;

  Future<void> load({int? days}) async {
    final d = days ?? state.days;
    emit(TokensState(phase: LoadPhase.loading, days: d, series: state.series));
    try {
      final s = await _repo.series(days: d);
      emit(TokensState(phase: LoadPhase.loaded, days: d, series: s));
    } on ApiException catch (e) {
      emit(
        TokensState(
          phase: state.series == null ? LoadPhase.error : LoadPhase.loaded,
          days: d,
          series: state.series,
          error: e.userMessage,
        ),
      );
    }
  }
}
