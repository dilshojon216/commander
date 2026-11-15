import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../data/realtime_client.dart';
import '../../data/repositories.dart';
import '../../domain/command_progress.dart';
import '../../domain/session_labels.dart';
import '../dashboard/dashboard_cubit.dart';
import '../navigation.dart';
import '../widgets/common.dart';
import 'new_session_cubit.dart';

/// Yangi sessiya: mashina/papka/model/rejim/shablon -> buyruq -> "Telegram'da tasdiqlang" -> sessiya.
class NewSessionPage extends StatelessWidget {
  const NewSessionPage({super.key, this.machineId});
  final String? machineId;

  @override
  Widget build(BuildContext context) => BlocProvider(
    create: (ctx) => NewSessionCubit(
      control: ctx.read<ControlRepository>(),
      projects: ctx.read<ProjectsRepository>(),
      sessions: ctx.read<SessionsRepository>(),
      realtime: ctx.read<RealtimeClient>(),
    )..init(machineId: machineId),
    child: const _NewSessionView(),
  );
}

class _NewSessionView extends StatefulWidget {
  const _NewSessionView();
  @override
  State<_NewSessionView> createState() => _NewSessionViewState();
}

class _NewSessionViewState extends State<_NewSessionView> {
  final _cwd = TextEditingController();
  final _prompt = TextEditingController();

