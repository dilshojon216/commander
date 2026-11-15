import 'generated.dart';

/// Kontraktda vaqtlar ISO-8601 SATR (REST/WS DTO: `2026-11-14T04:00:28.445Z`); agent kanalida epoch ms.
/// Modellarda ular `String` bo'lib qoladi (dekodlashda xato chiqmasligi uchun); kerak bo'lganda shu yerdan parse qiling.
abstract final class ContractDates {
  /// Noto'g'ri satr uchun null.
  static DateTime? tryParse(String iso) => DateTime.tryParse(iso);

  static String format(DateTime t) => t.toUtc().toIso8601String();

  static DateTime fromEpochMs(int ms) => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
}

/// `/ws/client` autentifikatsiyasi: token `Sec-WebSocket-Protocol` orqali (query string'da HECH QACHON).
abstract final class ClientWebSocketAuth {
  /// `WebSocket.connect(url, protocols: ...)` / `IOWebSocketChannel.connect(protocols: ...)` ga beriladi.
  static List<String> subprotocols(String token) => [
        CommanderContract.clientWsSubprotocol,
        '${CommanderContract.clientWsTokenSubprotocolPrefix}$token',
      ];
}

/// QR / deep-link: `commander://pair?c=<center https url>&code=<code>[&fp=<fingerprint>]`.
final class PairingUrl {
  const PairingUrl({required this.centerUrl, required this.code, this.fingerprint});

  final Uri centerUrl;
  final String code;
  final String? fingerprint;

  /// Noto'g'ri URL uchun null. Center manzili `https` (yoki dev uchun `http://127.0.0.1` / `localhost`).
  static PairingUrl? parse(String raw) {
    final u = Uri.tryParse(raw);
    if (u == null || u.scheme != 'commander' || u.host != 'pair') return null;
    final c = u.queryParameters['c'];
    final code = u.queryParameters['code'];
    if (c == null || code == null || code.isEmpty) return null;
    final center = Uri.tryParse(c);
    if (center == null || !center.hasAuthority) return null;
    final loopback = center.scheme == 'http' && (center.host == '127.0.0.1' || center.host == 'localhost');
    if (center.scheme != 'https' && !loopback) return null;
    return PairingUrl(centerUrl: center, code: code, fingerprint: u.queryParameters['fp']);
  }
}
