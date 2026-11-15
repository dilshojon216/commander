import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/domain/approval_rules.dart';
import 'package:commander_mobile/domain/ask_question.dart';
import 'package:commander_mobile/domain/attention.dart';
import 'package:commander_mobile/domain/command_progress.dart';
import 'package:commander_mobile/domain/prompt_box.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fixtures/fixture.dart';

ApprovalDto approval({String status = 'pending', String kind = 'tool', String? deadline, String? plan}) {
  final base = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
  return ApprovalDto.fromJson(patched(base, (m) {
    m['status'] = status;
    m['kind'] = kind;
    m['deadline'] = deadline ?? DateTime.now().add(const Duration(minutes: 4)).toUtc().toIso8601String();
    if (plan != null) m['plan'] = plan;
  }));
}

SessionDto session(void Function(Map<String, dynamic>) patch) => SessionDto.fromJson(sessionJson(patch));

void main() {
  askQuestionTests();
  group('Ruxsat qoidalari', () {
    test('pending + approve scope: Ruxsat va Rad mumkin', () {
      final a = approval();
      expect(approvalUiState(a), ApprovalUiState.pending);
      expect(canAllow(a, hasApproveScope: true, lockdown: false), isTrue);
      expect(canDeny(a, hasApproveScope: true), isTrue);
    });

    test('lockdown: Ruxsat yopiq, Rad ochiq', () {
      final a = approval();
      expect(canAllow(a, hasApproveScope: true, lockdown: true), isFalse);
      expect(canDeny(a, hasApproveScope: true), isTrue);
    });

    test("approve scope yo'q: ikkalasi ham yopiq", () {
      final a = approval();
      expect(canAllow(a, hasApproveScope: false, lockdown: false), isFalse);
      expect(canDeny(a, hasApproveScope: false), isFalse);
    });

    test('muddati o\'tgan pending: expired, tugmalar yopiq', () {
      final a = approval(deadline: DateTime.now().subtract(const Duration(seconds: 5)).toUtc().toIso8601String());
      expect(approvalUiState(a), ApprovalUiState.expired);
      expect(canAllow(a, hasApproveScope: true, lockdown: false), isFalse);
      expect(approvalRemaining(a), Duration.zero);
    });

    test('hal qilingan holatlar', () {
      expect(approvalUiState(approval(status: 'approved')), ApprovalUiState.approved);
      expect(approvalUiState(approval(status: 'denied')), ApprovalUiState.denied);
      expect(approvalUiState(approval(status: 'cancelled')), ApprovalUiState.cancelled);
    });

    test('reja: matn plan maydonidan, oddiy tool: redakt kiritma', () {
      expect(approvalBody(approval(kind: 'plan', plan: '# Reja\n1. Qadam')), '# Reja\n1. Qadam');
      expect(approvalBody(approval()), approval().toolInputRedacted);
    });
  });

  group('Prompt maydoni holatlari', () {
    test('boshqariladigan, bo\'sh sessiya: faol', () {
      final s = session((m) => m['status'] = 'idle');
      final b = promptBoxFor(s, canControl: true, lockdown: false);
      expect(b.kind, PromptBoxKind.enabled);
      expect(b.canSend, isTrue);
    });

    test("ishlayotgan sessiya: band (yuborish yopiq), sabab bor", () {
      final s = session((m) => m['status'] = 'working');
      final b = promptBoxFor(s, canControl: true, lockdown: false);
      expect(b.kind, PromptBoxKind.busy);
      expect(b.canSend, isFalse);
      expect(b.reason, isNotNull);
    });

    test('controls.prompt=false + controlReason: sabab matni', () {
      final s = session((m) {
        m['status'] = 'idle';
        m['controllable'] = false;
        m['controlReason'] = 'interactive';
        (m['controls'] as Map)['prompt'] = false;
      });
      final b = promptBoxFor(s, canControl: true, lockdown: false);
      expect(b.kind, PromptBoxKind.blocked);
      expect(b.reason, contains('tmux'));
    });

    test('mashina oflayn sababi', () {
      final s = session((m) {
        m['controlReason'] = 'machine_offline';
        (m['controls'] as Map)['prompt'] = false;
      });
      expect(promptBoxFor(s, canControl: true, lockdown: false).reason, 'Mashina oflayn');
    });

    test("control scope yo'q yoki lockdown: yopiq", () {
      final s = session((m) => m['status'] = 'idle');
      expect(promptBoxFor(s, canControl: false, lockdown: false).kind, PromptBoxKind.blocked);
      expect(promptBoxFor(s, canControl: true, lockdown: true).kind, PromptBoxKind.blocked);
    });

    test('yopilgan sessiya', () {
      final s = session((m) => m['status'] = 'ended');
      expect(promptBoxFor(s, canControl: true, lockdown: false).reason, 'Sessiya yopilgan');
    });

    test('stop va remote control faqat controls bo\'yicha', () {
      final s = session((m) {
        m['status'] = 'working';
        (m['controls'] as Map)['remoteControl'] = true;
      });
      expect(canStopSession(s, canControl: true, lockdown: false), isTrue);
      expect(canStopSession(s, canControl: true, lockdown: true), isFalse);
      expect(canToggleRemoteControl(s, canControl: true, lockdown: false), isTrue);
      final s2 = session((m) => m['status'] = 'working');
      expect(canToggleRemoteControl(s2, canControl: true, lockdown: false), isFalse);
    });
  });

  group('Buyruq holati (step-up)', () {
    test("awaiting_confirmation = Telegram'da tasdiqlang", () {
      final p = commandProgress(CommandDto.fromJson(commandJson()));
      expect(p.phase, CommandPhase.awaitingTelegram);
      expect(p.text, "Telegram'da tasdiqlang");
      expect(p.terminal, isFalse);
    });

    test('running/done/failed', () {
      expect(commandProgress(CommandDto.fromJson(commandJson(status: 'running', stepUp: false))).phase, CommandPhase.inProgress);
      expect(commandProgress(CommandDto.fromJson(commandJson(status: 'done'))).phase, CommandPhase.done);
      final f = commandProgress(CommandDto.fromJson(commandJson(status: 'failed', errorCode: 'step_up_unavailable')));
      expect(f.phase, CommandPhase.failed);
      expect(f.text, contains('Telegram'));
      expect(commandProgress(CommandDto.fromJson(commandJson(status: 'expired'))).text, contains("o'tdi"));
    });
  });

  test('Diqqat: pending ruxsatlar (muddat bo\'yicha) + javob kutayotgan sessiyalar', () {
    final a1 = approval(deadline: DateTime.now().add(const Duration(minutes: 1)).toUtc().toIso8601String());
    final a2 = approval(deadline: DateTime.now().add(const Duration(minutes: 3)).toUtc().toIso8601String());
    final waiting = session((m) => m['status'] = 'waiting');
    final working = session((m) => m['status'] = 'working');
    final att = buildAttention([a2, a1], [waiting, working]);
    expect(att.approvals.first.deadline, a1.deadline);
    expect(att.waitingSessions, hasLength(1));
    expect(att.badgeCount, 3);
  });
}

