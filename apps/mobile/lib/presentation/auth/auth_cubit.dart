import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../core/storage/credentials.dart';
import '../../core/storage/credentials_holder.dart';
import '../../data/pairing_repository.dart';
import '../../data/realtime_client.dart';

enum AuthPhase { loading, unpaired, paired }

class AuthState extends Equatable {
  const AuthState({
    this.phase = AuthPhase.loading,
    this.credentials,
    this.busy = false,
    this.error,
    this.notice,
  });

  final AuthPhase phase;
  final Credentials? credentials;
  final bool busy;
  final String? error;
  final String? notice;

  AuthState copyWith({
    AuthPhase? phase,
    Credentials? credentials,
    bool clearCredentials = false,
    bool? busy,
    String? error,
    bool clearError = false,
    String? notice,
    bool clearNotice = false,
  }) => AuthState(
    phase: phase ?? this.phase,
    credentials: clearCredentials ? null : (credentials ?? this.credentials),
    busy: busy ?? this.busy,
    error: clearError ? null : (error ?? this.error),
    notice: clearNotice ? null : (notice ?? this.notice),
  );

  @override
  List<Object?> get props => [phase, credentials, busy, error, notice];
}

class AuthCubit extends Cubit<AuthState> {
  AuthCubit({
    required PairingRepository repo,
    required RealtimeClient realtime,
    required CredentialsHolder holder,
  }) : _repo = repo,
       _rt = realtime,
       _holder = holder,
       super(const AuthState());

  final PairingRepository _repo;
  final RealtimeClient _rt;
  final CredentialsHolder _holder;

  Future<void> init() async {
    final c = await _repo.current();
    if (c == null) {
      emit(const AuthState(phase: AuthPhase.unpaired));
      return;
    }
    _holder.value = c;
    emit(AuthState(phase: AuthPhase.paired, credentials: c));
    _rt.start();
  }

  Future<void> pair(PairingInput input) async {
    emit(state.copyWith(busy: true, clearError: true));
    try {
      final c = await _repo.pair(input);
      _holder.value = c;
      emit(AuthState(phase: AuthPhase.paired, credentials: c));
      _rt.start();
    } on ApiException catch (e) {
      emit(state.copyWith(busy: false, error: e.userMessage));
    }
  }

  void pairingInputError(String message) =>
      emit(state.copyWith(error: message, busy: false));

  Future<void> unpair() async {
    emit(state.copyWith(busy: true));
    await _rt.stop();
    final revoked = await _repo.unpair();
    _holder.value = null;
    emit(
      AuthState(
        phase: AuthPhase.unpaired,
        notice: revoked ? 'Qurilma markazdan ajratildi.' : "Markazga ulanib bo'lmadi: lokal token o'chirildi, lekin markazda qurilmani qo'lda bekor qiling (CLI: client revoke).",
      ),
    );
  }

  /// REST/WS 401: token bekor qilingan yoki muddati o'tgan.
  Future<void> sessionExpired() async {
    if (state.phase != AuthPhase.paired) return;
    await _rt.stop();
    await _repo.store.clear();
    _holder.value = null;
    emit(
      const AuthState(
        phase: AuthPhase.unpaired,
        error: 'Qurilma tasdig\'i bekor qilingan yoki muddati o\'tgan. Qayta juftlang.',
      ),
    );
  }
}
