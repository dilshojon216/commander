import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../dashboard/dashboard_cubit.dart';
import '../navigation.dart';
import '../../domain/session_labels.dart';
import '../widgets/common.dart';
import 'projects_cubits.dart';

/// Loyihalar: bugungi va jami tokenlar, ochiq sessiyalar.
class ProjectsPage extends StatelessWidget {
  const ProjectsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: AppSpacing.lg,
        title: const Text('Loyihalar'),
      ),
      body: BlocBuilder<ProjectsCubit, ProjectsState>(
        builder: (context, st) {
          final data = st.data;
          if (data == null) {
            return st.phase == LoadPhase.error
                ? Padding(
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    child: ErrorBanner(
                      message: st.error ?? 'Xato',
                      onRetry: () => context.read<ProjectsCubit>().load(),
                    ),
                  )
                : const Loading();
          }
          final items = [
            ...data.items,
          ]..sort((a, b) => b.today.totalTokens.compareTo(a.today.totalTokens));
          return RefreshIndicator(
            onRefresh: () => context.read<ProjectsCubit>().load(),
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
                if (items.isEmpty)
                  const EmptyState(
                    icon: Icons.folder_open,
                    text: "Loyiha yo'q",
                  ),
                for (final p in items) ...[
                  AppCard(
                    onTap: () => Nav.project(context, p.id, p.name_),
                    semanticLabel:
                        '${p.name_}, bugun ${formatTokens(p.today.totalTokens)} token',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                p.name_,
                                style: const TextStyle(
                                  fontWeight: FontWeight.w700,
                                  fontSize: 15,
                                ),
                              ),
                            ),
                            if (p.openSessions > 0)
                              StatusPill(
                                label: '${p.openSessions} ochiq',
                                tone: StatusTone.blue,
                                dot: false,
                              ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          p.machineSlug,
                          style: monoStyle(context, color: c.mu),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            _Stat(
                              label: 'Bugun',
                              value: formatTokens(p.today.totalTokens),
                            ),
                            _Stat(
                              label: 'Jami',
                              value: formatTokens(p.allTime.totalTokens),
                            ),
                            _Stat(
                              label: "So'rov",
                              value: p.allTime.requests.round().toString(),
                            ),
                          ],
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
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Expanded(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionLabel(label),
        Text(
          value,
          style: monoStyle(context, size: 15, weight: FontWeight.w600),
        ),
      ],
    ),
  );
}
