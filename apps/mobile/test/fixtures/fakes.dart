import 'dart:async';
import 'dart:convert';

import 'package:commander_mobile/core/network/api_client.dart';
import 'package:commander_mobile/core/storage/credentials.dart';
import 'package:commander_mobile/core/storage/credentials_holder.dart';
import 'package:commander_mobile/data/biometric_gate.dart';
import 'package:commander_mobile/data/center_api.dart';
import 'package:commander_mobile/data/device_info.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'fixture.dart';

final testCreds = Credentials(
  centerUrl: Uri.parse('https://mac.tail1234.ts.net'),
  token: 'cmdr_TESTTOKEN',
  deviceId: 'dev-1',
  deviceName: 'Test Phone',
  scopes: const ['read', 'approve', 'control'],
);

class RecordedRequest {
  RecordedRequest(this.method, this.url, this.headers, this.body);
  final String method;
  final Uri url;
  final Map<String, String> headers;
  final String body;
}

/// Yo'l bo'yicha javob beruvchi soxta markaz (fixture'lardan).
class FakeCenter {
  FakeCenter() {
    for (final e in {
      '/v1/machines': 'machines',
      '/v1/sessions': 'sessions',
      '/v1/approvals': 'approvals',
      '/v1/limits': 'limits',
      '/v1/usage/summary': 'usage-summary',
      '/v1/alerts': 'alerts',
      '/v1/health/summary': 'health-summary',
      '/v1/projects': 'projects',
      '/v1/queue': 'queue',
      '/v1/usage': 'usage-series',
    }.entries) {
      routes['GET ${e.key}'] = (_) => http.Response(jsonEncode(fixture(e.value)), 200, headers: {'content-type': 'application/json'});
    }
  }

  final routes = <String, http.Response Function(http.Request)>{};
  final requests = <RecordedRequest>[];

  void on(String method, String path, http.Response Function(http.Request) h) => routes['$method $path'] = h;

  void json(String method, String path, Object? body, {int status = 200}) =>
      on(method, path, (_) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'}));

  late final client = MockClient((req) async {
    requests.add(RecordedRequest(req.method, req.url, req.headers, req.body));
    final h = routes['${req.method} ${req.url.path}'];
    if (h == null) return http.Response(jsonEncode({'error': 'not_found', 'message': 'yo\'q'}), 404);
    return h(req);
  });

  CenterApi api({CredentialsHolder? holder}) {
    final hd = holder ?? (CredentialsHolder()..value = testCreds);
    return CenterApi(ApiClient(client: client, auth: () => hd.value == null ? null : ApiAuth(baseUrl: hd.value!.centerUrl, token: hd.value!.token)));
  }
}

class FakeGate implements ConfirmGate {
  FakeGate(this.result);
  GateResult result;
  int calls = 0;
  @override
  Future<GateResult> confirm(String reason) async {
    calls++;
    return result;
  }
}

class FakeDevice implements DeviceIdentityProvider {
  @override
  Future<DeviceIdentity> read() async => const DeviceIdentity(name: 'Xiaomi Test', platform: 'android');
}

/// Soxta WebSocket kanali.
class FakeWs extends StreamChannelMixin<dynamic> implements WebSocketChannel {
  FakeWs() {
    _sink = _FakeSink(this);
  }
  final incoming = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];
  late final _FakeSink _sink;
  int? _closeCode;

  void serverSend(Object json) => incoming.add(jsonEncode(json));
  void serverClose(int code) {
    _closeCode = code;
    incoming.close();
  }

  @override
  Future<void> get ready => Future.value();
  @override
  String? get protocol => 'commander.v1';
  @override
  int? get closeCode => _closeCode;
  @override
  String? get closeReason => null;
  @override
  Stream<dynamic> get stream => incoming.stream;
  @override
  WebSocketSink get sink => _sink;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this.ch);
  final FakeWs ch;
  @override
  void add(dynamic data) => ch.sent.add((jsonDecode(data as String) as Map).cast<String, dynamic>());
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<dynamic> stream) => stream.drain<void>();
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    ch._closeCode ??= closeCode;
    if (!ch.incoming.isClosed) await ch.incoming.close();
  }

  @override
  Future<void> get done => Future.value();
}
