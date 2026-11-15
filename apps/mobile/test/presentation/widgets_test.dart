import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/core/storage/credentials_holder.dart';
import 'package:commander_mobile/core/theme/app_theme.dart';
import 'package:commander_mobile/data/pairing_repository.dart';
import 'package:commander_mobile/data/realtime_client.dart';
import 'package:commander_mobile/domain/limit_card.dart';
import 'package:commander_mobile/presentation/auth/auth_cubit.dart';
import 'package:commander_mobile/presentation/pairing/pairing_page.dart';
import 'package:commander_mobile/presentation/session/session_page.dart';
import 'package:commander_mobile/presentation/widgets/cards.dart';
import 'package:commander_mobile/presentation/widgets/safe_markdown.dart';
import 'package:commander_mobile/core/storage/credentials.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fixtures/fakes.dart';
import '../fixtures/fixture.dart';

Widget host(Widget child, {Brightness b = Brightness.dark}) => MaterialApp(theme: AppTheme.build(b), home: Scaffold(body: SingleChildScrollView(child: child)));

ApprovalDto approval({String status = 'pending', String kind = 'tool', Duration left = const Duration(minutes: 4, seconds: 12), String? plan}) {
  final base = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
  return ApprovalDto.fromJson(patched(base, (m) {
    m['status'] = status;
    m['kind'] = kind;
    m['toolName'] = 'Bash';
    m['toolInputRedacted'] = 'docker compose up -d --build api';
    m['deadline'] = DateTime.now().add(left).toUtc().toIso8601String();
    if (plan != null) m['plan'] = plan;
  }));
}

Widget card(ApprovalDto a, {bool scope = true, bool lockdown = false, bool busy = false, VoidCallback? onAllow, VoidCallback? onDeny, String? err}) => host(ApprovalCard(
      approval: a,
      canApproveScope: scope,
      lockdown: lockdown,
      busy: busy,
      onAllow: onAllow ?? () {},
      onDeny: onDeny ?? () {},
      onOpen: () {},
      errorText: err,
    ));