ApprovalDto questionApproval({List<Map<String, dynamic>>? questions, String status = 'pending'}) {
  final base = ((fixtureMap('approvals')['recent'] as List).first as Map).cast<String, dynamic>();
  return ApprovalDto.fromJson(patched(base, (m) {
    m['status'] = status;
    m['kind'] = 'question';
    m['deadline'] = DateTime.now().add(const Duration(minutes: 4)).toUtc().toIso8601String();
    m['questions'] = questions ??
        [
          {
            'question': 'Qaysi kutubxonani tanlaymiz?',
            'header': 'Kutubxona',
            'multiSelect': false,
            'options': [
              {'label': 'Dio (Recommended)', 'description': 'Yengil'},
              {'label': 'http', 'description': 'Standart'},
            ],
          }
        ];
  }));
}

void askQuestionTests() {
  group('AskUserQuestion qoidalari', () {
    test('(Recommended) -> (tavsiya), faqat ko\'rinish', () {
      expect(isRecommendedLabel('Dio (Recommended)'), isTrue);
      expect(isRecommendedLabel('http'), isFalse);
      expect(displayOptionLabel('Dio (Recommended)'), 'Dio (tavsiya)');
      expect(displayOptionLabel('(Recommended) Dio'), '(tavsiya) Dio');
      expect(displayOptionLabel('http'), 'http');
    });

    test('bitta savol, bitta tanlov: javob indeks bo\'yicha, Ruxsat yo\'q', () {
      final a = questionApproval();
      expect(isAnswerableQuestion(a), isTrue);
      expect(canAllow(a, hasApproveScope: true, lockdown: false), isFalse);
      expect(canAnswer(a, hasApproveScope: true, lockdown: false), isTrue);
      expect(canDeny(a, hasApproveScope: true), isTrue);
      final ans = buildSingleAnswer(a, 1)!;
      expect(ans.single.toJson(), {'q': 0, 'picks': [1]});
      expect(buildSingleAnswer(a, 2), isNull);
      expect(buildSingleAnswer(a, -1), isNull);
    });

    test('lockdown / scope yo\'q / muddati o\'tgan: javob yopiq, Rad lockdown\'da ochiq', () {
      final a = questionApproval();
      expect(canAnswer(a, hasApproveScope: true, lockdown: true), isFalse);
      expect(canDeny(a, hasApproveScope: true), isTrue);
      expect(canAnswer(a, hasApproveScope: false, lockdown: false), isFalse);
      expect(canAnswer(questionApproval(status: 'approved'), hasApproveScope: true, lockdown: false), isFalse);
    });

    test('multiSelect yoki bir nechta savol: faqat ko\'rish', () {
      final multi = questionApproval(questions: [
        {'question': 'Q', 'header': 'H', 'multiSelect': true, 'options': [{'label': 'a', 'description': ''}]},
      ]);
      expect(isAnswerableQuestion(multi), isFalse);
      expect(buildSingleAnswer(multi, 0), isNull);
      expect(canAnswer(multi, hasApproveScope: true, lockdown: false), isFalse);
      final two = questionApproval(questions: [
        {'question': 'Q1', 'header': 'H1', 'multiSelect': false, 'options': [{'label': 'a', 'description': ''}]},
        {'question': 'Q2', 'header': 'H2', 'multiSelect': false, 'options': [{'label': 'b', 'description': ''}]},
      ]);
      expect(isAnswerableQuestion(two), isFalse);
      expect(questionSummary(two), 'H1: Q1 (+1 ta savol)');
    });

    test('xulosa: sarlavha va savol; approvalBody savol matni', () {
      final a = questionApproval();
      expect(questionSummary(a), 'Kutubxona: Qaysi kutubxonani tanlaymiz?');
      expect(approvalBody(a), questionSummary(a));
    });

    test('oddiy tool uchun isQuestion false', () {
      expect(isQuestion(approval()), isFalse);
      expect(isAnswerableQuestion(approval()), isFalse);
    });
  });
}
