import 'dart:async';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/command_tracker.dart';
import '../../data/realtime_client.dart';
import '../../data/repositories.dart';
import '../../domain/chat_timeline.dart';
import '../../domain/command_progress.dart';

class SessionDetailState extends Equatable {
  const SessionDetailState({
    this.session,
    this.timeline = const ChatTimeline(),
    this.chatState,
    this.chatCode,
    this.loadingOlder = false,
    this.loadError,
    this.sending = false,
    this.command,
    this.actionError,
    this.draftCleared = 0,
  });

  final SessionDto? session;
  final ChatTimeline timeline;
  final ChatState? chatState;
  final ChatErrorCode? chatCode;
  final bool loadingOlder;
  final String? loadError;
  final bool sending;

  /// Oxirgi yuborilgan buyruq (prompt/stop/RC) va uning holati.
  final CommandDto? command;
  final String? actionError;

  /// Prompt muvaffaqiyatli yuborilganda oshadi (UI maydonni tozalaydi).
  final int draftCleared;

  CommandProgress? get progress =>
      command == null ? null : commandProgress(command!);

  SessionDetailState copyWith({
    SessionDto? session,
    ChatTimeline? timeline,
    ChatState? chatState,
    ChatErrorCode? chatCode,
    bool clearChatCode = false,
    bool? loadingOlder,
    String? loadError,
    bool clearLoadError = false,
    bool? sending,
    CommandDto? command,
    bool clearCommand = false,
    String? actionError,
    bool clearActionError = false,
    int? draftCleared,
  }) => SessionDetailState(
    session: session ?? this.session,
    timeline: timeline ?? this.timeline,
    chatState: chatState ?? this.chatState,
    chatCode: clearChatCode ? null : (chatCode ?? this.chatCode),
    loadingOlder: loadingOlder ?? this.loadingOlder,
    loadError: clearLoadError ? null : (loadError ?? this.loadError),
    sending: sending ?? this.sending,
    command: clearCommand ? null : (command ?? this.command),
    actionError: clearActionError ? null : (actionError ?? this.actionError),
    draftCleared: draftCleared ?? this.draftCleared,
  );

  @override
  List<Object?> get props => [
    session,
    timeline.items,
    timeline.olderCursor,
    chatState,
    chatCode,
    loadingOlder,
    loadError,
    sending,
    command,
    actionError,
    draftCleared,
  ];
}

/// Sessiya sahifasi: REST sessiya + jonli chat (`chat.open`/`chat.items`) + boshqaruv buyruqlari.
class SessionDetailCubit extends Cubit<SessionDetailState> {
  SessionDetailCubit({
    required this.sessionId,
    required SessionsRepository sessions,
    required ControlRepository control,
    required RealtimeClient realtime,
    SessionDto? initial,
  }) : _sessions = sessions,
       _control = control,
       _rt = realtime,
       _tracker = CommandTracker(control: control, realtime: realtime),
       super(SessionDetailState(session: initial));

  final String sessionId;
  final SessionsRepository _sessions;
  final ControlRepository _control;
  final RealtimeClient _rt;
  final CommandTracker _tracker;
  StreamSubscription<ServerToClientMessage>? _msgSub;
  StreamSubscription<CommandDto>? _cmdSub;

  Future<void> start() async {
    _msgSub = _rt.messages.listen(_onMessage);
    _rt.openChat(sessionId);
    try {
      final s = await _sessions.get(sessionId);
      if (!isClosed) emit(state.copyWith(session: s, clearLoadError: true));
    } on ApiException catch (e) {
      if (!isClosed && state.session == null)
        emit(state.copyWith(loadError: e.userMessage));
    }
  }

  void _onMessage(ServerToClientMessage m) {
    if (isClosed) return;
    switch (m) {
      case ServerToClientMessageChatItems(:final value)
          when value.payload.sessionId == sessionId:
        emit(
          state.copyWith(
            timeline: state.timeline.apply(value.payload),
            loadingOlder: false,
          ),
        );
      case ServerToClientMessageChatState(:final value)
          when value.payload.sessionId == sessionId:
        emit(
          state.copyWith(
            chatState: value.payload.state,
            chatCode: value.payload.code,
            clearChatCode: value.payload.code == null,
          ),
        );
      case ServerToClientMessageSessionUpdated(:final value)
          when value.payload.session.id == sessionId:
        emit(state.copyWith(session: value.payload.session));
      default:
        break;
    }
  }

  void loadOlder() {
    final c = state.timeline.olderCursor;
    if (c == null || state.loadingOlder || state.timeline.reachedStart) return;
    emit(state.copyWith(loadingOlder: true));
    _rt.loadOlderChat(sessionId, c);
  }

  void reopenChat() {
    _rt.closeChat(sessionId);
    _rt.openChat(sessionId);
  }

  Future<void> sendPrompt(String text) =>
      _run(() => _control.prompt(sessionId, text), clearDraft: true);
  Future<void> stop() => _run(() => _control.stop(sessionId));
  Future<void> setRemoteControl(bool enable) =>
      _run(() => _control.remoteControl(sessionId, enable: enable));

  Future<void> _run(
    Future<CreateCommandResponse> Function() create, {
    bool clearDraft = false,
  }) async {
    if (state.sending) return;
    emit(
      state.copyWith(sending: true, clearActionError: true, clearCommand: true),
    );
    try {
      final res = await create();
      if (isClosed) return;
      emit(
        state.copyWith(
          sending: false,
          command: res.command,
          draftCleared: clearDraft ? state.draftCleared + 1 : null,
        ),
      );
      await _cmdSub?.cancel();
      _cmdSub = _tracker.track(res.command).listen((c) {
        if (!isClosed) emit(state.copyWith(command: c));
      });
    } on ApiException catch (e) {
      if (!isClosed)
        emit(state.copyWith(sending: false, actionError: e.userMessage));
    }
  }

  void dismissCommand() =>
      emit(state.copyWith(clearCommand: true, clearActionError: true));

  @override
  Future<void> close() async {
    _rt.closeChat(sessionId);
    await _msgSub?.cancel();
    await _cmdSub?.cancel();
    return super.close();
  }
}