void main() {
  group('ApprovalCard holatlari', () {
    testWidgets('pending: taymer, tool, Ruxsat va Rad ishlaydi', (t) async {
      var allow = 0, deny = 0;
      await t.pumpWidget(card(approval(), onAllow: () => allow++, onDeny: () => deny++));
      expect(find.text('Bash'), findsOneWidget);
      expect(find.text('docker compose up -d --build api'), findsOneWidget);
      expect(find.textContaining('4:1'), findsOneWidget, reason: 'teskari sanoq');
      await t.tap(find.text('Ruxsat'));
      await t.tap(find.text('Rad'));
      expect(allow, 1);
      expect(deny, 1);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('savol: variant tugmalari, Ruxsat yo\'q, (tavsiya), tanlov indeksi', (t) async {
      final base = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
      final a = ApprovalDto.fromJson(patched(base, (m) {
        m['status'] = 'pending';
        m['kind'] = 'question';
        m['deadline'] = DateTime.now().add(const Duration(minutes: 4)).toUtc().toIso8601String();
        m['questions'] = [
          {
            'question': 'Qaysi?',
            'header': 'Tanlov',
            'multiSelect': false,
            'options': [
              {'label': 'A (Recommended)', 'description': 'd1'},
              {'label': 'B', 'description': 'd2'},
            ],
          }
        ];
      }));
      int? picked;
      var deny = 0;
      await t.pumpWidget(host(ApprovalCard(
        approval: a,
        canApproveScope: true,
        lockdown: false,
        busy: false,
        onAllow: () {},
        onDeny: () => deny++,
        onOpen: () {},
        onAnswer: (i) => picked = i,
      )));
      expect(find.text('Ruxsat'), findsNothing);
      expect(find.text('A (tavsiya)'), findsOneWidget);
      await t.tap(find.text('B'));
      expect(picked, 1);
      await t.tap(find.text('Rad etish'));
      expect(deny, 1);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets("lockdown: Ruxsat yopiq (bosilmaydi), Rad ochiq", (t) async {
      var allow = 0, deny = 0;
      await t.pumpWidget(card(approval(), lockdown: true, onAllow: () => allow++, onDeny: () => deny++));
      expect(find.text('Lockdown'), findsOneWidget);
      await t.tap(find.text('Lockdown'), warnIfMissed: false);
      await t.tap(find.text('Rad'));
      expect(allow, 0);
      expect(deny, 1);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets("approve scope yo'q: tugmalar yopiq", (t) async {
      var deny = 0;
      await t.pumpWidget(card(approval(), scope: false, onDeny: () => deny++));
      await t.tap(find.text('Rad'), warnIfMissed: false);
      expect(deny, 0);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('hal qilingan: tugmalar yo\'q, holat yorlig\'i', (t) async {
      await t.pumpWidget(card(approval(status: 'approved')));
      expect(find.text('Ruxsat berildi'), findsWidgets);
      expect(find.text('Rad'), findsNothing);
      await t.pumpWidget(card(approval(status: 'denied')));
      expect(find.text('Rad etildi'), findsWidgets);
      await t.pumpWidget(card(approval(status: 'cancelled')));
      expect(find.textContaining('Bekor qilindi'), findsWidgets);
    });

    testWidgets("muddati o'tgan pending: tugmalar yo'q", (t) async {
      await t.pumpWidget(card(approval(left: const Duration(seconds: -3))));
      expect(find.text("Muddati o'tdi"), findsWidgets);
      expect(find.text('Rad'), findsNothing);
    });

    testWidgets('reja: sarlavha "Reja", xato matni ko\'rinadi', (t) async {
      await t.pumpWidget(card(approval(kind: 'plan', plan: '# Reja'), err: 'Allaqachon hal qilingan (boshqa joyda javob berildi).'));
      expect(find.text('Reja'), findsOneWidget);
      expect(find.textContaining('Allaqachon hal qilingan'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('yuborilmoqda: tugmalar bosilmaydi', (t) async {
      var allow = 0;
      await t.pumpWidget(card(approval(), busy: true, onAllow: () => allow++));
      await t.tap(find.text('Rad'), warnIfMissed: false);
      expect(allow, 0);
      await t.pumpWidget(const SizedBox());
    });
  });

  group('LimitCard holatlari', () {
    LimitWindowView w(Map<String, dynamic> p) => LimitWindowView.fromJson({
          'usedPct': 8.0,
          'resetsAt': '2099-11-15T13:00:00.000Z',
          'observedAt': '2026-11-14T03:58:00.000Z',
          'source': 'official',
          'stale': false,
          'ageSeconds': 120,
          'reset': false,
          ...p,
        });

    testWidgets('rasmiy / taxmin / eskirgan / yangilangan', (t) async {
      final now = DateTime.now();
      Future<void> show(Map<String, dynamic> p) => t.pumpWidget(host(LimitCard(model: buildLimitCard('Haftalik', w(p), now: now))));
      await show({});
      expect(find.text('8%'), findsOneWidget);
      expect(find.text('rasmiy'), findsOneWidget);
      await show({'source': 'estimate', 'usedPct': 12.0, 'stale': true});
      expect(find.text('≈12%'), findsOneWidget);
      expect(find.text('taxmin'), findsOneWidget);
      await show({'stale': true, 'ageSeconds': 10800});
      expect(find.text('eskirgan'), findsOneWidget);
      expect(find.textContaining('3 soat oldin kuzatilgan'), findsOneWidget);
      await show({'reset': true, 'source': 'estimate', 'usedPct': 0.0});
      expect(find.text('≈0%'), findsOneWidget);
      expect(find.text('yangilandi'), findsWidgets);
      await show({'usedPct': 96.0});
      expect(find.text('96%'), findsOneWidget);
    });

    testWidgets("semantika: bitta yorliq ichida qiymat, yorliq va izoh (accessibility)", (t) async {
      final handle = t.ensureSemantics();
      await t.pumpWidget(host(LimitCard(model: buildLimitCard('5 soat', w({'source': 'estimate', 'usedPct': 12.0}), now: DateTime.now()))));
      expect(find.bySemanticsLabel(RegExp('5 soat: ≈12%, taxmin')), findsOneWidget);
      handle.dispose();
    });

    testWidgets('yorug\' mavzuda ham chiziladi', (t) async {
      await t.pumpWidget(host(LimitCard(model: buildLimitCard('5 soat', w({}), now: DateTime.now())), b: Brightness.light));
      expect(find.text('8%'), findsOneWidget);
    });
  });

  group('PromptBox holatlari', () {
    SessionDto s(void Function(Map<String, dynamic>) p) => SessionDto.fromJson(sessionJson(p));

    Widget box(SessionDto session, {bool canControl = true, bool lockdown = false, bool sending = false, List<String>? sent, TextEditingController? ctrl}) => host(PromptBox(
          session: session,
          sending: sending,
          controller: ctrl ?? TextEditingController(),
          canControl: canControl,
          lockdown: lockdown,
          onSend: (x) => sent?.add(x),
        ));

    testWidgets('faol: yozib yuborish ishlaydi', (t) async {
      final sent = <String>[];
      final c = TextEditingController();
      await t.pumpWidget(box(s((m) => m['status'] = 'idle'), sent: sent, ctrl: c));
      expect(tester(t).enabled, isTrue);
      await t.enterText(find.byType(TextField), 'davom et');
      await t.pump();
      await t.tap(find.byTooltip('Yuborish'));
      expect(sent, ['davom et']);
    });

    testWidgets("band: sabab ko'rinadi, yuborish yopiq", (t) async {
      final sent = <String>[];
      await t.pumpWidget(box(s((m) => m['status'] = 'working'), sent: sent));
      expect(find.textContaining('Claude ishlamoqda'), findsOneWidget);
      await t.enterText(find.byType(TextField), 'x');
      await t.pump();
      await t.tap(find.byTooltip('Yuborish'), warnIfMissed: false);
      expect(sent, isEmpty);
    });

    testWidgets("controlReason: maydon o'chiq, sabab matni", (t) async {
      await t.pumpWidget(box(s((m) {
        m['status'] = 'idle';
        m['controllable'] = false;
        m['controlReason'] = 'interactive';
        (m['controls'] as Map)['prompt'] = false;
      })));
      expect(tester(t).enabled, isFalse);
      expect(find.textContaining('faqat ko\'rish'), findsWidgets);
    });

    testWidgets("control scope yo'q / lockdown / oflayn mashina", (t) async {
      await t.pumpWidget(box(s((m) => m['status'] = 'idle'), canControl: false));
      expect(tester(t).enabled, isFalse);
      await t.pumpWidget(box(s((m) => m['status'] = 'idle'), lockdown: true));
      expect(find.textContaining('Lockdown'), findsOneWidget);
      await t.pumpWidget(box(s((m) {
        m['controlReason'] = 'machine_offline';
        (m['controls'] as Map)['prompt'] = false;
      })));
      expect(find.text('Mashina oflayn'), findsOneWidget);
    });
  });

  group('Chat matnini xavfsiz ko\'rsatish', () {
    testWidgets('xom HTML renderlanmaydi (matn), rasm yuklanmaydi', (t) async {
      await t.pumpWidget(host(const SafeMarkdown('Salom <script>alert(1)</script> **qalin**\n\n![x](https://evil.example/a.png)')));
      expect(find.byType(Image), findsNothing);
      expect(find.textContaining('[rasm: x]', findRichText: true), findsOneWidget);
    });
  });

  group('Pairing ekrani', () {
    testWidgets("noto'g'ri kiritish: xato banneri, tarmoqqa chiqmaydi", (t) async {
      final center = FakeCenter();
      final holder = CredentialsHolder();
      final auth = AuthCubit(
        repo: PairingRepository(api: center.api(holder: holder), store: MemoryCredentialsStore(), device: FakeDevice()),
        realtime: RealtimeClient(credentials: () => null),
        holder: holder,
      );
      await t.pumpWidget(MaterialApp(theme: AppTheme.build(Brightness.dark), home: BlocProvider.value(value: auth, child: const PairingPage())));
      expect(find.textContaining('Tailscale'), findsWidgets);
      await t.ensureVisible(find.text('Juftlash'));
      await t.pumpAndSettle();
      await t.tap(find.text('Juftlash'));
      await t.pump();
      expect(find.textContaining("noto'g'ri"), findsOneWidget);
      expect(center.requests, isEmpty);
      await auth.close();
    });
  });
}

TextField tester(WidgetTester t) => t.widget<TextField>(find.byType(TextField));
