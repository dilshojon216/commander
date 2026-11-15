import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';

class QueueState extends Equatable {
  const QueueState({
    this.phase = LoadPhase.initial,
    this.items = const [],
    this.error,
    this.cancelling = const {},
  });
  final LoadPhase phase;
  final List<QueueItemDto> items;
  final String? error;
  final Set<String> cancelling;
  @override
  List<Object?> get props => [phase, items, error, cancelling];
}

class QueueCubit extends Cubit<QueueState> {
  QueueCubit(this._repo) : super(const QueueState());
  final QueueRepository _repo;

  Future<void> load() async {
    emit(
      QueueState(
        phase: state.items.isEmpty ? LoadPhase.loading : LoadPhase.loaded,
        items: state.items,
      ),
    );
    try {
      emit(QueueState(phase: LoadPhase.loaded, items: await _repo.list()));
    } on ApiException catch (e) {
      emit(
        QueueState(
          phase: state.items.isEmpty ? LoadPhase.error : LoadPhase.loaded,
          items: state.items,
          error: e.userMessage,
        ),
      );
    }
  }

  Future<void> cancel(String id) async {
    emit(
      QueueState(
        phase: state.phase,
        items: state.items,
        cancelling: {...state.cancelling, id},
      ),
    );
    try {
      await _repo.cancel(id);
      await load();
    } on ApiException catch (e) {
      emit(
        QueueState(
          phase: LoadPhase.loaded,
          items: state.items,
          error: e.userMessage,
        ),
      );
    }
  }
}
