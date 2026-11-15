import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/realtime_client.dart';
import '../../data/repositories.dart';
import '../../domain/chat_timeline.dart';
import '../../domain/command_progress.dart';
import '../../domain/prompt_box.dart';
import '../../domain/session_labels.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/approval_actions_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../approval/approval_flow.dart';
import '../navigation.dart';
import '../widgets/cards.dart';
import '../widgets/common.dart';
import '../widgets/safe_markdown.dart';
import 'session_cubit.dart';

class SessionPage extends StatelessWidget {
  const SessionPage({super.key, required this.sessionId, this.initial});
  final String sessionId;
  final SessionDto? initial;

  @override
  Widget build(BuildContext context) => BlocProvider(
    create: (ctx) => SessionDetailCubit(
      sessionId: sessionId,
      sessions: ctx.read<SessionsRepository>(),
      control: ctx.read<ControlRepository>(),
      realtime: ctx.read<RealtimeClient>(),
      initial:
          initial ??
          ctx
              .read<DashboardCubit>()
              .state
              .sessions
              .where((s) => s.id == sessionId)
              .firstOrNull,
    )..start(),
    child: const _SessionView(),
  );
}

class _SessionView extends StatefulWidget {
  const _SessionView();
  @override
  State<_SessionView> createState() => _SessionViewState();
}

class _SessionViewState extends State<_SessionView> {
  final _scroll = ScrollController();
  final _prompt = TextEditingController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients &&
          _scroll.position.pixels >= _scroll.position.maxScrollExtent - 200)
        context.read<SessionDetailCubit>().loadOlder();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    _prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final creds = context.read<AuthCubit>().state.credentials;
    final canControl = creds?.canControl ?? false;
    final lockdown = context.select((DashboardCubit d) => d.state.lockdown);
    return BlocConsumer<SessionDetailCubit, SessionDetailState>(
      listenWhen: (a, b) => a.draftCleared != b.draftCleared,
      listener: (context, st) => _prompt.clear(),
      builder: (context, st) {
        final s = st.session;
        return Scaffold(
          appBar: AppBar(
            title: Text(
              s?.projectName ?? 'Sessiya',
              overflow: TextOverflow.ellipsis,
            ),
            actions: [
              if (s != null &&
                  canStopSession(s, canControl: canControl, lockdown: lockdown))
                IconButton(
                  tooltip: "To'xtatish",
                  icon: const Icon(Icons.stop_circle_outlined),
                  onPressed: () => _confirmStop(context),
                ),
              if (s != null &&
                  canToggleRemoteControl(
                    s,
                    canControl: canControl,
                    lockdown: lockdown,
                  ))
                PopupMenuButton<bool>(
                  tooltip: 'Qo\'shimcha',
                  onSelected: (enable) => context
                      .read<SessionDetailCubit>()
                      .setRemoteControl(enable),
                  itemBuilder: (_) => [
                    PopupMenuItem(
                      value: !(s.remoteControl?.enabled ?? false),
                      child: Text(
                        (s.remoteControl?.enabled ?? false)
                            ? "Remote Control'ni o'chirish"
                            : 'Remote Control yoqish',
                      ),
                    ),
                  ],
                ),
            ],
          ),
          body: s == null
              ? (st.loadError != null
                    ? Padding(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        child: ErrorBanner(
                          message: st.loadError!,
                          onRetry: () =>
                              context.read<SessionDetailCubit>().start(),
                        ),
                      )
                    : const Loading())
              : Column(
                  children: [
                    if (lockdown) const LockdownBanner(),
                    _Header(session: s),
                    Expanded(
                      child: _Chat(controller: _scroll, state: st),
                    ),
                    _PendingApprovals(sessionId: s.id),
                    _CommandStrip(state: st),
                    PromptBox(
                      session: s,
                      sending: st.sending,
                      controller: _prompt,
                      canControl: canControl,
                      lockdown: lockdown,
                      onSend: (text) =>
                          context.read<SessionDetailCubit>().sendPrompt(text),
                    ),
                  ],
                ),
        );
      },
    );
  }

  Future<void> _confirmStop(BuildContext context) async {
    final cubit = context.read<SessionDetailCubit>();
    final ok = await confirmDialog(
      context,
      title: "Sessiyani to'xtatish?",
      body: "Claude joriy ishni to'xtatadi. Bu amal auditga yoziladi.",
      confirmLabel: "To'xtatish",
      destructive: true,
    );
    if (ok) await cubit.stop();
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.session});
  final SessionDto session;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final s = session;
    final stale = isStale(s);
    final rc = s.remoteControl;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: c.bd)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StatusPill(
                label: stale ? "Aloqa yo'q" : sessionStatusLabel(s.status),
                tone: stale ? StatusTone.faint : sessionStatusTone(s.status),
                live: !stale && isLive(s.status),
              ),
              Text(s.machineName, style: monoStyle(context, color: c.mu)),
              if (s.model != null)
                Text(
                  s.model!,
                  style: monoStyle(context, size: 11, color: c.fa),
                ),
              Text(
                'boshlangan ${formatAgo(parseIso(s.startedAt))} oldin',
                style: TextStyle(fontSize: 11, color: c.fa),
              ),
              if (s.taskKey != null)
                StatusPill(
                  label: s.taskKey!,
                  tone: StatusTone.gray,
                  dot: false,
                ),
              if (rc != null && rc.enabled)
                StatusPill(
                  label: 'Remote Control',
                  tone: StatusTone.blue,
                  dot: false,
                ),
            ],
          ),
          if (s.endReason != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Yopilish sababi: ${s.endReason}',
                style: TextStyle(fontSize: 12, color: c.mu),
              ),
            ),
        ],
      ),
    );
  }
}

