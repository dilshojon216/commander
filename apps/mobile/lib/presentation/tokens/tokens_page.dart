import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';
import '../widgets/common.dart';
import 'tokens_cubit.dart';

/// Tokenlar: bugun/7/30/jami + oddiy kunlik grafik.
class TokensView extends StatelessWidget {
  const TokensView({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final usage = context.select((DashboardCubit d) => d.state.usage);
    return BlocBuilder<TokensCubit, TokensState>(
      builder: (context, st) => RefreshIndicator(
        onRefresh: () async {
          await context.read<DashboardCubit>().refresh();
          if (context.mounted) await context.read<TokensCubit>().load();
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            0,
            AppSpacing.lg,
            AppSpacing.xl,
          ),
          children: [
            if (usage != null) ...[
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 10,
                crossAxisSpacing: 10,
                childAspectRatio: 2.1,
                children: [
                  _Total(label: 'Bugun', t: usage.today.totals),
                  _Total(label: '7 kun', t: usage.last7d.totals),
                  _Total(label: '30 kun', t: usage.last30d.totals),
                  _Total(label: 'Jami', t: usage.allTime.totals),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Narx — obunada haqiqiy to\'lov emas, "API ekvivalenti".',
                style: TextStyle(fontSize: 11, color: c.fa),
              ),
              const SizedBox(height: 14),
            ],
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const SectionLabel('Kunlik tokenlar'),
                      const Spacer(),
                      SegmentedButton<int>(
                        showSelectedIcon: false,
                        style: const ButtonStyle(
                          visualDensity: VisualDensity.compact,
                        ),
                        segments: const [
                          ButtonSegment(value: 7, label: Text('7')),
                          ButtonSegment(value: 14, label: Text('14')),
                          ButtonSegment(value: 30, label: Text('30')),
                        ],
                        selected: {st.days},
                        onSelectionChanged: (v) =>
                            context.read<TokensCubit>().load(days: v.first),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (st.phase == LoadPhase.loading && st.series == null)
                    const Loading()
                  else if (st.error != null && st.series == null)
                    ErrorBanner(
                      message: st.error!,
                      onRetry: () => context.read<TokensCubit>().load(),
                    )
                  else if (st.points.isEmpty)
                    Text(
                      "Bu davrda ma'lumot yo'q",
                      style: TextStyle(color: c.mu),
                    )
                  else ...[
                    MiniBars(
                      values: [for (final p in st.points) p.total],
                      height: 120,
                      barWidth: st.days > 14 ? 6 : 14,
                      semanticLabel:
                          'Kunlik token grafigi, ${st.points.length} kun',
                    ),
                    const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          '${st.points.first.day.day}.${st.points.first.day.month}',
                          style: monoStyle(context, size: 11, color: c.fa),
                        ),
                        Text(
                          'eng ko\'p: ${formatTokens(st.points.map((p) => p.total).reduce((a, b) => a > b ? a : b))}',
                          style: monoStyle(context, size: 11, color: c.mu),
                        ),
                        Text(
                          '${st.points.last.day.day}.${st.points.last.day.month}',
                          style: monoStyle(context, size: 11, color: c.fa),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Total extends StatelessWidget {
  const _Total({required this.label, required this.t});
  final String label;
  final TokenTotals t;
  @override
  Widget build(BuildContext context) => AppCard(
    semanticLabel: '$label: ${formatTokens(t.totalTokens)} token',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SectionLabel(label),
        Text(
          formatTokens(t.totalTokens),
          style: monoStyle(context, size: 20, weight: FontWeight.w600),
        ),
        Text(
          '${t.requests.round()} so\'rov${t.costUsd != null ? ' · ≈${formatUsd(t.costUsd)}' : ''}',
          style: TextStyle(fontSize: 11, color: context.c.mu),
        ),
      ],
    ),
  );
}

/// Alohida ekran sifatida (Umumiy -> Tokenlar).
class TokensPage extends StatelessWidget {
  const TokensPage({super.key});
  @override
  Widget build(BuildContext context) => BlocProvider(
    create: (ctx) => TokensCubit(ctx.read<UsageRepository>())..load(),
    child: Scaffold(
      appBar: AppBar(title: const Text('Tokenlar')),
      body: const TokensView(),
    ),
  );
}
