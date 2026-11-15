import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'api_exception.dart';

/// Markaz URL'i va tokenni beruvchi (tokenni logga YOZMASLIK shart).
class ApiAuth {
  const ApiAuth({required this.baseUrl, required this.token});
  final Uri baseUrl;
  final String token;
}

/// Past darajali REST mijozi: JSON, xato xaritalash, tokenni sarlavhada yuborish.
class ApiClient {
  ApiClient({
    required http.Client client,
    required ApiAuth? Function() auth,
    this.timeout = const Duration(seconds: 15),
  }) : _client = client,
       _auth = auth;

  final http.Client _client;
  final ApiAuth? Function() _auth;
  final Duration timeout;

  Future<Object?> get(String path, {Map<String, String?> query = const {}}) =>
      _send('GET', path, query: query);

  Future<Object?> post(
    String path, {
    Object? body,
    Map<String, String> headers = const {},
  }) => _send('POST', path, body: body, extraHeaders: headers);

  /// Autentifikatsiyasiz (pairing): markaz URL'i to'g'ridan-to'g'ri beriladi.
  Future<Object?> postUnauthenticated(Uri base, String path, Object body) =>
      _send('POST', path, body: body, overrideBase: base, anonymous: true);

  Uri _uri(Uri base, String path, Map<String, String?> query) {
    final q = {
      for (final e in query.entries)
        if (e.value != null) e.key: e.value!,
    };
    final basePath = base.path.endsWith('/')
        ? base.path.substring(0, base.path.length - 1)
        : base.path;
    return base.replace(
      path: '$basePath$path',
      queryParameters: q.isEmpty ? null : q,
    );
  }

  Future<Object?> _send(
    String method,
    String path, {
    Map<String, String?> query = const {},
    Object? body,
    Map<String, String> extraHeaders = const {},
    Uri? overrideBase,
    bool anonymous = false,
  }) async {
    final auth = anonymous ? null : _auth();
    final base = overrideBase ?? auth?.baseUrl;
    if (base == null || (!anonymous && auth == null)) {
      throw const ApiException(ApiFailure.unauthorized);
    }
    final req = http.Request(method, _uri(base, path, query));
    req.headers['accept'] = 'application/json';
    if (auth != null) req.headers['authorization'] = 'Bearer ${auth.token}';
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    req.headers.addAll(extraHeaders);

    http.Response res;
    try {
      res = await http.Response.fromStream(
        await _client.send(req).timeout(timeout),
      ).timeout(timeout);
    } on TimeoutException {
      throw const ApiException(ApiFailure.unreachable);
    } on SocketException {
      throw const ApiException(ApiFailure.unreachable);
    } on HandshakeException {
      throw const ApiException(ApiFailure.unreachable);
    } on http.ClientException {
      throw const ApiException(ApiFailure.unreachable);
    }
    return _decode(res);
  }

  static Object? _decode(http.Response res) {
    Object? json;
    if (res.bodyBytes.isNotEmpty) {
      try {
        json = jsonDecode(utf8.decode(res.bodyBytes));
      } on FormatException {
        json = null;
      }
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    throw mapError(res.statusCode, json);
  }

  /// Sof funksiya: testlanadi.
  static ApiException mapError(int status, Object? json) {
    final code = json is Map ? json['error'] as String? : null;
    final msg = json is Map ? json['message'] as String? : null;
    final failure = switch (status) {
      401 when code == 'invalid_pairing_code' => ApiFailure.invalidPairingCode,
      401 => ApiFailure.unauthorized,
      403 when code == 'lockdown' => ApiFailure.lockdown,
      403 => ApiFailure.forbidden,
      409 => ApiFailure.conflict,
      429 => ApiFailure.rateLimited,
      400 || 422 => ApiFailure.validation,
      >= 500 => ApiFailure.server,
      _ => ApiFailure.unknown,
    };
    return ApiException(failure, status: status, code: code, detail: msg);
  }

  void close() => _client.close();
}
