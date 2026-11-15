import 'package:commander_mobile/app_dependencies.dart';
import 'package:commander_mobile/core/storage/credentials.dart';
import 'package:commander_mobile/core/storage/credentials_holder.dart';
import 'package:commander_mobile/data/biometric_gate.dart';
import 'package:commander_mobile/data/realtime_client.dart';
import 'package:commander_mobile/presentation/app/app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../fixtures/fakes.dart';
import '../fixtures/fixture.dart';

AppDependencies deps(FakeCenter center, {Credentials? creds, FakeGate? gate}) {
  final holder = CredentialsHolder();
  return AppDependencies(
    holder: holder,
    store: MemoryCredentialsStore(creds),
    api: center.api(holder: holder),
    // Ochiq, lekin jim WS (xabar kelmaydi): REST snapshot yetarli.
    realtime: RealtimeClient(credentials: () => holder.value, connector: (_, _) => FakeWs(), backoff: (_) => const Duration(milliseconds: 10)),
    gate: gate ?? FakeGate(GateResult.confirmed),
    device: FakeDevice(),
  );
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // Pulsatsiya animatsiyasi tugamaydi: pumpAndSettle o'rniga bir necha kadr.
  Future<void> frames(WidgetTester t) async {
    for (var i = 0; i < 12; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> shutdown(WidgetTester t, AppDependencies d) async {
    await t.pumpWidget(const SizedBox());
    await d.realtime.dispose();
    await t.pump(const Duration(milliseconds: 50));
  }

  Future<void> boot(WidgetTester t, AppDependencies d) async {
    await t.pumpWidget(CommanderApp(deps: d));
    await frames(t);
  }

  testWidgets('juftlanmagan: Pairing ekrani', (t) async {
    final d = deps(FakeCenter());
    await boot(t, d);
    expect(find.text('Markazga ulanish'), findsOneWidget);
    await shutdown(t, d);
  });

  testWidgets('juftlangan: Umumiy, diqqat kartasi, ruxsat tafsiloti sahifasi (provider\'lar Navigator ostida ham ko\'rinadi)', (t) async {
    t.view.physicalSize = const Size(900, 2400);
    t.view.devicePixelRatio = 2.0;
    addTearDown(t.view.reset);
    final center = FakeCenter();
    final a = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
    center.json('GET', '/v1/approvals', {
      'pending': [
        patched(a, (m) {
          m['id'] = 'ap-77';
          m['status'] = 'pending';
          m['toolName'] = 'Bash';
          m['toolInputRedacted'] = 'rm -rf build';
          m['deadline'] = DateTime.now().add(const Duration(minutes: 3)).toUtc().toIso8601String();
        })
      ],
      'recent': [],
    });
    final gate = FakeGate(GateResult.confirmed);
    center.json('POST', '/v1/approvals/ap-77/decision', {
      'approval': patched(a, (m) {
        m['id'] = 'ap-77';
        m['status'] = 'approved';
      }),
      'delivered': true,
      'idempotent': false,
    });
    final d = deps(center, creds: testCreds, gate: gate);
    await boot(t, d);

    expect(find.text('Commander'), findsWidgets);
    expect(find.text('Sessiyalar'), findsWidgets);
    expect(find.text('rm -rf build'), findsOneWidget);

    // Ruxsat: biometrik/qurilma tasdig'idan keyin qaror yuboriladi.
    await t.tap(find.text('Ruxsat'));
    await frames(t);
    expect(gate.calls, 1);
    expect(center.requests.where((r) => r.url.path == '/v1/approvals/ap-77/decision'), hasLength(1));
    expect(find.text('rm -rf build'), findsNothing, reason: 'hal qilingan so\'rov diqqat ro\'yxatidan chiqadi');

    // Sozlamalar sahifasi (push qilingan route) cubit'larni ko'radi.
    await t.tap(find.byTooltip('Sozlamalar'));
    await frames(t);
    expect(find.text('ULANGAN MARKAZ'), findsOneWidget);
    expect(find.textContaining('mac.tail1234.ts.net'), findsOneWidget);
    await shutdown(t, d);
  });

  testWidgets("biometrik tasdiq rad etilsa qaror YUBORILMAYDI", (t) async {
    t.view.physicalSize = const Size(900, 2400);
    t.view.devicePixelRatio = 2.0;
    addTearDown(t.view.reset);
    final center = FakeCenter();
    final a = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
    center.json('GET', '/v1/approvals', {
      'pending': [patched(a, (m) {
        m['id'] = 'ap-88';
        m['status'] = 'pending';
        m['deadline'] = DateTime.now().add(const Duration(minutes: 3)).toUtc().toIso8601String();
      })],
      'recent': [],
    });
    final gate = FakeGate(GateResult.denied);
    final d = deps(center, creds: testCreds, gate: gate);
    await boot(t, d);
    await t.tap(find.text('Ruxsat'));
    await frames(t);
    expect(gate.calls, 1);
    expect(center.requests.where((r) => r.method == 'POST'), isEmpty);
    await shutdown(t, d);
  });

  testWidgets('markazga ulanib bo\'lmasa: tushunarli xato + Tailscale maslahati', (t) async {
    final center = FakeCenter();
    center.routes['GET /v1/machines'] = (_) => throw http.ClientException('no route to host');
    final d = deps(center, creds: testCreds);
    await boot(t, d);
    expect(find.textContaining('Tailscale'), findsWidgets);
    await shutdown(t, d);
  });
}
