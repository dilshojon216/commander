import 'package:commander_contracts/commander_contracts.dart';

/// 67 600 000 -> "67.6M", 140 000 -> "140K".
String formatTokens(num v) {
  final a = v.abs();
  String f(double x, String s) =>
      '${x >= 100 ? x.toStringAsFixed(0) : x.toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}$s';
  if (a >= 1e9) return f(v / 1e9, 'B');
  if (a >= 1e6) return f(v / 1e6, 'M');
  if (a >= 1e3) return f(v / 1e3, 'K');
  return v.round().toString();
}

DateTime? parseIso(String? iso) =>
    iso == null ? null : ContractDates.tryParse(iso)?.toLocal();

/// "6 daq", "2 soat", "3 kun", "hozir".
String formatAgo(DateTime? t, {DateTime? now}) {
  if (t == null) return '—';
  final d = (now ?? DateTime.now()).difference(t);
  if (d.inSeconds < 45) return 'hozir';
  if (d.inMinutes < 60) return '${d.inMinutes.clamp(1, 59)} daq';
  if (d.inHours < 24) return '${d.inHours} soat';
  return '${d.inDays} kun';
}

/// "2 daqiqa oldin".
String formatAgoLong(DateTime? t, {DateTime? now}) {
  if (t == null) return '—';
  final d = (now ?? DateTime.now()).difference(t);
  if (d.inSeconds < 45) return 'hozir';
  if (d.inMinutes < 60) return '${d.inMinutes.clamp(1, 59)} daqiqa oldin';
  if (d.inHours < 24) return '${d.inHours} soat oldin';
  return '${d.inDays} kun oldin';
}

/// Teskari sanoq: 4:12. Manfiy bo'lsa 0:00.
String formatCountdown(Duration d) {
  final s = d.isNegative ? 0 : d.inSeconds;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

String hhmm(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// "1d 4h" ko'rinishida emas, o'zbekcha: "4 soat 10 daq".
String formatSpan(Duration d) {
  if (d.inMinutes < 1) return '<1 daq';
  if (d.inHours < 1) return '${d.inMinutes} daq';
  if (d.inHours < 48) return '${d.inHours} soat ${d.inMinutes % 60} daq';
  return '${d.inDays} kun';
}

String formatHours(double h) => h < 1
    ? '${(h * 60).round()} daq'
    : '${h.toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')} soat';

String formatUsd(double? v) => v == null
    ? '—'
    : '\$${v >= 100 ? v.toStringAsFixed(0) : v.toStringAsFixed(2)}';

String shortPath(String p) {
  final parts = p.split('/').where((e) => e.isNotEmpty).toList();
  return parts.isEmpty ? p : parts.last;
}
