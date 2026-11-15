import 'package:local_auth/local_auth.dart';

enum GateResult { confirmed, denied, unsupported }

/// Qurilma tasdig'i: biometrik yoki qurilma PIN/grafik kaliti (local_auth).
abstract interface class ConfirmGate {
  Future<GateResult> confirm(String reason);
}

class LocalAuthGate implements ConfirmGate {
  LocalAuthGate([LocalAuthentication? auth])
    : _auth = auth ?? LocalAuthentication();
  final LocalAuthentication _auth;

  @override
  Future<GateResult> confirm(String reason) async {
    try {
      if (!await _auth.isDeviceSupported()) return GateResult.unsupported;
      final ok = await _auth.authenticate(localizedReason: reason);
      return ok ? GateResult.confirmed : GateResult.denied;
    } catch (_) {
      // Foydalanuvchi bekor qildi yoki bloklandi: fail-safe = tasdiqlanmagan.
      return GateResult.denied;
    }
  }
}
