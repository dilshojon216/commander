import 'dart:convert';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/core/network/api_client.dart';
import 'package:commander_mobile/core/network/api_exception.dart';
import 'package:commander_mobile/core/storage/credentials.dart';
import 'package:commander_mobile/data/pairing_repository.dart';
import 'package:commander_mobile/data/repositories.dart';
import 'package:commander_mobile/data/snapshot.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../fixtures/fakes.dart';
import '../fixtures/fixture.dart';

void main() {
  group('ApiClient xato xaritasi', () {
    test('status -> ApiFailure', () {
      expect(ApiClient.mapError(401, {'error': 'unauthorized'}).failure, ApiFailure.unauthorized);
      expect(ApiClient.mapError(401, {'error': 'invalid_pairing_code'}).failure, ApiFailure.invalidPairingCode);
      expect(ApiClient.mapError(403, {'error': 'lockdown'}).failure, ApiFailure.lockdown);
      expect(ApiClient.mapError(403, {'error': 'forbidden'}).failure, ApiFailure.forbidden);
      expect(ApiClient.mapError(409, {'error': 'approval_conflict'}).failure, ApiFailure.conflict);
      expect(ApiClient.mapError(409, {'error': 'approval_expired'}).userMessage, contains("o'tgan"));
      expect(ApiClient.mapError(429, null).failure, ApiFailure.rateLimited);
      expect(ApiClient.mapError(500, null).failure, ApiFailure.server);
    });

    test('tarmoq xatosi (Tailscale yoqilmagan) = unreachable va tushunarli matn', () async {
      final api = ApiClient(client: MockClient((_) async => throw http.ClientException('no route')), auth: () => ApiAuth(baseUrl: testCreds.centerUrl, token: 't'));
      await expectLater(api.get('/v1/machines'), throwsA(isA<ApiException>().having((e) => e.failure, 'failure', ApiFailure.unreachable)));
      expect(const ApiException(ApiFailure.unreachable).userMessage, allOf(contains('Tailscale'), contains('Markazga ulanib bo')));
    });
  });

  group('CenterApi + fixture\'lar', () {
    test('Bearer token sarlavhada, query\'da emas', () async {
      final center = FakeCenter();
      await center.api().machines();
      final r = center.requests.single;
      expect(r.headers['authorization'], 'Bearer cmdr_TESTTOKEN');
      expect(r.url.toString(), isNot(contains('cmdr_')));
    });

    test('snapshot: majburiy + ixtiyoriy qismlar dekodlanadi', () async {
      final center = FakeCenter();
      final s = await OverviewRepository(center.api()).load();
      expect(s.machines, isNotEmpty);
      expect(s.sessions, isNotEmpty);
      expect(s.limits, isNotNull);
      expect(s.usage, isNotNull);
      expect(s.health, isNotNull);
    });

    test('ixtiyoriy endpoint 404 bo\'lsa snapshot yiqilmaydi, 401 bo\'lsa yiqiladi', () async {
      final center = FakeCenter();
      center.routes.remove('GET /v1/limits');
      expect((await OverviewRepository(center.api()).load()).limits, isNull);
      center.json('GET', '/v1/alerts', {'error': 'unauthorized', 'message': 'x'}, status: 401);
      await expectLater(OverviewRepository(center.api()).load(), throwsA(isA<ApiException>()));
    });

    test('POST /v1/commands: Idempotency-Key va tana (session.start)', () async {
      final center = FakeCenter();
      center.json('POST', '/v1/commands', {'command': commandJson(), 'idempotent': false}, status: 201);
      final res = await ControlRepository(center.api()).startSession(
        machineId: 'm1',
        cwd: '/work/p',
        prompt: 'salom',
        model: 'sonnet',
        mode: RemotePermissionMode.default_,
        idempotencyKey: 'mob-fixed-key-1',
      );
      expect(res.command.status, CommandState.awaitingConfirmation);
      final r = center.requests.single;
      expect(r.headers['Idempotency-Key'], 'mob-fixed-key-1');
      final body = jsonDecode(r.body) as Map;
      expect(body['type'], 'session.start');
      expect(body['permissionMode'], 'default');
      expect(body.containsKey('remoteControl'), isFalse);
    });

    test('qaror: 409 conflict ApiException sifatida', () async {
      final center = FakeCenter();
      center.json('POST', '/v1/approvals/abc/decision', {'error': 'approval_conflict', 'message': 'x'}, status: 409);
      await expectLater(ControlRepository(center.api()).decide('abc', ApprovalBehavior.allow), throwsA(isA<ApiException>().having((e) => e.failure, 'f', ApiFailure.conflict)));
    });
  });

  group('Pairing', () {
    test('havola va qo\'lda kiritish tahlili', () {
      final a = PairingInput.parse(link: 'commander://pair?c=https%3A%2F%2Fmac.ts.net&code=abcde-12345');
      expect(a!.centerUrl.host, 'mac.ts.net');
      expect(a.code, 'ABCDE-12345');
      expect(PairingInput.parse(centerUrl: 'https://mac.ts.net', code: ' abcde-12345 ')!.code, 'ABCDE-12345');
      expect(PairingInput.parse(centerUrl: 'http://mac.ts.net', code: 'X'), isNull, reason: 'http (loopbacksiz) rad etiladi');
      expect(PairingInput.parse(link: 'https://evil.example'), isNull);
      expect(PairingInput.parse(centerUrl: '', code: ''), isNull);
    });

    test('pair: tokenni saqlaydi, deviceName/platform yuboradi', () async {
      final center = FakeCenter();
      center.json('POST', '/v1/clients/pair', fixture('ws/pair-response'), status: 201);
      final store = MemoryCredentialsStore();
      final repo = PairingRepository(api: center.api(), store: store, device: FakeDevice());
      final c = await repo.pair(PairingInput(centerUrl: Uri.parse('https://mac.ts.net'), code: 'ABCDE-12345'));
      expect(store.value, isNotNull);
      expect(c.token, store.value!.token);
      final body = jsonDecode(center.requests.single.body) as Map;
      expect(body['deviceName'], 'Xiaomi Test');
      expect(body['platform'], 'android');
      expect(center.requests.single.headers.containsKey('authorization'), isFalse);
      expect(c.toString(), isNot(contains(c.token)), reason: 'token toString orqali logga tushmasin');
    });

    test("noto'g'ri kod: invalidPairingCode, hech narsa saqlanmaydi", () async {
      final center = FakeCenter();
      center.json('POST', '/v1/clients/pair', {'error': 'invalid_pairing_code', 'message': 'x'}, status: 401);
      final store = MemoryCredentialsStore();
      final repo = PairingRepository(api: center.api(), store: store, device: FakeDevice());
      await expectLater(repo.pair(PairingInput(centerUrl: Uri.parse('https://mac.ts.net'), code: 'BAD')), throwsA(isA<ApiException>().having((e) => e.failure, 'f', ApiFailure.invalidPairingCode)));
      expect(store.value, isNull);
    });

    test('unpair: markazga revoke, lokal token o\'chadi; tarmoq xatosida ham o\'chadi', () async {
      final center = FakeCenter();
      center.json('POST', '/v1/devices/me/revoke', {'revoked': true});
      final store = MemoryCredentialsStore(testCreds);
      expect(await PairingRepository(api: center.api(), store: store, device: FakeDevice()).unpair(), isTrue);
      expect(store.value, isNull);

      final store2 = MemoryCredentialsStore(testCreds);
      final broken = FakeCenter();
      broken.on('POST', '/v1/devices/me/revoke', (_) => throw http.ClientException('offline'));
      expect(await PairingRepository(api: broken.api(), store: store2, device: FakeDevice()).unpair(), isFalse);
      expect(store2.value, isNull);
    });

    test('Credentials JSON aylanishi', () {
      final back = Credentials.tryFromJson(jsonDecode(jsonEncode(testCreds.toJson())));
      expect(back, testCreds);
      expect(Credentials.tryFromJson({'centerUrl': 'x'}), isNull);
    });
  });
}
