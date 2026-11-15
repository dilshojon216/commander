import 'dart:convert';

import 'package:equatable/equatable.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Juftlash natijasi. Token FAQAT Keystore/Keychain'da; hech qachon logga yozilmaydi.
class Credentials extends Equatable {
  const Credentials({
    required this.centerUrl,
    required this.token,
    required this.deviceId,
    required this.deviceName,
    required this.scopes,
    this.expiresAt,
  });

  final Uri centerUrl;
  final String token;
  final String deviceId;
  final String deviceName;
  final List<String> scopes;
  final String? expiresAt;

  bool get canApprove => scopes.contains('approve');
  bool get canControl => scopes.contains('control');

  Map<String, Object?> toJson() => {
    'centerUrl': centerUrl.toString(),
    'token': token,
    'deviceId': deviceId,
    'deviceName': deviceName,
    'scopes': scopes,
    if (expiresAt != null) 'expiresAt': expiresAt,
  };

  static Credentials? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final url = Uri.tryParse(raw['centerUrl'] as String? ?? '');
    final token = raw['token'];
    final deviceId = raw['deviceId'];
    if (url == null || token is! String || deviceId is! String) return null;
    return Credentials(
      centerUrl: url,
      token: token,
      deviceId: deviceId,
      deviceName: raw['deviceName'] as String? ?? '',
      scopes:
          (raw['scopes'] as List?)?.whereType<String>().toList() ?? const [],
      expiresAt: raw['expiresAt'] as String?,
    );
  }

  /// Tokenni ko'rsatmaydigan toString (tasodifan logga tushmasin).
  @override
  String toString() =>
      'Credentials(center=$centerUrl, device=$deviceId, scopes=$scopes)';

  @override
  List<Object?> get props => [
    centerUrl,
    token,
    deviceId,
    deviceName,
    scopes,
    expiresAt,
  ];
}

abstract interface class CredentialsStore {
  Future<Credentials?> read();
  Future<void> write(Credentials c);
  Future<void> clear();
}

class SecureCredentialsStore implements CredentialsStore {
  SecureCredentialsStore([FlutterSecureStorage? storage])
    : _s = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  static const _key = 'commander.credentials.v1';

  @override
  Future<Credentials?> read() async {
    try {
      final raw = await _s.read(key: _key);
      if (raw == null) return null;
      return Credentials.tryFromJson(jsonDecode(raw));
    } catch (_) {
      // Keystore buzilgan bo'lsa (zaxiradan tiklash va h.k.) qayta juftlash talab qilinadi.
      return null;
    }
  }

  @override
  Future<void> write(Credentials c) =>
      _s.write(key: _key, value: jsonEncode(c.toJson()));

  @override
  Future<void> clear() => _s.delete(key: _key);
}

class MemoryCredentialsStore implements CredentialsStore {
  MemoryCredentialsStore([this.value]);
  Credentials? value;
  @override
  Future<Credentials?> read() async => value;
  @override
  Future<void> write(Credentials c) async => value = c;
  @override
  Future<void> clear() async => value = null;
}
