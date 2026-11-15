import 'package:commander_contracts/commander_contracts.dart';

import '../core/util/format.dart';

/// Haftalik limit tezligi (6.12) ko'rsatish modeli (sof). CLAUDE.md #6: taxmin ("estimate") rasmiydek ko'rsatilmaydi:
/// "≈" prefiksi, "taxmin" yorlig'i va shtrixli chiziq.
enum PaceLevel { normal, warn, critical }

class PaceCardModel {
  const PaceCardModel({
    required this.shareText,
    required this.statusText,
    required this.level,
    required this.fraction,
    required this.estimate,
    this.note,
    this.forecastText,
    this.forecastWarn = false,
    this.gateNote,
  });

  /// "Bugungi ulush: 9,8% / 18,0% (54%)".
  final String shareText;

  /// "rejada" | "tez ketmoqda" | "ulush tugadi".
  final String statusText;
  final PaceLevel level;

  /// 0..1 (ulushning foizi; oshsa 1 da to'xtaydi).
  final double fraction;
  final bool estimate;

  /// "taxmin" / "rasmiy kuzatuv eskirgan" yoki null.
  final String? note;
  final String? forecastText;
  final bool forecastWarn;
  final String? gateNote;
}

/// O'nli vergul: 9,8.
String comma1(double v) =>
    ((v * 10).round() / 10).toStringAsFixed(1).replaceAll('.', ',');

PaceCardModel buildPaceCard(WeeklyPace p, {DateTime? now}) {
  final n = now ?? DateTime.now();
  final est = p.source != WeeklyPaceSource.official;
  final a = est ? '≈' : '';
  final level = switch (p.status) {
    PaceStatus.exceeded => PaceLevel.critical,
    PaceStatus.fast => PaceLevel.warn,
    _ => PaceLevel.normal,
  };
  final statusText = switch (p.status) {
    PaceStatus.onTrack => 'rejada',
    PaceStatus.fast => 'tez ketmoqda',
    PaceStatus.exceeded => 'ulush tugadi',
    _ => '—',
  };
  String? forecast;
  var warn = false;
  final exhaust = parseIso(p.exhaustAt);
  final before = p.exhaustBeforeReset;
  if (before != null && exhaust != null) {
    if (!before) {
      forecast = '${est ? '≈ ' : ''}shu tezlikda hafta oxirigacha yetadi';
    } else if (!exhaust.isAfter(n)) {
      forecast = '${est ? '≈ ' : ''}shu tezlikda hozir tugayapti';
      warn = true;
    } else {
      forecast = '${est ? '≈ ' : ''}shu tezlikda ${hhmm(exhaust)} da tugaydi';
      warn = true;
    }
  }
  return PaceCardModel(
    shareText:
        'Bugungi ulush: $a${comma1(p.usedTodayPct)}% / $a${comma1(p.allowancePct)}% (${p.pctOfAllowance.round()}%)',
    statusText: statusText,
    level: level,
    fraction: (p.pctOfAllowance / 100).clamp(0.0, 1.0),
    estimate: est,
    note: est ? 'taxmin' : (p.stale ? 'rasmiy kuzatuv eskirgan' : null),
    forecastText: forecast,
    forecastWarn: warn,
    gateNote: p.overriddenToday
        ? 'Bugun uchun ruxsat berilgan'
        : (p.blocked ? 'Yangi sessiyalar kechiktirilmoqda' : null),
  );
}
