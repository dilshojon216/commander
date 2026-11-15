import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/data/realtime_client.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fixtures/fakes.dart';
import '../fixtures/fixture.dart';

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  late List<FakeWs> sockets;
  late List<Uri> uris;
  late List<List<String>> protocols;
  late RealtimeClient rt;

  setUp(() {
    sockets = [];
    uris = [];
    protocols = [];
    rt = RealtimeClient(
      credentials: () => testCreds,
      backoff: (_) => Duration.zero,
      connector: (uri, p) {
        uris.add(uri);
        protocols.add(p);
        final ws = FakeWs();
        sockets.add(ws);
        return ws;
      },
    );
  });

  tearDown(() => rt.dispose());

  test("wss URL, token faqat subprotocol'da (query'da emas)", () async {
    rt.start();
    await settle();
    expect(uris.single.toString(), 'wss://mac.tail1234.ts.net/ws/client');
    expect(uris.single.toString(), isNot(contains('cmdr_')));
    expect(protocols.single, ['commander.v1', 'cmdr-token.cmdr_TESTTOKEN']);
  });

  test('auth.ok -> subscribe, subscribed -> live; push xabarlar oqimga tushadi', () async {
    final statuses = <RealtimeStatus>[];
    rt.statuses.listen(statuses.add);
    final msgs = <ServerToClientMessage>[];
    rt.messages.listen(msgs.add);
    rt.start();
    await settle();
    final ws = sockets.single;
    ws.serverSend(fixture('ws/server-auth-ok')!);
    await settle();
    final sub = ws.sent.firstWhere((m) => m['type'] == 'subscribe');
    expect((sub['payload'] as Map)['channels'], containsAll(['sessions', 'approvals', 'limits', 'commands']));
    ws.serverSend(fixture('ws/server-subscribed')!);
    await settle();
    expect(rt.status, RealtimeStatus.live);
    ws.serverSend(fixture('ws/server-session-updated')!);
    ws.serverSend(fixture('ws/server-future-unknown')!);
    await settle();
    expect(msgs.whereType<ServerToClientMessageSessionUpdated>(), hasLength(1));
    expect(msgs.whereType<ServerToClientMessageUnknown>(), hasLength(1), reason: "noma'lum xabar ulanishni buzmaydi");
    expect(statuses, contains(RealtimeStatus.live));
  });

  test("close 4010 (token revoke): qayta ulanmaydi, status unauthorized", () async {
    rt.start();
    await settle();
    sockets.single.serverClose(CommanderContract.clientWsCloseRevoked);
    await settle();
    await settle();
    expect(rt.status, RealtimeStatus.unauthorized);
    expect(sockets, hasLength(1));
  });

  test('uzilish: backoff bilan qayta ulanadi va ochiq chatni qayta ochadi', () async {
    rt.start();
    await settle();
    sockets[0].serverSend(fixture('ws/server-subscribed')!);
    await settle();
    rt.openChat('sess-1');
    await settle();
    expect(sockets[0].sent.where((m) => m['type'] == 'chat.open'), hasLength(1));
    sockets[0].serverClose(1006);
    await settle();
    await settle();
    expect(sockets.length, greaterThanOrEqualTo(2));
    sockets[1].serverSend(fixture('ws/server-subscribed')!);
    await settle();
    final reopened = sockets[1].sent.where((m) => m['type'] == 'chat.open').toList();
    expect(reopened, hasLength(1));
    expect(((reopened.single['payload']) as Map)['sessionId'], 'sess-1');
  });

  test("stop(): ulanish yopiladi, status idle (fon rejimi)", () async {
    rt.start();
    await settle();
    await rt.stop();
    expect(rt.status, RealtimeStatus.idle);
  });

  test('wsUri: http (loopback) -> ws, yo\'l qo\'shiladi', () {
    expect(RealtimeClient.wsUri(Uri.parse('http://127.0.0.1:4317')).toString(), 'ws://127.0.0.1:4317/ws/client');
  });
}
