import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../domain/limit_card.dart';
import '../../domain/pace_card.dart';
import '../../domain/session_labels.dart';
import '../approval/approval_flow.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/approval_actions_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../navigation.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';

/// Umumiy: diqqat (ruxsat + javob kutayotganlar), limitlar, tokenlar, mashinalar, salomatlik, ogohlantirishlar.
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return BlocBuilder<DashboardCubit, DashboardState>(
      builder: (context, d) => Scaffold(
        appBar: AppBar(
          titleSpacing: AppSpacing.lg,
          title: const Text('Commander'),
          actions: [
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Center(child: ConnectionChip(d.connection)),
            ),
            IconButton(
              tooltip: 'Navbat',
              icon: const Icon(Icons.schedule),
              onPressed: () => Nav.queue(context),
            ),
            IconButton(
              tooltip: 'Sozlamalar',
              icon: const Icon(Icons.settings_outlined),
              onPressed: () => Nav.settings(context),
            ),
          ],
        ),
        body: Column(
          children: [
            if (d.lockdown) const LockdownBanner(),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => context.read<DashboardCubit>().refresh(),
                child: _body(context, d, c),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, DashboardState d, AppColors c) {
    if (d.phase == LoadPhase.loading || d.phase == LoadPhase.initial) {
      return ListView(children: const [SizedBox(height: 120), Loading()]);
    }
    if (d.phase == LoadPhase.error) {
      return ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          ErrorBanner(
            message: d.error ?? 'Xato',
            onRetry: () => context.read<DashboardCubit>().refresh(),
          ),
          const SizedBox(height: AppSpacing.lg),
          _TailscaleHint(failure: d.failure),
        ],
      );
    }
    final attention = d.attention;
    final hasScope =
        context.read<AuthCubit>().state.credentials?.canApprove ?? false;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.xs,
        AppSpacing.lg,
        AppSpacing.xl,
      ),
      children: [
        if (d.error != null) ...[
          ErrorBanner(
            message: d.error!,
            onRetry: () => context.read<DashboardCubit>().refresh(),
          ),
          const SizedBox(height: 14),
        ],
        if (attention.isEmpty)
          AppCard(
            child: Row(
              children: [
                Icon(Icons.check_circle_outline, color: c.grn),
                const SizedBox(width: AppSpacing.sm),
                const Expanded(
                  child: Text('Diqqat talab qiladigan narsa yo\'q'),
                ),
              ],
            ),
          ),
        for (final a in attention.approvals) ...[
          BlocBuilder<ApprovalActionsCubit, ApprovalActionsState>(
            builder: (context, as) => ApprovalCard(
              approval: a,
              canApproveScope: hasScope,
              lockdown: d.lockdown,
              busy: as.of(a.id)?.status == ApprovalActionStatus.submitting,
              errorText: as.of(a.id)?.status == ApprovalActionStatus.failed
                  ? as.of(a.id)!.message
                  : null,
              onAllow: () => ApprovalFlow.allow(context, a),
              onAnswer: (i) => ApprovalFlow.answer(context, a, i),
              onDeny: () => ApprovalFlow.deny(context, a),
              onOpen: () => Nav.approval(context, a.id),
            ),
          ),
          const SizedBox(height: 14),
        ],
        for (final s in attention.waitingSessions) ...[
          SessionTile(session: s, onTap: () => Nav.session(context, s.id)),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 4),
        _LimitsRow(limits: d.limits),
        const SizedBox(height: 14),
        _TokensCard(usage: d.usage),
        const SizedBox(height: 14),
        _MachinesCard(machines: d.machines, health: d.health),
        if (d.alerts.isNotEmpty) ...[
          const SizedBox(height: 14),
          _AlertsCard(alerts: d.alerts),
        ],
      ],
    );
  }
}

class _TailscaleHint extends StatelessWidget {
  const _TailscaleHint({this.failure});
  final dynamic failure;
  @override
  Widget build(BuildContext context) => AppCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Tekshiring', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text(
          "1. Telefonda Tailscale yoqilgan.\n2. Markaz Mac ishlayapti va Tailscale'da onlayn.\n3. Sozlamalarda markaz manzili to'g'ri.",
          style: TextStyle(color: context.c.mu),
        ),
      ],
    ),
  );
}

class _LimitsRow extends StatelessWidget {
  const _LimitsRow({required this.limits});
  final LimitsResponse? limits;

