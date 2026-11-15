import 'dart:async';

import 'package:commander_contracts/commander_contracts.dart';

import '../core/network/api_exception.dart';
import '../domain/command_progress.dart';
import 'realtime_client.dart';
import 'repositories.dart';

/// Buyruq holatini kuzatadi: WS `command.updated` + (zaxira) REST so'rovi. Yakuniy holatda tugaydi.
class CommandTracker {
  CommandTracker({
    required this.control,
    required this.realtime,
    this.pollEvery = const Duration(seconds: 3),
    this.maxWait = const Duration(minutes: 4),
  });

  final ControlRepository control;
  final RealtimeClient realtime;
  final Duration pollEvery;
  final Duration maxWait;

  Stream<CommandDto> track(CommandDto initial) {
    late StreamController<CommandDto> ctrl;
    StreamSubscription<ServerToClientMessage>? sub;
    Timer? timer;
    var closed = false;

    Future<void> close() async {
      if (closed) return;
      closed = true;
      timer?.cancel();
      await sub?.cancel();
      await ctrl.close();
    }

    void push(CommandDto c) {
      if (closed) return;
      ctrl.add(c);
      if (commandProgress(c).terminal) unawaited(close());
    }

    ctrl = StreamController<CommandDto>(
      onListen: () {
        push(initial);
        if (closed) return;
        sub = realtime.messages.listen((m) {
          if (m is ServerToClientMessageCommandUpdated &&
              m.value.payload.command.id == initial.id)
            push(m.value.payload.command);
        });
        final started = DateTime.now();
        timer = Timer.periodic(pollEvery, (_) async {
          if (DateTime.now().difference(started) > maxWait) {
            unawaited(close());
            return;
          }
          try {
            push(await control.command(initial.id));
          } on ApiException {
            // vaqtincha xato: keyingi urinishda
          }
        });
      },
      onCancel: close,
    );
    return ctrl.stream;
  }
}
