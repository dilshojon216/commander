import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../domain/approval_rules.dart';
import '../../domain/ask_question.dart';
import '../widgets/ask_options.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/approval_actions_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../navigation.dart';
import '../../domain/session_labels.dart';
import '../widgets/common.dart';
import '../widgets/safe_markdown.dart';
import 'approval_flow.dart';

/// Ruxsat so'rovi tafsiloti: tool + redakt qilingan kiritma yoki reja matni; Ruxsat / Rad / Fikr bilan rad.
class ApprovalPage extends StatelessWidget {
  const ApprovalPage({super.key, required this.approvalId});
  final String approvalId;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      appBar: AppBar(title: const Text('Ruxsat so\'rovi')),
      body: BlocBuilder<DashboardCubit, DashboardState>(
        builder: (context, d) {
          final a = [
            ...d.pending,
            ...d.recent,
          ].where((x) => x.id == approvalId).firstOrNull;
          if (a == null)
            return const EmptyState(
              icon: Icons.search_off,
              text: "So'rov topilmadi (eski bo'lishi mumkin)",
            );
          final hasScope =
              context.read<AuthCubit>().state.credentials?.canApprove ?? false;
          final ui = approvalUiState(a);
          final plan = isPlan(a);
          final question = isQuestion(a);
          return BlocBuilder<ApprovalActionsCubit, ApprovalActionsState>(
            builder: (context, as) {
              final act = as.of(a.id);
              final busy = act?.status == ApprovalActionStatus.submitting;
              return Column(
                children: [
                  if (d.lockdown) const LockdownBanner(),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.all(AppSpacing.lg),
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                a.projectName ?? shortPath(a.cwd),
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            if (ui == ApprovalUiState.pending)
                              CountdownText(
                                remaining: () => approvalRemaining(a),
                              )
                            else
                              StatusPill(
                                label: approvalStateLabel(ui),
                                tone: ui == ApprovalUiState.approved
                                    ? StatusTone.green
                                    : (ui == ApprovalUiState.denied
                                          ? StatusTone.red
                                          : StatusTone.faint),
                                dot: false,
                              ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${a.machineSlug} · ${a.cwd}',
                          style: monoStyle(context, color: c.mu),
                        ),
                        const SizedBox(height: AppSpacing.lg),
                        SectionLabel(
                          plan
                              ? 'Reja'
                              : (question ? 'Savol' : 'Tool: ${a.toolName}'),
                        ),
                        const SizedBox(height: AppSpacing.sm),
                        AppCard(
                          child: question
                              ? AskOptionsView(
                                  approval: a,
                                  onPick:
                                      ui == ApprovalUiState.pending &&
                                          canAnswer(
                                            a,
                                            hasApproveScope: hasScope,
                                            lockdown: d.lockdown,
                                          ) &&
                                          !busy
                                      ? (i) =>
                                            ApprovalFlow.answer(context, a, i)
                                      : null,
                                )
                              : plan
                              ? SafeMarkdown(approvalBody(a))
                              : SelectableText(
                                  approvalBody(a),
                                  style: monoStyle(context, size: 12.5),
                                ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          "Maxfiy qiymatlar [REDACTED] bilan yashirilgan; ularni ko'rsatib bo'lmaydi.",
                          style: TextStyle(fontSize: 11, color: c.fa),
                        ),
                        const SizedBox(height: AppSpacing.lg),
                        if (a.sessionId != null)
                          OutlinedButton.icon(
                            onPressed: () => Nav.session(context, a.sessionId!),
                            icon: const Icon(Icons.chat_bubble_outline),
                            label: const Text('Sessiyani ochish'),
                          ),
                        if (a.decisionMessage != null &&
                            a.decisionMessage!.isNotEmpty) ...[
                          const SizedBox(height: AppSpacing.md),
                          Text(
                            'Fikr: ${a.decisionMessage}',
                            style: TextStyle(color: c.mu),
                          ),
                        ],
                        if (act?.status == ApprovalActionStatus.failed) ...[
                          const SizedBox(height: AppSpacing.md),
                          ErrorBanner(message: act!.message ?? 'Xato'),
                        ],
                        if (act?.status == ApprovalActionStatus.done &&
                            !act!.delivered)
                          Padding(
                            padding: const EdgeInsets.only(top: AppSpacing.md),
                            child: Text(
                              "Qaror qabul qilindi, lekin mashina oflayn: u qayta ulanganda yetkaziladi.",
                              style: TextStyle(color: c.yel),
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (ui == ApprovalUiState.pending)
                    SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        child: Row(
                          children: [
                            Expanded(
                              child: SizedBox(
                                height: AppSizes.tap,
                                child: OutlinedButton(
                                  style: OutlinedButton.styleFrom(
                                    foregroundColor: c.red,
                                    side: BorderSide(color: c.red),
                                  ),
                                  onPressed:
                                      canDeny(a, hasApproveScope: hasScope) &&
                                          !busy
                                      ? () => ApprovalFlow.deny(context, a)
                                      : null,
                                  child: Text(
                                    plan
                                        ? 'Rad / Fikr bilan'
                                        : (question ? 'Rad etish' : 'Rad'),
                                  ),
                                ),
                              ),
                            ),
                            if (!question) ...[
                              const SizedBox(width: AppSpacing.md),
                              Expanded(
                                child: SizedBox(
                                  height: AppSizes.tap,
                                  child: FilledButton(
                                    style: FilledButton.styleFrom(
                                      backgroundColor: c.grn,
                                      foregroundColor: c.onOk,
                                    ),
                                    onPressed:
                                        canAllow(
                                              a,
                                              hasApproveScope: hasScope,
                                              lockdown: d.lockdown,
                                            ) &&
                                            !busy
                                        ? () => ApprovalFlow.allow(context, a)
                                        : null,
                                    child: busy
                                        ? const SizedBox(
                                            width: 18,
                                            height: 18,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                            ),
                                          )
                                        : Text(
                                            d.lockdown
                                                ? 'Lockdown'
                                                : (hasScope
                                                      ? 'Ruxsat'
                                                      : 'Scope yo\'q'),
                                          ),
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                ],
              );
            },
          );
        },
      ),
    );
  }
}
