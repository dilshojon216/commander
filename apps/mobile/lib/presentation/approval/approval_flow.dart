import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_spacing.dart';
import '../../data/biometric_gate.dart';
import '../../domain/approval_rules.dart';
import '../../domain/ask_question.dart';
import '../dashboard/approval_actions_cubit.dart';
import '../widgets/common.dart';

/// Ruxsat/Rad oqimlari: "Ruxsat" qurilma tasdig'i (biometrik/PIN) bilan; Rad xavfsiz tomon (tasdiqsiz).
abstract final class ApprovalFlow {
  static Future<void> allow(BuildContext context, ApprovalDto a) async {
    final reason = isPlan(a)
        ? 'Rejani tasdiqlang'
        : 'Ruxsatni tasdiqlang: ${a.toolName}';
    final cubit = context.read<ApprovalActionsCubit>();
    if (!await _confirm(
      context,
      reason,
      'Ruxsat berilsinmi?',
      '${a.projectName ?? a.cwd} · ${a.toolName}',
      'Ruxsat',
    ))
      return;
    await cubit.decide(a, ApprovalBehavior.allow);
  }

  /// Savolga variant tanlab javob: allow bilan bir xil qurilma tasdig'i. Tanlov indeks bo'yicha yuboriladi.
  static Future<void> answer(
    BuildContext context,
    ApprovalDto a,
    int optionIndex,
  ) async {
    final answers = buildSingleAnswer(a, optionIndex);
    if (answers == null) return;
    final cubit = context.read<ApprovalActionsCubit>();
    final label = displayOptionLabel(
      a.questions!.first.options[optionIndex].label,
    );
    if (!await _confirm(
      context,
      'Javobni tasdiqlang: $label',
      'Javob yuborilsinmi?',
      '${a.projectName ?? a.cwd} · $label',
      'Yuborish',
    ))
      return;
    await cubit.decide(a, ApprovalBehavior.allow, answers: answers);
  }

  static Future<bool> _confirm(
    BuildContext context,
    String reason,
    String title,
    String body,
    String confirmLabel,
  ) async {
    final gate = context.read<ConfirmGate>();
    final r = await gate.confirm(reason);
    if (!context.mounted) return false;
    switch (r) {
      case GateResult.confirmed:
        return true;
      case GateResult.denied:
        showSnack(context, 'Tasdiqlanmadi: ruxsat berilmadi');
        return false;
      case GateResult.unsupported:
        // Qurilmada ekran qulfi yo'q: oddiy tasdiq dialogi.
        final ok = await confirmDialog(
          context,
          title: title,
          body: body,
          confirmLabel: confirmLabel,
        );
        return ok && context.mounted;
    }
  }

  /// Reja: "Rad" yoki "Fikr bilan rad" (matn Claude'ga qaytadi). Oddiy tool: darhol rad.
  static Future<void> deny(BuildContext context, ApprovalDto a) async {
    final cubit = context.read<ApprovalActionsCubit>();
    if (!isPlan(a)) {
      await cubit.decide(a, ApprovalBehavior.deny);
      return;
    }
    final feedback = await showModalBottomSheet<_DenyResult>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _DenySheet(),
    );
    if (feedback == null) return;
    await cubit.decide(a, ApprovalBehavior.deny, message: feedback.message);
  }
}

class _DenyResult {
  const _DenyResult(this.message);
  final String? message;
}

class _DenySheet extends StatefulWidget {
  const _DenySheet();
  @override
  State<_DenySheet> createState() => _DenySheetState();
}

class _DenySheetState extends State<_DenySheet> {
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      AppSpacing.lg,
      AppSpacing.lg,
      AppSpacing.lg,
      MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg,
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Rejani rad etish',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          controller: _ctrl,
          maxLines: 4,
          maxLength: 1000,
          decoration: const InputDecoration(
            hintText: 'Fikringiz (ixtiyoriy): Claude rejani shunga qarab o\'zgartiradi',
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () =>
                    Navigator.pop(context, const _DenyResult(null)),
                child: const Text('Rad'),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: FilledButton(
                onPressed: () {
                  final t = _ctrl.text.trim();
                  Navigator.pop(context, _DenyResult(t.isEmpty ? null : t));
                },
                child: const Text('Fikr bilan rad'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}