  @override
  Widget build(BuildContext context) {
    final l = limits;
    if (l == null || (l.fiveHour == null && l.sevenDay == null)) {
      return const AppCard(child: Text('Limit ma\'lumoti hali yo\'q'));
    }
    final pace = l.pace;
    final row = IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: l.fiveHour == null
                ? const SizedBox()
                : LimitCard(model: buildLimitCard('5 soat', l.fiveHour!)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: l.sevenDay == null
                ? const SizedBox()
                : LimitCard(model: buildLimitCard('Haftalik', l.sevenDay!)),
          ),
        ],
      ),
    );
    if (pace == null) return row;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        row,
        const SizedBox(height: 10),
        PaceCard(model: buildPaceCard(pace)),
      ],
    );
  }
}

class _TokensCard extends StatelessWidget {
  const _TokensCard({required this.usage});
  final UsageSummaryResponse? usage;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final u = usage;
    if (u == null)
      return const AppCard(child: Text('Token ma\'lumoti hali yo\'q'));
    Widget cell(String label, TokenTotals t) => Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionLabel(label),
          const SizedBox(height: 2),
          Text(
            formatTokens(t.totalTokens),
            style: monoStyle(context, size: 18, weight: FontWeight.w600),
          ),
        ],
      ),
    );
    return AppCard(
      onTap: () => Nav.tokens(context),
      semanticLabel:
          'Tokenlar: bugun ${formatTokens(u.today.totals.totalTokens)}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              cell('Bugun', u.today.totals),
              cell('7 kun', u.last7d.totals),
              cell('30 kun', u.last30d.totals),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${u.today.totals.requests.round()} so\'rov${u.today.totals.costUsd != null ? ' · ≈ ${formatUsd(u.today.totals.costUsd)} API ekv.' : ''}',
            style: TextStyle(fontSize: 12, color: c.mu),
          ),
        ],
      ),
    );
  }
}

class _MachinesCard extends StatelessWidget {
  const _MachinesCard({required this.machines, required this.health});
  final List<MachineDto> machines;
  final HealthSummaryResponse? health;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final online = machines.where((m) => m.online).length;
    final healthBy = {
      for (final h in health?.items ?? <HealthSummaryItem>[]) h.machineId: h,
    };
    final worst = health?.worst;
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Mashinalar',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                ),
                if (worst != null &&
                    worst != HealthStatus.ok &&
                    worst != HealthStatus.unknown) ...[
                  StatusPill(
                    label: healthStatusLabel(worst),
                    tone: worst == HealthStatus.critical
                        ? StatusTone.red
                        : (worst == HealthStatus.warn
                              ? StatusTone.yellow
                              : StatusTone.gray),
                    dot: false,
                  ),
                  const SizedBox(width: 8),
                ],
                Text(
                  '$online/${machines.length} onlayn',
                  style: TextStyle(color: c.mu, fontSize: 13),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
            child: Row(
              children: [
                for (final m in machines)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: _MachineChip(machine: m, health: healthBy[m.id]),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MachineChip extends StatelessWidget {
  const _MachineChip({required this.machine, this.health});
  final MachineDto machine;
  final HealthSummaryItem? health;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final m = machine;
    final hs = health?.status;
    final dot = !m.online
        ? c.fa
        : (hs == HealthStatus.critical
              ? c.red
              : (hs == HealthStatus.warn ? c.yel : c.grn));
    return Semantics(
      label:
          '${machineName(m)}: ${m.online ? 'onlayn' : 'oflayn'}, ${machineSessionsSummary(m.sessions)}${hs != null ? ', salomatlik ${healthStatusLabel(hs)}' : ''}',
      child: Opacity(
        opacity: m.online ? 1 : 0.55,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: c.s2,
            borderRadius: BorderRadius.circular(AppRadius.md),
            border: Border.all(color: c.bd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  PulseDot(color: dot),
                  const SizedBox(width: 6),
                  Text(
                    machineName(m),
                    style: monoStyle(context, weight: FontWeight.w600),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                m.online ? machineSessionsSummary(m.sessions) : 'oflayn',
                style: TextStyle(fontSize: 11, color: c.mu),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AlertsCard extends StatelessWidget {
  const _AlertsCard({required this.alerts});
  final List<AlertDto> alerts;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return AppCard(
      borderColor: c.yel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.notifications_active_outlined, color: c.yel, size: 20),
              const SizedBox(width: 8),
              const Text(
                'Ogohlantirishlar',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
            ],
          ),
          for (final a in alerts.take(5))
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: InkWell(
                onTap: () => Nav.session(context, a.sessionId),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      a.title,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    Text(
                      a.detail,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.mu, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