class _Chat extends StatelessWidget {
  const _Chat({required this.controller, required this.state});
  final ScrollController controller;
  final SessionDetailState state;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final entries = state.timeline.entries.reversed.toList();
    final banner = _chatBanner(state);
    final files = state.timeline.changedFiles;
    return Column(
      children: [
        if (banner != null)
          Container(
            width: double.infinity,
            color: c.grayBg,
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg,
              vertical: 6,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    banner,
                    style: TextStyle(fontSize: 12, color: c.mu),
                  ),
                ),
                if (state.chatState == ChatState.error ||
                    state.chatState == ChatState.offline)
                  TextButton(
                    onPressed: () =>
                        context.read<SessionDetailCubit>().reopenChat(),
                    child: const Text('Qayta'),
                  ),
              ],
            ),
          ),
        if (files.isNotEmpty) _ChangedFiles(files: files),
        Expanded(
          child: entries.isEmpty
              ? EmptyState(
                  icon: Icons.chat_bubble_outline,
                  text: state.chatState == ChatState.live
                      ? "Chat hali bo'sh"
                      : (banner ?? 'Chat yuklanmoqda…'),
                )
              : ListView.builder(
                  controller: controller,
                  reverse: true,
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  itemCount: entries.length + (state.loadingOlder ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i == entries.length)
                      return const Padding(
                        padding: EdgeInsets.all(8),
                        child: Center(
                          child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      );
                    return Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: _EntryView(entry: entries[i]),
                    );
                  },
                ),
        ),
      ],
    );
  }

  static String? _chatBanner(SessionDetailState st) => switch (st.chatState) {
    ChatState.connecting => 'Chat ulanmoqda…',
    ChatState.offline => 'Chat mavjud emas: mashina oflayn',
    ChatState.unavailable =>
      "Chat mavjud emas (transkript topilmadi yoki ruxsat yo'q)",
    ChatState.error => switch (st.chatCode) {
      ChatErrorCode.forbiddenPath =>
        "Chat o'qib bo'lmaydi: yo'l ruxsat etilmagan",
      ChatErrorCode.busy => "Chat band: keyinroq urinib ko'ring",
      ChatErrorCode.notFound => 'Transkript topilmadi',
      _ => "Chatni o'qishda xato",
    },
    _ => null,
  };
}

