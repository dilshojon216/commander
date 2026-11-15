import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../domain/approval_rules.dart';
import '../../domain/limit_card.dart';
import '../../domain/pace_card.dart';
import '../../domain/session_labels.dart';
import '../../domain/ask_question.dart';
import 'ask_options.dart';
import 'common.dart';

/// Limit kartasi: 4 holat (rasmiy / taxmin / eskirgan / yangilangan) + bashorat.
class LimitCard extends StatelessWidget {
  const LimitCard({super.key, required this.model});
  final LimitCardModel model;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final m = model;
    final dim =
        m.kind == LimitKind.estimate ||
        m.kind == LimitKind.stale ||
        m.kind == LimitKind.reset;
    final fill = switch (m.level) {
      LimitLevel.critical => c.red,
      LimitLevel.warn => c.yel,
      LimitLevel.normal => dim ? c.mu : c.blue,
    };
    final badgeTone = switch (m.kind) {
      LimitKind.official => StatusTone.blue,
      LimitKind.estimate => StatusTone.gray,
      LimitKind.stale => StatusTone.faint,
      LimitKind.reset => StatusTone.green,
    };
    return AppCard(
      semanticLabel:
          '${m.title}: ${m.valueText}, ${m.badge}. ${m.footer}${m.forecastText != null ? '. ${m.forecastText}' : ''}',
      child: Opacity(
        opacity: m.kind == LimitKind.stale ? 0.7 : 1,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(child: SectionLabel(m.title)),
                const SizedBox(width: 6),
                StatusPill(
                  label: m.badge,
                  tone: badgeTone,
                  dot: false,
                  dashed: m.kind == LimitKind.estimate,
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              m.valueText,
              style: monoStyle(
                context,
                size: 24,
                weight: FontWeight.w600,
                color: dim && m.level == LimitLevel.normal ? c.mu : c.tx,
              ),
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(5),
              child: Stack(
                children: [
                  Container(height: 5, color: c.s3),
                  FractionallySizedBox(
                    widthFactor: m.fraction,
                    child: Container(height: 5, color: fill),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Text(m.footer, style: TextStyle(fontSize: 11, color: c.mu)),
            if (m.forecastText != null) ...[
              const SizedBox(height: 4),
              Text(
                m.forecastText!,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: m.forecastBeforeReset ? c.org : c.mu,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// "Bugungi ulush" kartasi (6.12): bar + holat; taxmin: "≈", "taxmin" yorlig'i va xira (CLAUDE.md #6).
class PaceCard extends StatelessWidget {
  const PaceCard({super.key, required this.model});
  final PaceCardModel model;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final m = model;
    final fill = switch (m.level) {
      PaceLevel.critical => c.red,
      PaceLevel.warn => c.yel,
      PaceLevel.normal => m.estimate ? c.mu : c.grn,
    };
    return AppCard(
      semanticLabel:
          '${m.shareText}, ${m.statusText}${m.note != null ? ', ${m.note}' : ''}${m.forecastText != null ? '. ${m.forecastText}' : ''}',
      child: Opacity(
        opacity: m.estimate ? 0.8 : 1,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(
                    m.shareText,
                    style: monoStyle(
                      context,
                      size: 13,
                      weight: FontWeight.w600,
                      color: m.estimate ? c.mu : c.tx,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                StatusPill(
                  label: m.statusText,
                  tone: switch (m.level) {
                    PaceLevel.critical => StatusTone.red,
                    PaceLevel.warn => StatusTone.yellow,
                    PaceLevel.normal =>
                      m.estimate ? StatusTone.gray : StatusTone.green,
                  },
                  dot: false,
                  dashed: m.estimate,
                ),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(5),
              child: Stack(
                children: [
                  Container(height: 5, color: c.s3),
                  FractionallySizedBox(
                    widthFactor: m.fraction,
                    child: Container(height: 5, color: fill),
                  ),
                ],
              ),
            ),
            if (m.forecastText != null) ...[
              const SizedBox(height: 4),
              Text(
                m.forecastText!,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: m.forecastWarn ? c.org : c.mu,
                ),
              ),
            ],
            if (m.note != null) ...[
              const SizedBox(height: 2),
              Text(m.note!, style: TextStyle(fontSize: 11, color: c.mu)),
            ],
            if (m.gateNote != null) ...[
              const SizedBox(height: 2),
              Text(m.gateNote!, style: TextStyle(fontSize: 11, color: c.yel)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Ruxsat kartasi: tool + redakt qilingan kiritma (yoki reja), taymer, Ruxsat/Rad. Holatlar: pending/approved/denied/expired/cancelled.
class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.approval,
    required this.canApproveScope,
    required this.lockdown,
    required this.busy,
    required this.onAllow,
    required this.onDeny,
    required this.onOpen,
    this.errorText,
    this.now,
    this.onAnswer,
  });

  final ApprovalDto approval;
  final void Function(int optionIndex)? onAnswer;
  final bool canApproveScope;
  final bool lockdown;
  final bool busy;
  final VoidCallback onAllow;
  final VoidCallback onDeny;
  final VoidCallback onOpen;
  final String? errorText;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final state = approvalUiState(approval, now: now);
    final pending = state == ApprovalUiState.pending;
    final plan = isPlan(approval);
    final question = isQuestion(approval);
    final answer = canAnswer(
      approval,
      hasApproveScope: canApproveScope,
      lockdown: lockdown,
      now: now,
    );
    final allow = canAllow(
      approval,
      hasApproveScope: canApproveScope,
      lockdown: lockdown,
      now: now,
    );
    final deny = canDeny(approval, hasApproveScope: canApproveScope, now: now);
    final resolvedTone = switch (state) {
      ApprovalUiState.approved => StatusTone.green,
      ApprovalUiState.denied => StatusTone.red,
      _ => StatusTone.faint,
    };
    final body = approvalBody(approval);
    return Opacity(
      opacity: pending ? 1 : 0.7,
      child: AppCard(
        padding: EdgeInsets.zero,
        borderColor: pending ? c.org : c.bd,
        semanticLabel:
            '${approvalStateLabel(state)}: ${approval.projectName ?? shortPath(approval.cwd)}, ${plan ? 'reja' : approval.toolName}',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: pending ? c.orgBg : c.grayBg,
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(AppRadius.card),
                ),
              ),
              child: Row(
                children: [
                  PulseDot(
                    color: pending ? c.org : toneFg(c, resolvedTone),
                    pulsing: pending,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      plan
                          ? 'Reja tasdig\'i'
                          : (question && pending
                                ? 'Savol'
                                : approvalStateLabel(state)),
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  if (pending)
                    CountdownText(
                      remaining: () => approvalRemaining(approval, now: now),
                    )
                  else
                    StatusPill(
                      label: approvalStateLabel(state),
                      tone: resolvedTone,
                      dot: false,
                    ),
                ],
              ),
            ),
            InkWell(
              onTap: onOpen,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          approval.projectName ?? shortPath(approval.cwd),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        Text(
                          approval.machineSlug,
                          style: monoStyle(context, color: c.mu),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: c.s3,
                            borderRadius: BorderRadius.circular(AppRadius.pill),
                          ),
                          child: Text(
                            plan
                                ? 'Reja'
                                : (question ? 'Savol' : approval.toolName),
                            style: monoStyle(context, size: 12),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    if (question)
                      AskOptionsView(
                        approval: approval,
                        compact: true,
                        onPick: pending && answer && !busy ? onAnswer : null,
                      )
                    else
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: c.s2,
                          border: Border.all(color: c.bd),
                          borderRadius: BorderRadius.circular(AppRadius.sm),
                        ),
                        child: Text(
                          body.length > 240
                              ? '${body.substring(0, 240)}…'
                              : body,
                          maxLines: 6,
                          overflow: TextOverflow.ellipsis,
                          style: monoStyle(context),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            if (errorText != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: Text(
                  errorText!,
                  style: TextStyle(color: c.red, fontSize: 13),
                ),
              ),
            if (pending && question)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Row(
                  children: [
                    Expanded(
                      child: _ActionButton(
                        label: 'Rad etish',
                        onPressed: deny && !busy ? onDeny : null,
                        outlineColor: c.red,
                        textColor: c.red,
                        semantic: 'Rad etish',
                      ),
                    ),
                    if (lockdown) ...[
                      const SizedBox(width: 10),
                      Text(
                        'Lockdown',
                        style: TextStyle(color: c.yel, fontSize: 12),
                      ),
                    ],
                  ],
                ),
              )
            else if (pending)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Row(
                  children: [
                    Expanded(
                      child: _ActionButton(
                        label: 'Rad',
                        onPressed: deny && !busy ? onDeny : null,
                        outlineColor: c.red,
                        textColor: c.red,
                        semantic: 'Rad etish',
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _ActionButton(
                        label: lockdown ? 'Lockdown' : 'Ruxsat',
                        onPressed: allow && !busy ? onAllow : null,
                        fill: c.grn,
                        textColor: c.onOk,
                        busy: busy,
                        semantic: lockdown
                            ? 'Lockdown yoqiq: ruxsat berib bo\'lmaydi'
                            : 'Ruxsat berish',
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.label,
    required this.onPressed,
    this.fill,
    this.outlineColor,
    required this.textColor,
    this.busy = false,
    required this.semantic,
  });
  final String label;
  final VoidCallback? onPressed;
  final Color? fill;
  final Color? outlineColor;
  final Color textColor;
  final bool busy;
  final String semantic;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null;
    return Semantics(
      button: true,
      enabled: !disabled,
      label: semantic,
      child: SizedBox(
        height: AppSizes.tap,
        child: Material(
          color:
              fill?.withValues(alpha: disabled ? 0.4 : 1) ?? Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
            side: outlineColor != null
                ? BorderSide(
                    color: outlineColor!.withValues(alpha: disabled ? 0.4 : 1),
                  )
                : BorderSide.none,
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppRadius.md),
            onTap: onPressed,
            child: Center(
              child: busy
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: textColor,
                      ),
                    )
                  : Text(
                      label,
                      style: TextStyle(
                        color: textColor.withValues(alpha: disabled ? 0.5 : 1),
                        fontWeight: FontWeight.w600,
                        fontSize: 14,
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Sessiya qatori.
class SessionTile extends StatelessWidget {
  const SessionTile({
    super.key,
    required this.session,
    required this.onTap,
    this.showProject = true,
  });
  final SessionDto session;
  final VoidCallback onTap;
  final bool showProject;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final s = session;
    final stale = isStale(s);
    final label = stale ? "Aloqa yo'q" : sessionStatusLabel(s.status);
    final tone = stale ? StatusTone.faint : sessionStatusTone(s.status);
    final since = formatAgo(parseIso(s.statusSince));
    return Opacity(
      opacity: stale ? 0.6 : 1,
      child: AppCard(
        onTap: onTap,
        semanticLabel: '${s.projectName}, ${s.machineName}: $label, $since',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                StatusPill(
                  label: label,
                  tone: tone,
                  live: !stale && isLive(s.status),
                ),
                if (stale) ...[
                  const SizedBox(width: 6),
                  Icon(Icons.warning_amber_rounded, size: 16, color: c.fa),
                ],
                if (s.pendingApprovals > 0) ...[
                  const SizedBox(width: 6),
                  StatusPill(
                    label: '${s.pendingApprovals} ruxsat',
                    tone: StatusTone.orange,
                    dot: false,
                  ),
                ],
                const Spacer(),
                Text(since, style: monoStyle(context, color: c.mu)),
              ],
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (showProject)
                  Text(
                    s.projectName,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                Text(s.machineName, style: monoStyle(context, color: c.mu)),
                if (s.model != null)
                  Text(
                    s.model!,
                    style: monoStyle(context, size: 11, color: c.fa),
                  ),
              ],
            ),
            if ((s.message ?? '').isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                s.message!,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: c.mu),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
