import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/repositories.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../../domain/session_labels.dart';
import '../widgets/common.dart';
import 'queue_cubit.dart';

String queueTriggerLabel(QueueTrigger t) => switch (t) {
  QueueTriggerNowCase() => 'Hozir',
  QueueTriggerLimitResetCase() => 'Limit yangilanganda',
  QueueTriggerAtCase(:final value) => 'Vaqtda: ${formatTriggerAt(value.at)}',
  QueueTriggerCronCase(:final value) => 'Takroriy: ${value.cron}',
  QueueTriggerMachineIdleCase() => "Mashina bo'sh bo'lganda",
  QueueTriggerUnknown() => "Noma'lum",
};

String formatTriggerAt(String iso) {
  final d = parseIso(iso);
  return d == null ? iso : '${d.day}.${d.month} ${hhmm(d)}';
}

String queueStatusLabel(QueueStatus s) => switch (s) {
  QueueStatus.queued => 'Navbatda',
  QueueStatus.waitingTrigger => 'Trigger kutmoqda',
  QueueStatus.starting => 'Boshlanmoqda',
  QueueStatus.started => 'Boshlandi',
  QueueStatus.failed => 'Xato',
  QueueStatus.cancelled => 'Bekor qilindi',
  QueueStatus.unknown => "Noma'lum",
};

bool queueCancellable(QueueStatus s) =>
    s == QueueStatus.queued || s == QueueStatus.waitingTrigger;

/// Navbat: ro'yxat + bekor qilish.
class QueuePage extends StatelessWidget {
  const QueuePage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final canControl =
        context.read<AuthCubit>().state.credentials?.canControl ?? false;
    final lockdown = context.select((DashboardCubit d) => d.state.lockdown);
    return BlocProvider(
      create: (ctx) => QueueCubit(ctx.read<QueueRepository>())..load(),
      child: Scaffold(
        appBar: AppBar(title: const Text('Navbat')),
        body: BlocBuilder<QueueCubit, QueueState>(
          builder: (context, st) {
            if (st.phase == LoadPhase.loading || st.phase == LoadPhase.initial)
              return const Loading();
            if (st.phase == LoadPhase.error)
              return Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: ErrorBanner(
                  message: st.error ?? 'Xato',
                  onRetry: () => context.read<QueueCubit>().load(),
                ),
              );
            return RefreshIndicator(
              onRefresh: () => context.read<QueueCubit>().load(),
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.lg,
                  0,
                  AppSpacing.lg,
                  AppSpacing.xl,
                ),
                children: [
                  if (st.error != null) ErrorBanner(message: st.error!),
                  if (st.items.isEmpty)
                    const EmptyState(
                      icon: Icons.schedule,
                      text: "Navbat bo'sh",
                    ),
                  for (final q in st.items) ...[
                    AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              StatusPill(
                                label: queueStatusLabel(q.status),
                                tone: q.status == QueueStatus.failed
                                    ? StatusTone.red
                                    : (q.status == QueueStatus.started
                                          ? StatusTone.green
                                          : (queueCancellable(q.status)
                                                ? StatusTone.blue
                                                : StatusTone.faint)),
                                dot: false,
                              ),
                              const Spacer(),
                              Text(
                                q.machineSlug,
                                style: monoStyle(context, color: c.mu),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            q.promptPreview,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${queueTriggerLabel(q.trigger)}${q.nextRunAt != null ? ' · keyingi: ${formatTriggerAt(q.nextRunAt!)}' : ''}',
                            style: TextStyle(fontSize: 12, color: c.mu),
                          ),
                          if (q.lastError != null)
                            Text(
                              q.lastError!,
                              style: TextStyle(fontSize: 12, color: c.red),
                            ),
                          if (queueCancellable(q.status) &&
                              canControl &&
                              !lockdown)
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: st.cancelling.contains(q.id)
                                    ? null
                                    : () async {
                                        final cubit = context
                                            .read<QueueCubit>();
                                        final ok = await confirmDialog(
                                          context,
                                          title: 'Bekor qilinsinmi?',
                                          body: q.promptPreview,
                                          confirmLabel: 'Bekor qilish',
                                          destructive: true,
                                        );
                                        if (ok) await cubit.cancel(q.id);
                                      },
                                child: Text(
                                  'Bekor qilish',
                                  style: TextStyle(color: c.red),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}