class _ChangedFiles extends StatelessWidget {
  const _ChangedFiles({required this.files});
  final List<ChangedFile> files;
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
        dense: true,
        title: Text(
          "O'zgargan fayllar (${files.length})",
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        children: [
          for (final f in files)
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.lg,
                vertical: 2,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      f.path,
                      overflow: TextOverflow.ellipsis,
                      style: monoStyle(context),
                    ),
                  ),
                  Text('+${f.added}', style: monoStyle(context, color: c.grn)),
                  const SizedBox(width: 6),
                  Text(
                    '−${f.removed}',
                    style: monoStyle(context, color: c.red),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 6),
        ],
      ),
    );
  }
}

class _EntryView extends StatelessWidget {
  const _EntryView({required this.entry});
  final ChatEntry entry;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    switch (entry) {
      case UserEntry(:final item):
        final small =
            item.variant == ChatUserItemVariant.command ||
            item.variant == ChatUserItemVariant.shell;
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.85,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: c.blueBg,
              borderRadius: BorderRadius.circular(AppRadius.card),
            ),
            child: SelectableText(
              item.text,
              style: small
                  ? monoStyle(context, size: 12.5)
                  : const TextStyle(fontSize: 14),
            ),
          ),
        );
      case AssistantEntry(:final item, :final usage):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SafeMarkdown(item.text),
            if (usage != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'kirish ${formatTokens(usage.inputTokens)} · chiqish ${formatTokens(usage.outputTokens)} · kesh ${formatTokens(usage.cacheReadTokens)}',
                  style: monoStyle(context, size: 10.5, color: c.fa),
                ),
              ),
          ],
        );
      case ToolEntry():
        return _ToolBlock(entry: entry as ToolEntry);
      case NoticeEntry(:final item):
        final tone =
            item.level.name == 'error' || item.code == ChatNoticeItemCode.error
            ? c.red
            : c.mu;
        return Center(
          child: Text(
            item.text,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: tone),
          ),
        );
    }
  }
}

/// Yig'iladigan tool bloki: `Bash: npm test`, bosilsa natija ochiladi (matn, markdown EMAS).
class _ToolBlock extends StatefulWidget {
  const _ToolBlock({required this.entry});
  final ToolEntry entry;
  @override
  State<_ToolBlock> createState() => _ToolBlockState();
}

class _ToolBlockState extends State<_ToolBlock> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final e = widget.entry;
    final r = e.result;
    final failed = r != null && !r.ok;
    final lines = e.use.lines;
    return Container(
      decoration: BoxDecoration(
        color: c.s2,
        border: Border.all(color: failed ? c.red : c.bd),
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            button: true,
            expanded: _open,
            label: '${e.use.toolName} ${e.use.summary}',
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadius.md),
              onTap: r == null ? null : () => setState(() => _open = !_open),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Row(
                  children: [
                    Icon(
                      failed ? Icons.error_outline : Icons.terminal,
                      size: 16,
                      color: failed ? c.red : c.mu,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '${e.use.toolName}${e.use.summary.isEmpty ? '' : ': ${e.use.summary}'}',
                        maxLines: _open ? 6 : 1,
                        overflow: TextOverflow.ellipsis,
                        style: monoStyle(context),
                      ),
                    ),
                    if (lines != null) ...[
                      Text(
                        '+${lines.added}',
                        style: monoStyle(context, color: c.grn),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        '−${lines.removed}',
                        style: monoStyle(context, color: c.red),
                      ),
                    ],
                    if (r == null)
                      const Padding(
                        padding: EdgeInsets.only(left: 8),
                        child: SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 1.5),
                        ),
                      )
                    else
                      Icon(
                        _open ? Icons.expand_less : Icons.expand_more,
                        size: 18,
                        color: c.mu,
                      ),
                  ],
                ),
              ),
            ),
          ),
          if (_open && r != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: c.bd)),
              ),
              child: SelectableText(
                r.text.isEmpty
                    ? '(bo\'sh)'
                    : '${r.text}${r.truncated ? '\n… (qisqartirilgan)' : ''}',
                style: monoStyle(context, size: 11.5, color: c.mu),
              ),
            ),
        ],
      ),
    );
  }
}

