import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';
import '../widgets/common.dart';
import 'projects_cubits.dart';

/// Loyiha: vazifalar doskasi (faqat o'qish), kunlik tokenlar, git commitlar.
class ProjectDetailPage extends StatelessWidget {
  const ProjectDetailPage({
    super.key,
    required this.projectId,
    required this.name,
  });
  final String projectId;
  final String name;

  @override
  Widget build(BuildContext context) => BlocProvider(
    create: (ctx) =>
        ProjectDetailCubit(ctx.read<ProjectsRepository>(), projectId)..load(),
    child: Scaffold(
      appBar: AppBar(title: Text(name)),
      body: BlocBuilder<ProjectDetailCubit, ProjectDetailState>(
        builder: (context, st) {
          if (st.detail == null) {
            return st.phase == LoadPhase.error
                ? Padding(
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    child: ErrorBanner(
                      message: st.error ?? 'Xato',
                      onRetry: () => context.read<ProjectDetailCubit>().load(),
                    ),
                  )
                : const Loading();
          }
          return RefreshIndicator(
            onRefresh: () => context.read<ProjectDetailCubit>().load(),
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
                _Overview(detail: st.detail!),
                const SizedBox(height: 14),
                if (st.daily != null) _Daily(daily: st.daily!),
                const SizedBox(height: 14),
                _TasksBoard(tasks: st.tasks),
                const SizedBox(height: 14),
                _Commits(commits: st.detail!.commits),
              ],
            ),
          );
        },
      ),
    ),
  );
}

class _Overview extends StatelessWidget {
  const _Overview({required this.detail});
  final ProjectDetailDto detail;
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final p = detail.project;
    final g = detail.git;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${p.machineSlug} · ${p.path}',
            style: monoStyle(context, color: c.mu),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _kv(context, 'Bugun', formatTokens(p.today.totalTokens)),
              ),
              Expanded(
                child: _kv(
                  context,
                  'Jami',
                  formatTokens(p.allTime.totalTokens),
                ),
              ),
              Expanded(child: _kv(context, 'Ochiq', '${p.openSessions}')),
            ],
          ),
          if (g != null) ...[
            const SizedBox(height: 8),
            Text(
              '${g.branch ?? '—'}${g.dirty == true ? ' · o\'zgarishlar bor' : ''}${(g.ahead ?? 0) > 0 ? ' · ↑${g.ahead}' : ''}${(g.behind ?? 0) > 0 ? ' · ↓${g.behind}' : ''}',
              style: monoStyle(context, color: c.mu),
            ),
          ],
        ],
      ),
    );
  }

  Widget _kv(BuildContext context, String k, String v) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SectionLabel(k),
      Text(v, style: monoStyle(context, size: 16, weight: FontWeight.w600)),
    ],
  );
}

class _Daily extends StatelessWidget {
  const _Daily({required this.daily});
  final UsageResponse daily;
  @override
  Widget build(BuildContext context) {
    final pts = daily.series.isEmpty
        ? <UsagePoint>[]
        : daily.series.first.points;
    final values = [
      for (final p in pts)
        p.inputTokens +
            p.outputTokens +
            p.cacheReadTokens +
            p.cacheCreationTokens,
    ];
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionLabel('Kunlik tokenlar'),
          const SizedBox(height: 8),
          if (values.isEmpty)
            Text("Ma'lumot yo'q", style: TextStyle(color: context.c.mu))
          else
            MiniBars(
              values: values,
              height: 56,
              barWidth: 14,
              semanticLabel: 'Kunlik token grafigi, ${values.length} kun',
            ),
        ],
      ),
    );
  }
}

class _TasksBoard extends StatelessWidget {
  const _TasksBoard({required this.tasks});
  final ProjectTasksResponse? tasks;
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = tasks;
    if (t == null || t.summary.total == 0) {
      return AppCard(
        child: Text(
          "Reja (TASKS.md) yo'q yoki hali o'qilmagan",
          style: TextStyle(color: c.mu),
        ),
      );
    }
    final s = t.summary;
    final progress = s.total == 0 ? 0.0 : s.done / s.total;
    Widget column(String title, TaskBoardColumn col, Color tone) {
      final list = t.tasks.where((x) => x.column == col).toList();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 12, bottom: 4),
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: tone,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                SectionLabel('$title · ${list.length}'),
              ],
            ),
          ),
          for (final x in list.take(30))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 44,
                    child: Text(x.key, style: monoStyle(context, color: c.mu)),
                  ),
                  Expanded(child: Text(x.title)),
                  if (x.stats.tokens.totalTokens > 0)
                    Text(
                      formatTokens(x.stats.tokens.totalTokens),
                      style: monoStyle(context, size: 11, color: c.fa),
                    ),
                  if (x.plan.estimateHours != null)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Text(
                        '${formatHours(x.plan.actualHours)}/${formatHours(x.plan.estimateHours!)}',
                        style: monoStyle(context, size: 11, color: c.fa),
                      ),
                    ),
                ],
              ),
            ),
        ],
      );
    }

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SectionLabel('Reja'),
              const Spacer(),
              Text(
                '${s.done}/${s.total} bajarildi',
                style: TextStyle(fontSize: 12, color: c.mu),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(5),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 6,
              backgroundColor: c.s3,
              color: c.grn,
            ),
          ),
          column('Jarayonda', TaskBoardColumn.doing, c.blue),
          column('Tekshiruvda', TaskBoardColumn.review, c.yel),
          column('Qoldi', TaskBoardColumn.todo, c.mu),
          column('Bajarildi', TaskBoardColumn.done, c.grn),
        ],
      ),
    );
  }
}

class _Commits extends StatelessWidget {
  const _Commits({required this.commits});
  final List<ProjectCommitDto> commits;
  @override
  Widget build(BuildContext context) {
    if (commits.isEmpty) return const SizedBox.shrink();
    final c = context.c;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionLabel('Oxirgi commitlar'),
          for (final k in commits.take(8))
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    k.sha.length > 7 ? k.sha.substring(0, 7) : k.sha,
                    style: monoStyle(context, color: c.blue),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      k.subject,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text(
                    formatAgo(parseIso(k.ts)),
                    style: TextStyle(color: c.fa, fontSize: 11),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
