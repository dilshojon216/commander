import 'package:http/http.dart' as http;

import 'core/network/api_client.dart';
import 'core/storage/credentials.dart';
import 'core/storage/credentials_holder.dart';
import 'data/biometric_gate.dart';
import 'data/center_api.dart';
import 'data/device_info.dart';
import 'data/pairing_repository.dart';
import 'data/realtime_client.dart';
import 'data/repositories.dart';
import 'data/snapshot.dart';

/// Qo'lda DI konteyneri (get_it kerak emas: bog'liqliklar kam va testda almashtiriladi).
class AppDependencies {
  AppDependencies({
    required this.holder,
    required this.store,
    required this.api,
    required this.realtime,
    required this.gate,
    required this.device,
    http.Client? client,
  }) : pairing = PairingRepository(api: api, store: store, device: device),
       overview = OverviewRepository(api),
       sessions = SessionsRepository(api),
       projects = ProjectsRepository(api),
       usage = UsageRepository(api),
       queue = QueueRepository(api),
       control = ControlRepository(api);

  factory AppDependencies.production() {
    final holder = CredentialsHolder();
    final client = http.Client();
    final api = CenterApi(
      ApiClient(
        client: client,
        auth: () {
          final c = holder.value;
          return c == null
              ? null
              : ApiAuth(baseUrl: c.centerUrl, token: c.token);
        },
      ),
    );
    return AppDependencies(
      holder: holder,
      store: SecureCredentialsStore(),
      api: api,
      realtime: RealtimeClient(credentials: () => holder.value),
      gate: LocalAuthGate(),
      device: PlatformDeviceIdentityProvider(),
      client: client,
    );
  }

  final CredentialsHolder holder;
  final CredentialsStore store;
  final CenterApi api;
  final RealtimeClient realtime;
  final ConfirmGate gate;
  final DeviceIdentityProvider device;
  final PairingRepository pairing;
  final OverviewRepository overview;
  final SessionsRepository sessions;
  final ProjectsRepository projects;
  final UsageRepository usage;
  final QueueRepository queue;
  final ControlRepository control;
}