class _PendingApprovals extends StatelessWidget {
  const _PendingApprovals({required this.sessionId});
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final d = context.watch<DashboardCubit>().state;
    final list = d.pending.where((a) => a.sessionId == sessionId).toList();
    if (list.isEmpty) return const SizedBox.shrink();
    final hasScope =
        context.read<AuthCubit>().state.credentials?.canApprove ?? false;
    final a = list.first;
    return BlocBuilder<ApprovalActionsCubit, ApprovalActionsState>(
      builder: (context, as) => Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.sm,
          AppSpacing.lg,
          0,
        ),
        child: ApprovalCard(
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
    );
  }
}

class _CommandStrip extends StatelessWidget {
  const _CommandStrip({required this.state});
  final SessionDetailState state;
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final p = state.progress;
    if (p == null && state.actionError == null) return const SizedBox.shrink();
    final err = state.actionError;
    final color = err != null || p?.phase == CommandPhase.failed
        ? c.red
        : (p?.phase == CommandPhase.awaitingTelegram ? c.org : c.mu);
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: 8,
        ),
        child: Row(
          children: [
            if (p != null && !p.terminal)
              const Padding(
                padding: EdgeInsets.only(right: 8),
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            Expanded(
              child: Text(
                err ?? p!.text,
                style: TextStyle(color: color, fontSize: 13),
              ),
            ),
            if (err != null || (p?.terminal ?? false))
              IconButton(
                tooltip: 'Yopish',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.close, size: 18),
                onPressed: () =>
                    context.read<SessionDetailCubit>().dismissCommand(),
              ),
          ],
        ),
      ),
    );
  }
}

/// Prompt maydoni: `controls/controlReason` bo'yicha faol / band / o'chiq (sabab bilan).
class PromptBox extends StatelessWidget {
  const PromptBox({
    super.key,
    required this.session,
    required this.sending,
    required this.controller,
    required this.canControl,
    required this.lockdown,
    required this.onSend,
  });
  final SessionDto session;
  final bool sending;
  final void Function(String text) onSend;
  final TextEditingController controller;
  final bool canControl;
  final bool lockdown;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final box = promptBoxFor(
      session,
      canControl: canControl,
      lockdown: lockdown,
    );
    final blocked = box.kind == PromptBoxKind.blocked;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.sm,
          AppSpacing.lg,
          AppSpacing.sm,
        ),
        decoration: BoxDecoration(
          color: c.s1,
          border: Border(top: BorderSide(color: c.bd)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (box.reason != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                  box.reason!,
                  style: TextStyle(fontSize: 12, color: blocked ? c.mu : c.yel),
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    enabled: !blocked,
                    minLines: 1,
                    maxLines: 5,
                    maxLength: 16000,
                    buildCounter: (
                      _, {
                      required currentLength,
                      required isFocused,
                      maxLength,
                    }) => null,
                    decoration: InputDecoration(
                      hintText: blocked ? "Faqat ko'rish" : 'Claude\'ga xabar…',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: controller,
                  builder: (context, v, _) {
                    final can =
                        box.canSend && v.text.trim().isNotEmpty && !sending;
                    return Semantics(
                      button: true,
                      label: 'Yuborish',
                      child: IconButton.filled(
                        onPressed: can ? () => onSend(v.text.trim()) : null,
                        icon: sending
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.arrow_upward),
                        tooltip: 'Yuborish',
                      ),
                    );
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
