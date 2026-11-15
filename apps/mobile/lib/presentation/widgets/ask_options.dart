import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../domain/ask_question.dart';

/// Savol matni + variantlar. [onPick] null bo'lsa variantlar bosilmaydi (faqat ko'rish yoki lockdown/scope yo'q).
/// Bir nechta savol / multiSelect bo'lsa har doim faqat ko'rish + izoh.
class AskOptionsView extends StatelessWidget {
  const AskOptionsView({
    super.key,
    required this.approval,
    required this.onPick,
    this.compact = false,
  });
  final ApprovalDto approval;
  final void Function(int optionIndex)? onPick;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final qs = approval.questions ?? const <AskQuestion>[];
    final answerable = isAnswerableQuestion(approval);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var qi = 0; qi < qs.length; qi++) ...[
          if (qs[qi].header.trim().isNotEmpty)
            Text(
              qs[qi].header,
              style: TextStyle(
                fontSize: 11,
                color: c.mu,
                fontWeight: FontWeight.w600,
              ),
            ),
          Text(
            qs[qi].question,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: AppSpacing.sm),
          for (var oi = 0; oi < qs[qi].options.length; oi++) ...[
            _OptionTile(
              option: qs[qi].options[oi],
              compact: compact,
              onTap: answerable && onPick != null ? () => onPick!(oi) : null,
              showButton: answerable,
            ),
            const SizedBox(height: 6),
          ],
          if (qs[qi].multiSelect)
            Text(
              'Bir nechta tanlash mumkin',
              style: TextStyle(fontSize: 11, color: c.fa),
            ),
          const SizedBox(height: AppSpacing.sm),
        ],
        if (!answerable)
          Text(multiAnswerNote, style: TextStyle(fontSize: 12, color: c.yel)),
      ],
    );
  }
}

class _OptionTile extends StatelessWidget {
  const _OptionTile({
    required this.option,
    required this.compact,
    required this.onTap,
    required this.showButton,
  });
  final AskOption option;
  final bool compact;
  final VoidCallback? onTap;
  final bool showButton;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rec = isRecommendedLabel(option.label);
    final label = displayOptionLabel(option.label);
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: rec ? c.grn : null,
          ),
        ),
        if (option.description.isNotEmpty && !compact)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              option.description,
              style: TextStyle(fontSize: 12, color: c.mu),
            ),
          ),
      ],
    );
    if (!showButton) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: c.s2,
          border: Border.all(color: c.bd),
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        child: content,
      );
    }
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: 'Javob: $label',
      child: SizedBox(
        width: double.infinity,
        child: OutlinedButton(
          style: OutlinedButton.styleFrom(
            alignment: Alignment.centerLeft,
            minimumSize: const Size.fromHeight(AppSizes.tap),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          ),
          onPressed: onTap,
          child: content,
        ),
      ),
    );
  }
}
