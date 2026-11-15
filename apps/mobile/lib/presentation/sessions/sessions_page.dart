import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../navigation.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import 'sessions_cubit.dart';

/// Sessiyalar: loyiha bo'yicha guruhlangan, filtr chiplari.
class SessionsPage extends StatelessWidget {
  const SessionsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final canControl =
        context.read<AuthCubit>().state.credentials?.canControl ?? false;
    return BlocBuilder<DashboardCubit, DashboardState>(
      builder: (context, d) => BlocBuilder<SessionsCubit, SessionsState>(
        builder: (context, st) {
          final list = SessionsCubit.apply(st.filter, d, st.ended);
          final groups = SessionsCubit.groupByProject(list);
          return Scaffold(
            appBar: AppBar(
              titleSpacing: AppSpacing.lg,
              title: const Text('Sessiyalar'),
              actions: [
                Center(child: ConnectionChip(d.connection)),
                const SizedBox(width: AppSpacing.md),
              ],
            ),
            floatingActionButton: canControl
                ? FloatingActionButton.extended(
                    onPressed: () => Nav.newSession(context),
                    icon: const Icon(Icons.add),
                    label: const Text('Yangi sessiya'),
                  )
                : null,
            body: Column(
              children: [
                if (d.lockdown) const LockdownBanner(),
                SizedBox(
                  height: 48,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.lg,
                      vertical: 6,
                    ),
                    children: [
                      for (final f in SessionFilter.values)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(sessionFilterLabel(f)),
                            selected: st.filter == f,
                            onSelected: (_) =>
                                context.read<SessionsCubit>().setFilter(f),
                          ),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: RefreshIndicator(
                    onRefresh: () async {
                      await context.read<DashboardCubit>().refresh();
                      if (st.filter == SessionFilter.ended && context.mounted)
                        await context.read<SessionsCubit>().loadEnded();
                    },
                    child: _content(context, d, st, groups, c),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _content(
    BuildContext context,
    DashboardState d,
    SessionsState st,
    Map<String, List<dynamic>> groups,
    AppColors c,
  ) {
    if (d.phase == LoadPhase.loading ||
        d.phase == LoadPhase.initial ||
        st.loadingEnded)
      return ListView(children: const [SizedBox(height: 80), Loading()]);
    if (d.phase == LoadPhase.error && d.sessions.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          ErrorBanner(
            message: d.error ?? 'Xato',
            onRetry: () => context.read<DashboardCubit>().refresh(),
          ),
        ],
      );
    }
    if (groups.isEmpty) {
      return ListView(
        children: [
          if (st.error != null)
            Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: ErrorBanner(message: st.error!),
            ),
          const SizedBox(height: 60),
          const EmptyState(icon: Icons.terminal, text: "Sessiya yo'q"),
        ],
      );
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, 96),
      children: [
        for (final e in groups.entries) ...[
          Padding(
            padding: const EdgeInsets.only(top: 10, bottom: 6),
            child: SectionLabel('${e.key} · ${e.value.length}'),
          ),
          for (final s in e.value) ...[
            SessionTile(
              session: s,
              showProject: false,
              onTap: () => Nav.session(context, s.id, initial: s),
            ),
            const SizedBox(height: 8),
          ],
        ],
      ],
    );
  }
}
