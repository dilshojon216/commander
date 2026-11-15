import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/storage/credentials.dart';
import '../core/util/ids.dart';

enum RealtimeStatus {
  /// To'xtatilgan (fon rejimi yoki juftlanmagan).
  idle,
  connecting,
  live,
  reconnecting,

  /// 4001/4010: token yaroqsiz; qayta ulanmaymiz.
  unauthorized,
}

typedef WsConnector = WebSocketChannel Function(
  Uri uri,
  List<String> protocols,
);

WebSocketChannel _defaultConnector(Uri uri, List<String> protocols) =>
    IOWebSocketChannel.connect(
      uri,
      protocols: protocols,
      pingInterval: const Duration(seconds: 20),
    );

/// `/ws/client` mijozi: subprotocol auth, subscribe, qayta ulanish (backoff), chat.open/close.
/// Faqat ilova oldingi planda ishlaganda ulanadi ([start]/[stop]).
class RealtimeClient {
  RealtimeClient({
    required Credentials? Function() credentials,
    WsConnector? connector,
    Duration Function(int attempt)? backoff,
    this.channels = const [
      ClientChannel.sessions,
      ClientChannel.machines,
      ClientChannel.usage,
      ClientChannel.limits,
      ClientChannel.approvals,
      ClientChannel.commands,
      ClientChannel.projects,
      ClientChannel.health,
      ClientChannel.queue,
      ClientChannel.alerts,
    ],
  }) : _creds = credentials,
       _connector = connector ?? _defaultConnector,
       _backoff = backoff ?? defaultBackoff;

  final Credentials? Function() _creds;
  final WsConnector _connector;
  final Duration Function(int) _backoff;
  final List<ClientChannel> channels;

  final _messages = StreamController<ServerToClientMessage>.broadcast();
  final _statuses = StreamController<RealtimeStatus>.broadcast();
  RealtimeStatus _status = RealtimeStatus.idle;
  int _gen = 0;
  WebSocketChannel? _ch;
  Timer? _ping;
  final _openChats = <String, int>{};

  Stream<ServerToClientMessage> get messages => _messages.stream;
  Stream<RealtimeStatus> get statuses => _statuses.stream;
  RealtimeStatus get status => _status;

  /// Testlar uchun: serverdan kelgandek xabar yuborish.
  @visibleForTesting
  void debugInject(ServerToClientMessage m) => _messages.add(m);

  @visibleForTesting
  void debugSetStatus(RealtimeStatus s) => _set(s);

  static Duration defaultBackoff(int attempt) {
    final base = min(30, 1 << min(attempt, 5));
    return Duration(milliseconds: base * 1000 + Random().nextInt(500));
  }

  /// `https://x.ts.net` -> `wss://x.ts.net/ws/client`.
  static Uri wsUri(Uri center) {
    final basePath = center.path.endsWith('/')
        ? center.path.substring(0, center.path.length - 1)
        : center.path;
    return Uri(
      scheme: center.scheme == 'https' ? 'wss' : 'ws',
      host: center.host,
      port: center.hasPort ? center.port : null,
      path: '$basePath${CommanderContract.clientWsPath}',
    );
  }

  void start() {
    if (_status == RealtimeStatus.connecting ||
        _status == RealtimeStatus.live ||
        _status == RealtimeStatus.reconnecting)
      return;
    final gen = ++_gen;
    unawaited(_run(gen));
  }

  Future<void> stop() async {
    _gen++;
    _ping?.cancel();
    await _ch?.sink.close(1000);
    _ch = null;
    _set(RealtimeStatus.idle);
  }

  void _set(RealtimeStatus s) {
    if (_status == s) return;
    _status = s;
    if (!_statuses.isClosed) _statuses.add(s);
  }

