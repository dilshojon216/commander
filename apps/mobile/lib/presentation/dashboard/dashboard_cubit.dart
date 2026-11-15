import 'dart:async';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/realtime_client.dart';
import '../../data/snapshot.dart';
import '../../domain/attention.dart';

enum LoadPhase { initial, loading, loaded, error }

class DashboardState extends Equatable {
  const DashboardState({
    this.phase = LoadPhase.initial,
    this.error,
    this.failure,
    this.machines = const [],
    this.sessions = const [],
    this.pending = const [],
    this.recent = const [],
    this.limits,
    this.usage,
    this.alerts = const [],
    this.health,
    this.lockdown = false,
    this.connection = RealtimeStatus.idle,
    this.refreshing = false,
  });

  final LoadPhase phase;
  final String? error;
  final ApiFailure? failure;
  final List<MachineDto> machines;
  final List<SessionDto> sessions;
  final List<ApprovalDto> pending;
  final List<ApprovalDto> recent;
  final LimitsResponse? limits;
  final UsageSummaryResponse? usage;
  final List<AlertDto> alerts;
  final HealthSummaryResponse? health;
  final bool lockdown;
  final RealtimeStatus connection;
  final bool refreshing;

  Attention get attention => buildAttention(pending, sessions);

  DashboardState copyWith({
    LoadPhase? phase,
    String? error,
    bool clearError = false,
    ApiFailure? failure,
    List<MachineDto>? machines,
    List<SessionDto>? sessions,
    List<ApprovalDto>? pending,
    List<ApprovalDto>? recent,
    LimitsResponse? limits,
    UsageSummaryResponse? usage,
    List<AlertDto>? alerts,
    HealthSummaryResponse? health,
    bool? lockdown,
    RealtimeStatus? connection,
    bool? refreshing,
  }) => DashboardState(
    phase: phase ?? this.phase,
    error: clearError ? null : (error ?? this.error),
    failure: clearError ? null : (failure ?? this.failure),
    machines: machines ?? this.machines,
    sessions: sessions ?? this.sessions,
    pending: pending ?? this.pending,
    recent: recent ?? this.recent,
    limits: limits ?? this.limits,
    usage: usage ?? this.usage,
    alerts: alerts ?? this.alerts,
    health: health ?? this.health,
    lockdown: lockdown ?? this.lockdown,
    connection: connection ?? this.connection,
    refreshing: refreshing ?? this.refreshing,
  );

  @override
  List<Object?> get props => [
    phase,
    error,
    failure,
    machines,
    sessions,
    pending,
    recent,
    limits,
    usage,
    alerts,
    health,
    lockdown,
    connection,
    refreshing,
  ];
}

/// Umumiy (bosh) ma'lumot: REST snapshot + `/ws/client` push'lari bilan yangilanadi.
class DashboardCubit extends Cubit<DashboardState> {
  DashboardCubit({
    required OverviewRepository repo,
    required RealtimeClient realtime,
    this.throttle = const Duration(seconds: 20),
  }) : _repo = repo,
       _rt = realtime,
       super(DashboardState(connection: realtime.status)) {
    _msgSub = _rt.messages.listen(_onMessage);
    _statusSub = _rt.statuses.listen(_onStatus);
  }

  final OverviewRepository _repo;
  final RealtimeClient _rt;
  final Duration throttle;
  StreamSubscription<ServerToClientMessage>? _msgSub;
  StreamSubscription<RealtimeStatus>? _statusSub;
  Timer? _usageTimer;
  Timer? _healthTimer;
  bool _loading = false;
  bool _again = false;

  Future<void> load() async {
    if (_loading) {
      _again = true;
      return;
    }
    _loading = true;
    final first = state.phase != LoadPhase.loaded;
    emit(
      state.copyWith(
        phase: first ? LoadPhase.loading : state.phase,
        refreshing: true,
        clearError: true,
      ),
    );
    try {
      final s = await _repo.load();
      if (isClosed) return;
      emit(
        state.copyWith(
          phase: LoadPhase.loaded,
          refreshing: false,
          machines: s.machines,
          sessions: s.sessions,
          pending: s.pending,
          recent: s.recent,
          limits: s.limits,
          usage: s.usage,
          alerts: s.alerts,
          health: s.health,
          clearError: true,
        ),
      );
    } on ApiException catch (e) {
      if (isClosed) return;
      // Eski ma'lumot saqlanadi; xato banner sifatida ko'rsatiladi.
      emit(
        state.copyWith(
          phase: first ? LoadPhase.error : state.phase,
          refreshing: false,
          error: e.userMessage,
          failure: e.failure,
        ),
      );
    } finally {
      _loading = false;
    }
    if (_again && !isClosed) {
      _again = false;
      unawaited(load());
    }
  }

