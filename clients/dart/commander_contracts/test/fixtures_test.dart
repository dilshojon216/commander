import 'dart:convert';
import 'dart:io';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:test/test.dart';

/// clients/fixtures/*.json: jonli center'dan olingan (tozalangan) REST javoblari va WS namunalari.
/// Hammasi dekodlanadi, qayta kodlanadi va yana dekodlanganda bir xil JSON beradi.
final fixturesDir = Directory('${Directory.current.path}/../../fixtures');

Object? load(String name) => jsonDecode(File('${fixturesDir.path}/$name.json').readAsStringSync());

/// `fromJson` -> `toJson` -> `fromJson` -> `toJson`: ikki marta kodlash natijasi bir xil bo'lishi shart.
T roundTrip<T>(String name, T Function(Object?) fromJson, Object? Function(T) toJson) {
  final a = fromJson(load(name));
  final json1 = jsonDecode(jsonEncode(toJson(a)));
  final b = fromJson(json1);
  expect(jsonDecode(jsonEncode(toJson(b))), json1, reason: '$name round-trip');
  return a;
}

void main() {
  test('REST fixture\'lari dekodlanadi', () {
    roundTrip('machines', ListMachinesResponse.fromJson, (v) => v.toJson());
    roundTrip('sessions', ListSessionsResponseV1.fromJson, (v) => v.toJson());
    roundTrip('session-events', ListSessionEventsResponseV1.fromJson, (v) => v.toJson());
    roundTrip('projects', ListProjectsResponse.fromJson, (v) => v.toJson());
    roundTrip('project-detail', ProjectDetailDto.fromJson, (v) => v.toJson());
    roundTrip('project-tasks', ProjectTasksResponse.fromJson, (v) => v.toJson());
    roundTrip('project-commits', ListProjectCommitsResponse.fromJson, (v) => v.toJson());
    roundTrip('usage-summary', UsageSummaryResponse.fromJson, (v) => v.toJson());
    roundTrip('usage-series', UsageResponse.fromJson, (v) => v.toJson());
    roundTrip('limits', LimitsResponse.fromJson, (v) => v.toJson());
    roundTrip('approvals', ListApprovalsResponse.fromJson, (v) => v.toJson());
    roundTrip('approval', ApprovalDto.fromJson, (v) => v.toJson());
    roundTrip('queue', ListQueueResponse.fromJson, (v) => v.toJson());
    roundTrip('alerts', ListAlertsResponse.fromJson, (v) => v.toJson());
    roundTrip('health-summary', HealthSummaryResponse.fromJson, (v) => v.toJson());
    roundTrip('machine-health', MachineHealthResponse.fromJson, (v) => v.toJson());
    roundTrip('templates', ListTemplatesResponse.fromJson, (v) => v.toJson());
    roundTrip('orchestrations', ListOrchestrationsResponse.fromJson, (v) => v.toJson());
    roundTrip('tasks', ListTasksResponse.fromJson, (v) => v.toJson());
  });

  test('sessiya maydonlari', () {
    final s = roundTrip('sessions', ListSessionsResponseV1.fromJson, (v) => v.toJson()).items.first;
    expect(s.status, SessionStatus.waiting);
    expect(s.notificationType, 'permission_prompt');
    expect(s.endedAt, isNull);
    expect(s.controllable, isTrue);
    expect(ContractDates.tryParse(s.startedAt), isNotNull);
  });

  test('limit oynalari `source` bilan keladi (CLAUDE.md qoidasi 6)', () {
    final l = roundTrip('limits', LimitsResponse.fromJson, (v) => v.toJson());
    expect(l.freshSeconds, 180);
    expect([LimitSource.official, LimitSource.estimate], contains(l.fiveHour!.source));
  });

  test('noma\'lum enum qiymati yiqitmaydi', () {
    final json = load('sessions') as Map<String, dynamic>;
    (json['items'] as List)[0]['status'] = 'teleporting_v9';
    final list = ListSessionsResponseV1.fromJson(json);
    expect(list.items.first.status, SessionStatus.unknown);
  });

  test('server xabarlari (diskriminant: type)', () {
    ServerToClientMessage decode(String n) => roundTrip('ws/$n', ServerToClientMessage.fromJson, (v) => v.toJson());

    final ok = decode('server-auth-ok') as ServerToClientMessageAuthOk;
    expect(ok.value.payload.scopes, [ClientTokenScope.read, ClientTokenScope.approve]);
    expect(ok.value.payload.lockdown.enabled, isFalse);
    expect(ok.value.payload.lockdown.since, isNull);

    final su = decode('server-session-updated') as ServerToClientMessageSessionUpdated;
    expect(su.value.payload.session.status, SessionStatus.waiting);

    final tick = decode('server-usage-tick') as ServerToClientMessageUsageTick;
    expect(tick.value.payload.total.requests, 3);
    expect(tick.value.payload.total.costUsd, closeTo(0.4321, 1e-9));
    expect(tick.value.payload.byProject.first.projectId, isNull);

    final ld = decode('server-lockdown-updated') as ServerToClientMessageLockdownUpdated;
    expect(ld.value.payload.enabled, isTrue);

    expect(decode('server-approval-created'), isA<ServerToClientMessageApprovalCreated>());
    expect(decode('server-limits-updated'), isA<ServerToClientMessageLimitsUpdated>());
    expect(decode('server-machine-updated'), isA<ServerToClientMessageMachineUpdated>());
    expect(decode('server-pong'), isA<ServerToClientMessagePong>());
    expect(decode('server-subscribed'), isA<ServerToClientMessageSubscribed>());
    final err = decode('server-error') as ServerToClientMessageError;
    expect(err.value.payload.code, ServerErrorMessagePayloadCode.rateLimited);
  });

  test('kelajakdagi server xabari `Unknown` bo\'ladi', () {
    final m = roundTrip('ws/server-future-unknown', ServerToClientMessage.fromJson, (v) => v.toJson());
    expect(m, isA<ServerToClientMessageUnknown>());
    expect(m.tag, 'something.from.the.future');
    expect(((m as ServerToClientMessageUnknown).raw['payload'] as Map)['hello'], 'world');
  });

  test('chat elementlari: barcha kind\'lar va kelajakdagi kind', () {
    final m = roundTrip('ws/server-chat-items', ServerToClientMessage.fromJson, (v) => v.toJson())
        as ServerToClientMessageChatItems;
    final items = m.value.payload.items;
    expect(items.length, 8);
    expect((items[0] as ChatItemUser).value.variant, ChatUserItemVariant.prompt);
    expect((items[1] as ChatItemAssistant).value.model, 'sonnet');
    expect(items[2], isA<ChatItemThinking>());
    expect((items[3] as ChatItemToolUse).value.lines?.added, 3);
    expect((items[4] as ChatItemToolResult).value.ok, isTrue);
    expect((items[5] as ChatItemNotice).value.code, ChatNoticeItemCode.info);
    expect((items[6] as ChatItemUsage).value.cacheReadTokens, 300);
    expect(items[7], isA<ChatItemUnknown>());
    expect(items[7].tag, 'future_kind_v9');
    expect(m.value.payload.replace, isTrue);
    expect(m.value.payload.cursor, isNull);
  });

  test('klient xabarlari va so\'rov tanalari', () {
    final sub = ClientSubscribeMessage(
      id: '00000000-0000-4000-8000-000000000011',
      ts: 1763092800000,
      payload: const ClientSubscribePayload(channels: [ClientChannel.sessions, ClientChannel.approvals]),
    );
    final wire = sub.toJson();
    expect(wire['type'], 'subscribe');
    expect(wire['v'], 1);
    expect((wire['payload'] as Map)['channels'], ['sessions', 'approvals']);

    roundTrip('ws/client-auth', ClientToServerMessage.fromJson, (v) => v.toJson());
    roundTrip('ws/client-subscribe', ClientToServerMessage.fromJson, (v) => v.toJson());
    roundTrip('ws/client-ping', ClientToServerMessage.fromJson, (v) => v.toJson());

    final start = CreateCommandBodySessionStart(
      machineId: '00000000-0000-4000-8000-000000000001',
      cwd: '/tmp/x',
      prompt: 'go',
      permissionMode: RemotePermissionMode.acceptEdits,
    );
    final body = CreateCommandBodySessionStart.fromJson(start.toJson()).toJson();
    expect(body['type'], 'session.start');
    expect(body['permissionMode'], 'acceptEdits');
    expect(body.containsKey('name'), isFalse, reason: 'ixtiyoriy maydon yozilmaydi');

    roundTrip('ws/create-command-start', CreateCommandBody.fromJson, (v) => v.toJson());
    roundTrip('ws/create-command-prompt', CreateCommandBody.fromJson, (v) => v.toJson());
    roundTrip('ws/approval-decision-body', ApprovalDecisionBody.fromJson, (v) => v.toJson());
  });

  test('pairing turlari', () {
    final body = roundTrip('ws/pair-body', ClientPairBody.fromJson, (v) => v.toJson());
    expect(body.platform, 'ios');
    expect(body.publicKey, isNull);
    final res = roundTrip('ws/pair-response', ClientPairResponse.fromJson, (v) => v.toJson());
    expect(res.token.startsWith(CommanderContract.clientTokenPrefix), isTrue);
    expect(res.kind, ClientDeviceKind.mobile);
    final me = roundTrip('ws/device-me', ClientDeviceMeResponse.fromJson, (v) => v.toJson());
    expect(me.stepUpExempt, isFalse);
    expect(me.lastUsedAt, isNull);
  });

  test('pairing URL va subprotocol', () {
    final p = PairingUrl.parse('commander://pair?c=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCDE-FGHJK&fp=sha256%3Aabc')!;
    expect(p.centerUrl.toString(), 'https://mac.tail1234.ts.net');
    expect(p.code, 'ABCDE-FGHJK');
    expect(p.fingerprint, 'sha256:abc');
    expect(PairingUrl.parse('commander://pair?c=http%3A%2F%2Fevil.example&code=X'), isNull);
    expect(PairingUrl.parse('commander://pair?c=http%3A%2F%2F127.0.0.1%3A4317&code=X'), isNotNull);
    expect(PairingUrl.parse('https://pair?c=https%3A%2F%2Fa.b&code=X'), isNull);
    expect(ClientWebSocketAuth.subprotocols('cmdr_t'), ['commander.v1', 'cmdr-token.cmdr_t']);
  });

  test('sanalar', () {
    expect(ContractDates.tryParse('2026-11-14T04:00:28.445Z'), isNotNull);
    expect(ContractDates.tryParse('yesterday'), isNull);
  });
}
