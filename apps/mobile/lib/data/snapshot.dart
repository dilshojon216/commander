import 'package:commander_contracts/commander_contracts.dart';

import '../core/network/api_exception.dart';
import 'center_api.dart';

/// Bosh ekran uchun REST snapshot (WS `subscribe` dan KEYIN olinadi).
class DashboardSnapshot {
  const DashboardSnapshot({
    required this.machines,
    required this.sessions,
    required this.pending,
    required this.recent,
    this.limits,
    this.usage,
    this.alerts = const [],
    this.health,
  });

  final List<MachineDto> machines;
  final List<SessionDto> sessions;
  final List<ApprovalDto> pending;
  final List<ApprovalDto> recent;
  final LimitsResponse? limits;
  final UsageSummaryResponse? usage;
  final List<AlertDto> alerts;
  final HealthSummaryResponse? health;
}

class OverviewRepository {
  const OverviewRepository(this._api);
  final CenterApi _api;

  /// Majburiy: mashinalar, sessiyalar, ruxsatlar (xato = butun yuklash xato).
  /// Ixtiyoriy: limit, token, ogohlantirish, salomatlik (xato = bo'sh, lekin autentifikatsiya xatosi ko'tariladi).
  Future<DashboardSnapshot> load() async {
    final required = await Future.wait<Object?>([
      _api.machines(),
      _api.sessions(active: true, limit: 200),
      _api.approvals(),
    ]);
    final optional = await Future.wait<Object?>([
      _opt(_api.limits),
      _opt(_api.usageSummary),
      _opt(_api.alerts),
      _opt(_api.healthSummary),
    ]);
    final approvals = required[2] as ListApprovalsResponse;
    return DashboardSnapshot(
      machines: (required[0] as ListMachinesResponse).items,
      sessions: (required[1] as ListSessionsResponseV1).items,
      pending: approvals.pending,
      recent: approvals.recent,
      limits: optional[0] as LimitsResponse?,
      usage: optional[1] as UsageSummaryResponse?,
      alerts: (optional[2] as ListAlertsResponse?)?.items ?? const [],
      health: optional[3] as HealthSummaryResponse?,
    );
  }

  Future<UsageSummaryResponse?> usageSummary() => _opt(_api.usageSummary);
  Future<HealthSummaryResponse?> health() => _opt(_api.healthSummary);

  Future<T?> _opt<T>(Future<T> Function() f) async {
    try {
      return await f();
    } on ApiException catch (e) {
      if (e.failure == ApiFailure.unauthorized ||
          e.failure == ApiFailure.unreachable)
        rethrow;
      return null;
    }
  }
}