  @override
  void dispose() {
    _cwd.dispose();
    _prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final machines = context.select((DashboardCubit d) => d.state.machines);
    final lockdown = context.select((DashboardCubit d) => d.state.lockdown);
    return BlocConsumer<NewSessionCubit, NewSessionState>(
      listenWhen: (a, b) =>
          a.openedSessionId != b.openedSessionId ||
          a.cwd != b.cwd ||
          a.prompt != b.prompt,
      listener: (context, st) {
        if (_cwd.text != st.cwd) _cwd.text = st.cwd;
        if (_prompt.text != st.prompt) _prompt.text = st.prompt;
        if (st.openedSessionId != null)
          Nav.replaceWithSession(context, st.openedSessionId!);
      },
      builder: (context, st) {
        final cubit = context.read<NewSessionCubit>();
        final p = st.progress;
        final locked = st.command != null && !(p?.terminal ?? true);
        return Scaffold(
          appBar: AppBar(title: const Text('Yangi sessiya')),
          body: Column(
            children: [
              if (lockdown) const LockdownBanner(),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  children: [
                    if (p != null)
                      _ProgressCard(
                        progress: p,
                        command: st.command!,
                        onCancel: p.phase == CommandPhase.awaitingTelegram
                            ? cubit.cancelPending
                            : null,
                      ),
                    if (st.error != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.md),
                        child: ErrorBanner(message: st.error!),
                      ),
                    const SectionLabel('Mashina'),
                    const SizedBox(height: AppSpacing.sm),
                    for (final m in machines)
                      _MachineOption(
                        machine: m,
                        selected: st.machineId == m.id,
                        enabled: !locked,
                        onTap: () => cubit.selectMachine(m.id),
                      ),
                    const SizedBox(height: AppSpacing.lg),
                    const SectionLabel('Papka'),
                    const SizedBox(height: AppSpacing.sm),
                    TextField(
                      controller: _cwd,
                      enabled: !locked,
                      autocorrect: false,
                      onChanged: cubit.setCwd,
                      decoration: const InputDecoration(
                        hintText: '/Users/…/loyiha',
                      ),
                    ),
                    if (st.folders.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.sm),
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            for (final f in st.folders.take(6))
                              ActionChip(
                                label: Text(f.name_),
                                onPressed: locked
                                    ? null
                                    : () => cubit.setCwd(f.path),
                              ),
                          ],
                        ),
                      ),
                    Text(
                      "Papka mashinaning lokal siyosatida (allowedRoots) ruxsat etilgan bo'lishi kerak.",
                      style: TextStyle(fontSize: 11, color: c.fa),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    const SectionLabel('Model'),
                    const SizedBox(height: AppSpacing.sm),
                    SegmentedButton<String>(
                      showSelectedIcon: false,
                      segments: [
                        for (final m in modelOptions)
                          ButtonSegment(value: m, label: Text(m)),
                      ],
                      selected: {st.model},
                      onSelectionChanged: locked
                          ? null
                          : (v) => cubit.setModel(v.first),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    const SectionLabel('Ruxsat rejimi'),
                    const SizedBox(height: AppSpacing.sm),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        for (final m in const [
                          RemotePermissionMode.default_,
                          RemotePermissionMode.acceptEdits,
                          RemotePermissionMode.plan,
                          RemotePermissionMode.auto,
                        ])
                          ChoiceChip(
                            label: Text(permissionModeLabel(m)),
                            selected: st.mode == m,
                            onSelected: locked ? null : (_) => cubit.setMode(m),
                          ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    Row(
                      children: [
                        const Expanded(child: SectionLabel('Vazifa matni')),
                        if (st.templates.isNotEmpty)
                          PopupMenuButton<TemplateDto>(
                            enabled: !locked,
                            tooltip: 'Shablondan',
                            onSelected: cubit.applyTemplate,
                            itemBuilder: (_) => [
                              for (final t in st.templates)
                                PopupMenuItem(value: t, child: Text(t.name_)),
                            ],
                            child: Padding(
                              padding: const EdgeInsets.all(8),
                              child: Text(
                                'Shablondan',
                                style: TextStyle(
                                  color: c.blue,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    TextField(
                      controller: _prompt,
                      enabled: !locked,
                      minLines: 4,
                      maxLines: 10,
                      maxLength: 16000,
                      onChanged: cubit.setPrompt,
                      decoration: const InputDecoration(
                        hintText: 'Claude nima qilsin?',
                      ),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Remote Control bilan ochish'),
                      subtitle: Text(
                        "Sessiyani claude.ai / Claude ilovasidan ham boshqarish",
                        style: TextStyle(color: c.mu, fontSize: 12),
                      ),
                      value: st.remoteControl,
                      onChanged: locked ? null : cubit.setRemoteControl,
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Text(
                      "Eslatma: yangi sessiya ochish Telegram'da ikkinchi tasdiq talab qiladi.",
                      style: TextStyle(fontSize: 12, color: c.mu),
                    ),
                  ],
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  child: SizedBox(
                    width: double.infinity,
                    height: AppSizes.tap,
                    child: FilledButton(
                      onPressed: st.canSubmit && !lockdown
                          ? cubit.submit
                          : null,
                      child: st.submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(lockdown ? 'Lockdown yoqiq' : 'Ochish'),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _MachineOption extends StatelessWidget {
  const _MachineOption({
    required this.machine,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });
  final MachineDto machine;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final m = machine;
    final control = m.control;
    final String? reason = !m.online
        ? 'oflayn'
        : (control == null
              ? 'agentd eskirgan'
              : (!control.enabled
                    ? "masofaviy boshqaruv o'chiq"
                    : (!control.allowStart ? 'start taqiqlangan' : null)));
    final ok = reason == null && enabled;
    return Opacity(
      opacity: reason == null ? 1 : 0.5,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(
          onTap: ok ? onTap : null,
          borderColor: selected ? c.blue : null,
          semanticLabel:
              '${machineName(m)}${reason != null ? ', $reason' : ''}${selected ? ', tanlangan' : ''}',
          child: Row(
            children: [
              PulseDot(color: m.online ? c.grn : c.fa),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  machineName(m),
                  style: monoStyle(context, size: 13, weight: FontWeight.w600),
                ),
              ),
              if (reason != null)
                Text(reason, style: TextStyle(fontSize: 12, color: c.mu)),
              if (selected) Icon(Icons.check_circle, color: c.blue, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProgressCard extends StatelessWidget {
  const _ProgressCard({
    required this.progress,
    required this.command,
    this.onCancel,
  });
  final CommandProgress progress;
  final CommandDto command;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final color = switch (progress.phase) {
      CommandPhase.awaitingTelegram => c.org,
      CommandPhase.failed => c.red,
      CommandPhase.done => c.grn,
      CommandPhase.inProgress => c.blue,
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.lg),
      child: Semantics(
        liveRegion: true,
        child: AppCard(
          borderColor: color,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (!progress.terminal)
                    const Padding(
                      padding: EdgeInsets.only(right: 10),
                      child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  Expanded(
                    child: Text(
                      progress.text,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: color,
                      ),
                    ),
                  ),
                ],
              ),
              if (progress.phase == CommandPhase.awaitingTelegram) ...[
                const SizedBox(height: 6),
                Text(
                  "Xavfsizlik uchun yangi sessiya Telegram'dagi ikkinchi tasdiqdan keyin ochiladi. Telegram'ni oching va \"Tasdiqlash\" ni bosing (2 daqiqa ichida).",
                  style: TextStyle(color: c.mu, fontSize: 13),
                ),
                if (onCancel != null)
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: onCancel,
                      child: const Text('Bekor qilish'),
                    ),
                  ),
              ],
              if (progress.phase == CommandPhase.done)
                Text(
                  'Sessiya ochilmoqda…',
                  style: TextStyle(color: c.mu, fontSize: 13),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
