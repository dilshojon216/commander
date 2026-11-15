import 'dart:convert';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/core/network/api_exception.dart';
import 'package:commander_mobile/data/realtime_client.dart';
import 'package:commander_mobile/data/repositories.dart';
import 'package:commander_mobile/data/snapshot.dart';
import 'package:commander_mobile/domain/command_progress.dart';
import 'package:commander_mobile/presentation/dashboard/approval_actions_cubit.dart';
import 'package:commander_mobile/presentation/dashboard/dashboard_cubit.dart';
import 'package:commander_mobile/presentation/new_session/new_session_cubit.dart';
import 'package:commander_mobile/presentation/session/session_cubit.dart';
import 'package:commander_mobile/presentation/sessions/sessions_cubit.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fixtures/fakes.dart';
import '../fixtures/fixture.dart';

Future<void> settle([int ms = 30]) => Future<void>.delayed(Duration(milliseconds: ms));

Map<String, dynamic> env(String type, Map<String, dynamic> payload) => {'v': 1, 'id': '00000000-0000-4000-8000-000000000001', 'type': type, 'ts': 1763092800000, 'payload': payload};

ServerToClientMessage msg(String type, Map<String, dynamic> payload) => ServerToClientMessage.fromJson(env(type, payload));

ApprovalDto pendingApproval({String id = 'ap-1'}) {
  final base = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
  return ApprovalDto.fromJson(patched(base, (m) {
    m['id'] = id;
    m['status'] = 'pending';
    m['deadline'] = DateTime.now().add(const Duration(minutes: 5)).toUtc().toIso8601String();
  }));
}

