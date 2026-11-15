import 'dart:async';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../core/util/ids.dart';
import '../../data/command_tracker.dart';
import '../../data/realtime_client.dart';
import '../../data/repositories.dart';
import '../../domain/command_progress.dart';

const modelOptions = ['opus', 'sonnet', 'haiku'];

class NewSessionState extends Equatable {
  const NewSessionState({
    this.machineId,
    this.cwd = '',
    this.model = 'sonnet',
    this.mode = RemotePermissionMode.default_,
    this.prompt = '',
    this.remoteControl = false,
    this.folders = const [],
    this.templates = const [],
    this.submitting = false,
    this.command,
    this.error,
    this.openedSessionId,
  });

  final String? machineId;
  final String cwd;
  final String model;
  final RemotePermissionMode mode;
  final String prompt;
  final bool remoteControl;

  /// Tanlangan mashinadagi loyiha papkalari (taklif).
  final List<ProjectDto> folders;
  final List<TemplateDto> templates;
  final bool submitting;
  final CommandDto? command;
  final String? error;

  /// Buyruq bajarildi va sessiya topildi: shu yerga o'tiladi.
  final String? openedSessionId;

  CommandProgress? get progress =>
      command == null ? null : commandProgress(command!);
  bool get canSubmit =>
      machineId != null &&
      cwd.trim().isNotEmpty &&
      prompt.trim().isNotEmpty &&
      !submitting &&
      (command == null || progress!.terminal);

  NewSessionState copyWith({
    String? machineId,
    String? cwd,
    String? model,
    RemotePermissionMode? mode,
    String? prompt,
    bool? remoteControl,
    List<ProjectDto>? folders,
    List<TemplateDto>? templates,
    bool? submitting,
    CommandDto? command,
    bool clearCommand = false,
    String? error,
    bool clearError = false,
    String? openedSessionId,
  }) => NewSessionState(
    machineId: machineId ?? this.machineId,
    cwd: cwd ?? this.cwd,
    model: model ?? this.model,
    mode: mode ?? this.mode,
    prompt: prompt ?? this.prompt,
    remoteControl: remoteControl ?? this.remoteControl,
    folders: folders ?? this.folders,
    templates: templates ?? this.templates,
    submitting: submitting ?? this.submitting,
    command: clearCommand ? null : (command ?? this.command),
    error: clearError ? null : (error ?? this.error),
    openedSessionId: openedSessionId ?? this.openedSessionId,
  );

  @override
  List<Object?> get props => [
    machineId,
    cwd,
    model,
    mode,
    prompt,
    remoteControl,
    folders,
    templates,
    submitting,
    command,
    error,
    openedSessionId,
  ];
}

/// Yangi sessiya: mashina/papka/model/rejim/shablon -> `session.start` -> step-up (Telegram) -> sessiya.
class NewSessionCubit extends Cubit<NewSessionState> {
  NewSessionCubit({
    required ControlRepository control,
    required ProjectsRepository projects,
    required SessionsRepository sessions,
    required RealtimeClient realtime,
  }) : _control = control,
       _projects = projects,
       _sessions = sessions,
       _tracker = CommandTracker(control: control, realtime: realtime),
       super(const NewSessionState());

  final ControlRepository _control;
  final ProjectsRepository _projects;
  final SessionsRepository _sessions;
  final CommandTracker _tracker;
  List<ProjectDto> _allProjects = const [];
  StreamSubscription<CommandDto>? _sub;
  String? _key;

  Future<void> init({String? machineId}) async {
    try {
      _allProjects = (await _projects.list()).items;
    } on ApiException {
      _allProjects = const [];
    }
    try {
      final t = await _control.templates();
      if (!isClosed) emit(state.copyWith(templates: t));
    } on ApiException {
      // shablonlar ixtiyoriy
    }
    if (machineId != null) selectMachine(machineId);
  }

  void selectMachine(String id) {
    final folders = _allProjects.where((p) => p.machineId == id).toList()
      ..sort((a, b) => (b.lastUsedAt ?? '').compareTo(a.lastUsedAt ?? ''));
    emit(
      NewSessionState(
        machineId: id,
        cwd: folders.isNotEmpty ? folders.first.path : '',
        model: state.model,
        mode: state.mode,
        prompt: state.prompt,
        remoteControl: state.remoteControl,
        folders: folders,
        templates: state.templates,
      ),
    );
  }

  void setCwd(String v) => emit(state.copyWith(cwd: v));
  void setModel(String v) => emit(state.copyWith(model: v));
  void setMode(RemotePermissionMode v) => emit(state.copyWith(mode: v));
  void setPrompt(String v) => emit(state.copyWith(prompt: v));
  void setRemoteControl(bool v) => emit(state.copyWith(remoteControl: v));

  Future<void> applyTemplate(TemplateDto t) async {
    try {
      final r = await _control.renderTemplate(
        t.id,
        projectId: _projectForCwd(state.cwd)?.id,
      );
      if (r.missing.isNotEmpty) {
        emit(
          state.copyWith(
            error:
                "Shablon o'zgaruvchilari to'ldirilmadi: ${r.missing.join(', ')}. Matnni qo'lda yozing.",
          ),
        );
        return;
      }
      emit(
        state.copyWith(
          prompt: r.text,
          model: r.model != null && modelOptions.contains(r.model)
              ? r.model
              : null,
          mode: r.permissionMode,
          clearError: true,
        ),
      );
    } on ApiException catch (e) {
      emit(state.copyWith(error: e.userMessage));
    }
  }

  ProjectDto? _projectForCwd(String cwd) {
    for (final p in state.folders) {
      if (p.path == cwd) return p;
    }
    return null;
  }

  Future<void> submit() async {
    if (!state.canSubmit) return;
    // Bir xil urinish takrorlansa (tarmoq xatosi) Idempotency-Key qayta ishlatiladi.
    _key ??= newIdempotencyKey();
    emit(
      state.copyWith(submitting: true, clearError: true, clearCommand: true),
    );
    try {
      final res = await _control.startSession(
        machineId: state.machineId!,
        cwd: state.cwd.trim(),
        prompt: state.prompt.trim(),
        model: state.model,
        mode: state.mode,
        remoteControl: state.remoteControl,
        idempotencyKey: _key,
      );
      _key = null;
      if (isClosed) return;
      emit(state.copyWith(submitting: false, command: res.command));
      await _sub?.cancel();
      _sub = _tracker.track(res.command).listen(_onCommand);
    } on ApiException catch (e) {
      if (!isClosed)
        emit(state.copyWith(submitting: false, error: e.userMessage));
    }
  }

  Future<void> _onCommand(CommandDto c) async {
    if (isClosed) return;
    emit(state.copyWith(command: c));
    if (c.status == CommandState.done) {
      var id = c.sessionId;
      if (id == null && c.result?.claudeSessionId != null) {
        try {
          final list = await _sessions.active();
          for (final s in list) {
            if (s.claudeSessionId == c.result!.claudeSessionId) id = s.id;
          }
        } on ApiException {
          // sessiya ro'yxatda hali ko'rinmagan
        }
      }
      if (!isClosed) emit(state.copyWith(openedSessionId: id));
    }
  }

  /// Step-up kutilayotgan buyruqni bekor qilish.
  Future<void> cancelPending() async {
    final c = state.command;
    if (c == null) return;
    try {
      await _control.cancelCommand(c.id);
    } on ApiException catch (e) {
      emit(state.copyWith(error: e.userMessage));
    }
  }

  @override
  Future<void> close() async {
    await _sub?.cancel();
    return super.close();
  }
}