  Future<void> _run(int gen) async {
    var attempt = 0;
    while (_gen == gen) {
      final c = _creds();
      if (c == null) {
        _set(RealtimeStatus.idle);
        return;
      }
      _set(
        attempt == 0 ? RealtimeStatus.connecting : RealtimeStatus.reconnecting,
      );
      WebSocketChannel? ch;
      var wasLive = false;
      try {
        ch = _connector(
          wsUri(c.centerUrl),
          ClientWebSocketAuth.subprotocols(c.token),
        );
        _ch = ch;
        await ch.ready.timeout(const Duration(seconds: 10));
        if (_gen != gen) break;
        _startPing(ch);
        await for (final raw in ch.stream) {
          if (_gen != gen) break;
          if (_handle(raw, ch)) wasLive = true;
        }
      } catch (_) {
        // tarmoq xatosi: backoff bilan qayta uriniladi
      } finally {
        _ping?.cancel();
        final code = ch?.closeCode;
        try {
          await ch?.sink.close();
        } catch (_) {}
        if (identical(_ch, ch)) _ch = null;
        if (_gen == gen &&
            (code == CommanderContract.clientWsCloseAuthFailed ||
                code == CommanderContract.clientWsCloseRevoked ||
                code == CommanderContract.clientWsCloseProtocolError)) {
          _set(RealtimeStatus.unauthorized);
          _gen++;
        }
      }
      if (_gen != gen) return;
      attempt = wasLive ? 0 : attempt + 1;
      _set(RealtimeStatus.reconnecting);
      await Future<void>.delayed(_backoff(attempt));
    }
  }

  void _startPing(WebSocketChannel ch) {
    _ping?.cancel();
    _ping = Timer.periodic(
      const Duration(seconds: 25),
      (_) => _sendRaw(ClientPingMessage(id: newUuid(), ts: _now()).toJson()),
    );
  }

  /// `true` qaytsa ulanish "live" bo'ldi.
  bool _handle(Object? raw, WebSocketChannel ch) {
    if (raw is! String) return false;
    ServerToClientMessage msg;
    try {
      msg = ServerToClientMessage.fromJson(jsonDecode(raw));
    } catch (_) {
      return false; // buzuq kadr: e'tiborsiz (WS'ni yiqitmaymiz)
    }
    var live = false;
    switch (msg) {
      case ServerToClientMessageAuthOk():
        _sendRaw(
          ClientSubscribeMessage(
            id: newUuid(),
            ts: _now(),
            payload: ClientSubscribePayload(channels: channels),
          ).toJson(),
        );
      case ServerToClientMessageSubscribed():
        _set(RealtimeStatus.live);
        live = true;
        for (final id in _openChats.keys) {
          _sendChatOpen(id, _openChats[id]!);
        }
      case ServerToClientMessageAuthError():
        _set(RealtimeStatus.unauthorized);
        _gen++;
        ch.sink.close(1000);
      default:
        break;
    }
    if (!_messages.isClosed) _messages.add(msg);
    return live;
  }

  int _now() => DateTime.now().millisecondsSinceEpoch;

  void _sendRaw(Map<String, dynamic> json) {
    try {
      _ch?.sink.add(jsonEncode(json));
    } catch (_) {}
  }

  void _sendChatOpen(String sessionId, int limit, {String? before}) => _sendRaw(
    ChatOpenMessage(
      id: newUuid(),
      ts: _now(),
      payload: ChatOpenPayload(
        sessionId: sessionId,
        limit: limit,
        before: before,
      ),
    ).toJson(),
  );

  void openChat(String sessionId, {int limit = 200}) {
    _openChats[sessionId] = limit;
    if (_status == RealtimeStatus.live) _sendChatOpen(sessionId, limit);
  }

  /// Eski sahifa: `chat.open {before: cursor}`.
  void loadOlderChat(String sessionId, String cursor, {int limit = 100}) {
    if (_status == RealtimeStatus.live)
      _sendChatOpen(sessionId, limit, before: cursor);
  }

  void closeChat(String sessionId) {
    if (_openChats.remove(sessionId) == null) return;
    _sendRaw(
      ChatCloseMessage(
        id: newUuid(),
        ts: _now(),
        payload: ChatClosePayload(sessionId: sessionId),
      ).toJson(),
    );
  }

  Future<void> dispose() async {
    await stop();
    await _messages.close();
    await _statuses.close();
  }
}