void main() {
  late FakeCenter center;
  late RealtimeClient rt;

  setUp(() {
    center = FakeCenter();
    rt = RealtimeClient(credentials: () => testCreds);
  });
  tearDown(() => rt.dispose());

  group('DashboardCubit', () {
    test('load: snapshot yuklanadi', () async {
      final cubit = DashboardCubit(repo: OverviewRepository(center.api()), realtime: rt);
      await cubit.load();
      expect(cubit.state.phase, LoadPhase.loaded);
      expect(cubit.state.machines, isNotEmpty);
      expect(cubit.state.limits, isNotNull);
      await cubit.close();
    });

    test("WS push: approval.created, lockdown, session.updated yangilaydi; resolved pending'dan olib tashlaydi", () async {
      final cubit = DashboardCubit(repo: OverviewRepository(center.api()), realtime: rt);
      await cubit.load();
      final a = pendingApproval();
      rt.debugInject(msg('approval.created', {'approval': a.toJson()}));
      await settle();
      expect(cubit.state.pending.map((x) => x.id), contains('ap-1'));
      expect(cubit.state.attention.approvals, hasLength(1));

      rt.debugInject(msg('lockdown.updated', {'enabled': true, 'since': '2026-11-14T04:00:00.000Z'}));
      await settle();
      expect(cubit.state.lockdown, isTrue);

      final resolved = patched(a.toJson(), (m) => m['status'] = 'approved');
      rt.debugInject(msg('approval.resolved', {'approval': resolved}));
      await settle();
      expect(cubit.state.pending.where((x) => x.id == 'ap-1'), isEmpty);
      expect(cubit.state.recent.first.id, 'ap-1');

      final s = sessionJson((m) {
        m['status'] = 'working';
        m['id'] = 'new-session-id';
      });
      rt.debugInject(msg('session.updated', {'session': s}));
      await settle();
      expect(cubit.state.sessions.first.id, 'new-session-id');
      await cubit.close();
    });

    test('birinchi yuklash xatosi: error holati va xato turi; qayta urinish ishlaydi', () async {
      center.routes.remove('GET /v1/machines');
      final cubit = DashboardCubit(repo: OverviewRepository(center.api()), realtime: rt);
      await cubit.load();
      expect(cubit.state.phase, LoadPhase.error);
      expect(cubit.state.error, isNotNull);
      center.routes['GET /v1/machines'] = FakeCenter().routes['GET /v1/machines']!;
      await cubit.refresh();
      expect(cubit.state.phase, LoadPhase.loaded);
      await cubit.close();
    });

    test('401: failure=unauthorized (AuthCubit sessionExpired qiladi)', () async {
      center.json('GET', '/v1/machines', {'error': 'unauthorized', 'message': 'x'}, status: 401);
      final cubit = DashboardCubit(repo: OverviewRepository(center.api()), realtime: rt);
      await cubit.load();
      expect(cubit.state.failure, ApiFailure.unauthorized);
      await cubit.close();
    });

    test('ulanish live bo\'lganda snapshot qayta olinadi (subscribe -> REST)', () async {
      final cubit = DashboardCubit(repo: OverviewRepository(center.api()), realtime: rt);
      await cubit.load();
      final before = center.requests.where((r) => r.url.path == '/v1/machines').length;
      rt.debugSetStatus(RealtimeStatus.live);
      await settle(100);
      expect(center.requests.where((r) => r.url.path == '/v1/machines').length, greaterThan(before));
      expect(cubit.state.connection, RealtimeStatus.live);
      await cubit.close();
    });
  });

  group('ApprovalActionsCubit', () {
    test('muvaffaqiyat: onResolved chaqiriladi, holat done', () async {
      final a = pendingApproval();
      center.json('POST', '/v1/approvals/ap-1/decision', {
        'approval': patched(a.toJson(), (m) => m['status'] = 'approved'),
        'delivered': true,
        'idempotent': false,
      });
      ApprovalDto? got;
      final cubit = ApprovalActionsCubit(control: ControlRepository(center.api()), onResolved: (x) => got = x, onConflict: () {});
      await cubit.decide(a, ApprovalBehavior.allow);
      expect(got?.status, ApprovalStatus.approved);
      expect(cubit.state.of('ap-1')?.status, ApprovalActionStatus.done);
      final body = jsonDecode(center.requests.last.body) as Map;
      expect(body['behavior'], 'allow');
      await cubit.close();
    });

    test('409: xato matni va onConflict; 403 lockdown: tushunarli xabar', () async {
      final a = pendingApproval();
      var conflicts = 0;
      center.json('POST', '/v1/approvals/ap-1/decision', {'error': 'approval_conflict', 'message': 'x'}, status: 409);
      final cubit = ApprovalActionsCubit(control: ControlRepository(center.api()), onResolved: (_) {}, onConflict: () => conflicts++);
      await cubit.decide(a, ApprovalBehavior.allow);
      expect(cubit.state.of('ap-1')?.status, ApprovalActionStatus.failed);
      expect(cubit.state.of('ap-1')?.message, contains('Allaqachon hal qilingan'));
      expect(conflicts, 1);

      center.json('POST', '/v1/approvals/ap-1/decision', {'error': 'lockdown', 'message': 'x'}, status: 403);
      await cubit.decide(a, ApprovalBehavior.allow);
      expect(cubit.state.of('ap-1')?.message, contains('Lockdown'));
      await cubit.close();
    });

    test('savolga javob: allow + answers (indeks) yuboriladi', () async {
      final a = pendingApproval();
      center.json('POST', '/v1/approvals/ap-1/decision', {'approval': patched(a.toJson(), (m) => m['status'] = 'approved'), 'delivered': true, 'idempotent': false});
      final cubit = ApprovalActionsCubit(control: ControlRepository(center.api()), onResolved: (_) {}, onConflict: () {});
      await cubit.decide(a, ApprovalBehavior.allow, answers: const [AskAnswer(q: 0, picks: [1])]);
      final body = jsonDecode(center.requests.last.body) as Map;
      expect(body, {'behavior': 'allow', 'answers': [{'q': 0, 'picks': [1]}]});
      await cubit.close();
    });

    test('Fikr bilan rad: message yuboriladi', () async {
      final a = pendingApproval();
      center.json('POST', '/v1/approvals/ap-1/decision', {'approval': patched(a.toJson(), (m) => m['status'] = 'denied'), 'delivered': true, 'idempotent': false});
      final cubit = ApprovalActionsCubit(control: ControlRepository(center.api()), onResolved: (_) {}, onConflict: () {});
      await cubit.decide(a, ApprovalBehavior.deny, message: 'Avval testlarni yoz');
      final body = jsonDecode(center.requests.last.body) as Map;
      expect(body, {'behavior': 'deny', 'message': 'Avval testlarni yoz'});
      await cubit.close();
    });
  });

  group('SessionDetailCubit', () {
    SessionDetailCubit make(String id) => SessionDetailCubit(
          sessionId: id,
          sessions: SessionsRepository(center.api()),
          control: ControlRepository(center.api()),
          realtime: rt,
        );

    test('start: REST sessiya + chat.items (replace/upsert) + chat.state', () async {
      final s = sessionJson();
      center.json('GET', '/v1/sessions/${s['id']}', s);
      final cubit = make(s['id'] as String);
      await cubit.start();
      expect(cubit.state.session?.id, s['id']);
      rt.debugInject(msg('chat.items', {
        'sessionId': s['id'],
        'replace': true,
        'cursor': 'older-1',
        'items': [
          {'id': 'u1', 'ts': 1, 'kind': 'user', 'text': 'salom'},
          {'id': 'a1', 'ts': 2, 'kind': 'assistant', 'text': '**javob**'},
        ],
      }));
      rt.debugInject(msg('chat.items', {'sessionId': 'boshqa-sessiya', 'items': [{'id': 'x', 'ts': 1, 'kind': 'user', 'text': 'x'}]}));
      rt.debugInject(msg('chat.state', {'sessionId': s['id'], 'state': 'live'}));
      await settle();
      expect(cubit.state.timeline.items, hasLength(2), reason: 'boshqa sessiya chati aralashmaydi');
      expect(cubit.state.timeline.olderCursor, 'older-1');
      expect(cubit.state.chatState, ChatState.live);
      await cubit.close();
    });

    test("chat.state offline/unavailable ko'rinadi; session.updated sessiyani yangilaydi", () async {
      final s = sessionJson();
      center.json('GET', '/v1/sessions/${s['id']}', s);
      final cubit = make(s['id'] as String);
      await cubit.start();
      rt.debugInject(msg('chat.state', {'sessionId': s['id'], 'state': 'offline'}));
      rt.debugInject(msg('session.updated', {'session': patched(s, (m) => m['status'] = 'idle')}));
      await settle();
      expect(cubit.state.chatState, ChatState.offline);
      expect(cubit.state.session?.status, SessionStatus.idle);
      await cubit.close();
    });

    test('prompt yuborish: buyruq yaratiladi va holati kuzatiladi; lockdown 403 xato', () async {
      final s = sessionJson();
      center.json('GET', '/v1/sessions/${s['id']}', s);
      center.json('POST', '/v1/commands', {'command': commandJson(status: 'running', stepUp: false), 'idempotent': false}, status: 201);
      final cubit = make(s['id'] as String);
      await cubit.start();
      await cubit.sendPrompt('davom et');
      expect(cubit.state.progress?.phase, CommandPhase.inProgress);
      expect(cubit.state.draftCleared, 1);
      final body = jsonDecode(center.requests.where((r) => r.url.path == '/v1/commands').first.body) as Map;
      expect(body['type'], 'session.prompt');
      expect(body['text'], 'davom et');

      rt.debugInject(msg('command.updated', {'command': commandJson(status: 'done', stepUp: false)}));
      await settle();
      expect(cubit.state.progress?.phase, CommandPhase.done);

      center.json('POST', '/v1/commands', {'error': 'lockdown', 'message': 'x'}, status: 403);
      await cubit.stop();
      expect(cubit.state.actionError, contains('Lockdown'));
      await cubit.close();
    });
  });

  group('NewSessionCubit', () {
    test("start -> \"Telegram'da tasdiqlang\" -> command.updated done -> sessiya ochiladi", () async {
      final sess = sessionJson();
      center.json('GET', '/v1/templates', {'items': []});
      center.json('POST', '/v1/commands', {'command': commandJson(), 'idempotent': false}, status: 201);
      final cubit = NewSessionCubit(
        control: ControlRepository(center.api()),
        projects: ProjectsRepository(center.api()),
        sessions: SessionsRepository(center.api()),
        realtime: rt,
      );
      await cubit.init();
      expect(cubit.state.canSubmit, isFalse);
      cubit.selectMachine('185b42c0-0781-4f16-8936-12e044bdc818');
      cubit.setCwd('/work/p');
      cubit.setPrompt('testlarni yurgiz');
      expect(cubit.state.canSubmit, isTrue);
      await cubit.submit();
      expect(cubit.state.progress?.phase, CommandPhase.awaitingTelegram);
      expect(cubit.state.progress?.text, "Telegram'da tasdiqlang");
      expect(cubit.state.canSubmit, isFalse, reason: 'tasdiq kutilayotganda qayta yuborib bo\'lmaydi');
      final start = jsonDecode(center.requests.firstWhere((r) => r.method == 'POST' && r.url.path == '/v1/commands').body) as Map;
      expect(start['permissionMode'], 'default');
      expect(start['cwd'], '/work/p');

      rt.debugInject(msg('command.updated', {'command': patched(commandJson(status: 'done'), (m) => m['sessionId'] = sess['id'])}));
      await settle();
      expect(cubit.state.openedSessionId, sess['id']);
      await cubit.close();
    });

    test('step-up bajarilmasa (Telegram yo\'q): xato matni', () async {
      center.json('GET', '/v1/templates', {'items': []});
      center.json('POST', '/v1/commands', {'command': commandJson(status: 'failed', errorCode: 'step_up_unavailable'), 'idempotent': false}, status: 201);
      final cubit = NewSessionCubit(control: ControlRepository(center.api()), projects: ProjectsRepository(center.api()), sessions: SessionsRepository(center.api()), realtime: rt);
      await cubit.init(machineId: 'm1');
      cubit.setCwd('/w');
      cubit.setPrompt('x');
      await cubit.submit();
      expect(cubit.state.progress?.phase, CommandPhase.failed);
      expect(cubit.state.progress?.text, contains('Telegram'));
      await cubit.close();
    });
  });

  group('SessionsCubit', () {
    test('filtr va loyiha bo\'yicha guruhlash (ruxsat kutayotganlar tepada)', () async {
      final cubit = SessionsCubit(SessionsRepository(center.api()));
      final a = SessionDto.fromJson(sessionJson((m) {
        m['id'] = 'a';
        m['status'] = 'working';
        m['projectName'] = 'P1';
      }));
      final b = SessionDto.fromJson(sessionJson((m) {
        m['id'] = 'b';
        m['status'] = 'awaiting_approval';
        m['projectName'] = 'P1';
      }));
      final c = SessionDto.fromJson(sessionJson((m) {
        m['id'] = 'c';
        m['status'] = 'idle';
        m['projectName'] = 'P2';
      }));
      final d = DashboardState(phase: LoadPhase.loaded, sessions: [a, b, c]);
      expect(SessionsCubit.apply(SessionFilter.attention, d, const []).map((s) => s.id), ['b']);
      expect(SessionsCubit.apply(SessionFilter.working, d, const []).map((s) => s.id), ['a']);
      expect(SessionsCubit.apply(SessionFilter.all, d, const []), hasLength(3));
      final g = SessionsCubit.groupByProject(SessionsCubit.apply(SessionFilter.all, d, const []));
      expect(g.keys, ['P1', 'P2']);
      expect(g['P1']!.first.id, 'b');
      await cubit.close();
    });
  });
}