  Future<void> refresh() => load();

  void _onStatus(RealtimeStatus s) {
    if (isClosed) return;
    emit(state.copyWith(connection: s));
    // Obuna o'rnatilgach (qayta ulanishda ham) snapshot yangilanadi: tartib "subscribe -> REST".
    if (s == RealtimeStatus.live) unawaited(load());
    if (s == RealtimeStatus.unauthorized) {
      emit(
        state.copyWith(
          error: const ApiException(ApiFailure.unauthorized).userMessage,
          failure: ApiFailure.unauthorized,
        ),
      );
    }
  }

  void _onMessage(ServerToClientMessage m) {
    if (isClosed) return;
    switch (m) {
      case ServerToClientMessageAuthOk(:final value):
        emit(state.copyWith(lockdown: value.payload.lockdown.enabled));
      case ServerToClientMessageLockdownUpdated(:final value):
        emit(state.copyWith(lockdown: value.payload.enabled));
      case ServerToClientMessageSessionUpdated(:final value):
        emit(
          state.copyWith(
            sessions: _upsert(
              state.sessions,
              value.payload.session,
              (s) => s.id,
            ),
          ),
        );
      case ServerToClientMessageMachineUpdated(:final value):
        emit(
          state.copyWith(
            machines: _upsert(
              state.machines,
              value.payload.machine,
              (x) => x.id,
            ),
          ),
        );
      case ServerToClientMessageApprovalCreated(:final value):
        applyApproval(value.payload.approval);
      case ServerToClientMessageApprovalResolved(:final value):
        applyApproval(value.payload.approval);
      case ServerToClientMessageLimitsUpdated(:final value):
        emit(state.copyWith(limits: value.payload.limits));
      case ServerToClientMessageAlertCreated(:final value):
        _applyAlert(value.payload.alert);
      case ServerToClientMessageAlertUpdated(:final value):
        _applyAlert(value.payload.alert);
      case ServerToClientMessageUsageTick():
        _usageTimer ??= Timer(throttle, () async {
          _usageTimer = null;
          final u = await _safe(_repo.usageSummary);
          if (u != null && !isClosed) emit(state.copyWith(usage: u));
        });
      case ServerToClientMessageMachineHealth():
        _healthTimer ??= Timer(throttle, () async {
          _healthTimer = null;
          final h = await _safe(_repo.health);
          if (h != null && !isClosed) emit(state.copyWith(health: h));
        });
      default:
        break;
    }
  }

  Future<T?> _safe<T>(Future<T?> Function() f) async {
    try {
      return await f();
    } on ApiException {
      return null;
    }
  }

  /// Ruxsat holati o'zgarganda (WS yoki qaror javobi) ro'yxatlarni yangilaydi.
  void applyApproval(ApprovalDto a) {
    final pending = state.pending.where((p) => p.id != a.id).toList();
    var recent = state.recent.where((p) => p.id != a.id).toList();
    if (a.status == ApprovalStatus.pending) {
      pending.add(a);
    } else {
      recent = [a, ...recent].take(20).toList();
    }
    emit(state.copyWith(pending: pending, recent: recent));
  }

  void _applyAlert(AlertDto a) {
    final rest = state.alerts.where((x) => x.id != a.id).toList();
    emit(
      state.copyWith(alerts: a.state == AlertState.open ? [a, ...rest] : rest),
    );
  }

  static List<T> _upsert<T>(List<T> list, T item, String Function(T) id) {
    final i = list.indexWhere((e) => id(e) == id(item));
    if (i < 0) return [item, ...list];
    final copy = List<T>.of(list);
    copy[i] = item;
    return copy;
  }

  @override
  Future<void> close() async {
    _usageTimer?.cancel();
    _healthTimer?.cancel();
    await _msgSub?.cancel();
    await _statusSub?.cancel();
    return super.close();
  }
}
