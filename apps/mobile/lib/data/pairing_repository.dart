import 'package:commander_contracts/commander_contracts.dart';

import '../core/network/api_exception.dart';
import '../core/storage/credentials.dart';
import 'center_api.dart';
import 'device_info.dart';

/// Pairing kiritish: QR/havola yoki (markaz URL + kod).
class PairingInput {
  const PairingInput({required this.centerUrl, required this.code});
  final Uri centerUrl;
  final String code;

  /// `commander://pair?c=..&code=..` (to'liq havola) yoki bo'sh `centerUrl` + `code` maydonlari.
  /// Noto'g'ri bo'lsa `null`.
  static PairingInput? parse({String? link, String? centerUrl, String? code}) {
    final l = link?.trim();
    if (l != null && l.isNotEmpty) {
      final p = PairingUrl.parse(l);
      return p == null
          ? null
          : PairingInput(centerUrl: p.centerUrl, code: normalizeCode(p.code));
    }
    final c = code == null ? '' : normalizeCode(code);
    final u = Uri.tryParse(centerUrl?.trim() ?? '');
    if (u == null || !u.hasAuthority || c.isEmpty) return null;
    final loopback =
        u.scheme == 'http' && (u.host == '127.0.0.1' || u.host == 'localhost');
    if (u.scheme != 'https' && !loopback) return null;
    return PairingInput(centerUrl: u, code: c);
  }

  /// Kod katta harf, `XXXXX-XXXXX`; bo'shliqlar olib tashlanadi.
  static String normalizeCode(String raw) =>
      raw.trim().toUpperCase().replaceAll(RegExp(r'\s'), '');
}

class PairingRepository {
  PairingRepository({
    required this.api,
    required this.store,
    required this.device,
  });
  final CenterApi api;
  final CredentialsStore store;
  final DeviceIdentityProvider device;

  Future<Credentials?> current() => store.read();

  Future<Credentials> pair(PairingInput input) async {
    final id = await device.read();
    final res = await api.pair(
      input.centerUrl,
      ClientPairBody(
        code: input.code,
        deviceName: id.name,
        platform: id.platform,
      ),
    );
    final creds = Credentials(
      centerUrl: input.centerUrl,
      token: res.token,
      deviceId: res.deviceId,
      deviceName: res.name_,
      scopes: [for (final s in res.scopes) s.value],
      expiresAt: res.expiresAt,
    );
    await store.write(creds);
    return creds;
  }

  /// Unpair: avval markazda revoke (xato bo'lsa ham lokal tokenni o'chiramiz; markaz tomoni keyinroq muddati bilan tugaydi).
  /// `true` = markazda revoke bo'ldi.
  Future<bool> unpair() async {
    var revoked = true;
    try {
      await api.revokeSelf();
    } on ApiException {
      revoked = false;
    }
    await store.clear();
    return revoked;
  }

  /// Token hali yaroqlimi (juftlangandan keyin qayta ochilganda).
  Future<ClientDeviceMeResponse> me() => api.me();
}
