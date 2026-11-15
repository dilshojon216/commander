import 'package:commander_contracts/commander_contracts.dart';

import '../core/util/format.dart';

/// 4 holat (DESIGN-BRIEF): rasmiy, taxmin, eskirgan, yangilangan. Taxmin HECH QACHON rasmiydek ko'rsatilmaydi.
enum LimitKind { official, estimate, stale, reset }

enum LimitLevel { normal, warn, critical }

class LimitCardModel {
  const LimitCardModel({
    required this.title,
    required this.kind,
    required this.level,
    required this.valueText,
    required this.fraction,
    required this.badge,
    required this.footer,
    this.forecastText,
    this.forecastBeforeReset = false,
  });

  final String title;
  final LimitKind kind;
  final LimitLevel level;
  final String valueText;

  /// 0..1 (to'ldirish chizig'i).
  final double fraction;

  /// "rasmiy" | "taxmin" | "eskirgan" | "yangilandi".
  final String badge;
  final String footer;
  final String? forecastText;
  final bool forecastBeforeReset;
}

LimitKind limitKind(LimitWindowView w) {
  if (w.reset) return LimitKind.reset;
  if (w.source == LimitSource.estimate) return LimitKind.estimate;
  if (w.stale) return LimitKind.stale;
  return LimitKind.official;
}

LimitLevel limitLevel(double pct) => pct >= 95
    ? LimitLevel.critical
    : (pct >= 80 ? LimitLevel.warn : LimitLevel.normal);

LimitCardModel buildLimitCard(
  String title,
  LimitWindowView w, {
  DateTime? now,
}) {
  final n = now ?? DateTime.now();
  final kind = limitKind(w);
  final pct = w.usedPct;
  final pctText = pct >= 10 || pct == pct.roundToDouble()
      ? pct.round().toString()
      : pct.toStringAsFixed(1);
  final approx = kind == LimitKind.estimate || kind == LimitKind.reset;
  final value = '${approx ? '≈' : ''}$pctText%';

  final resetAt = parseIso(w.resetsAt);
  final observed = parseIso(w.observedAt);
  final age = w.ageSeconds != null
      ? n.subtract(Duration(seconds: w.ageSeconds!))
      : observed;
  final parts = <String>[];
  if (kind == LimitKind.reset) {
    parts.add('yangilandi');
  } else if (resetAt != null && resetAt.isAfter(n)) {
    parts.add(
      '${hhmm(resetAt)} da yangilanadi (${formatSpan(resetAt.difference(n))})',
    );
  }
  if (kind == LimitKind.stale && age != null) {
    parts.add('${formatAgoLong(age, now: n)} kuzatilgan');
  } else if (kind == LimitKind.official && age != null) {
    parts.add('${formatAgoLong(age, now: n)} kuzatilgan');
  }

  String? forecast;
  var before = false;
  final f = w.forecast;
  if (f != null && kind != LimitKind.reset) {
    final t = parseIso(f.exhaustsAt);
    if (t != null) {
      before = f.beforeReset;
      forecast = before
          ? 'Limit ≈ ${hhmm(t)} da tugaydi (yangilanishdan oldin)'
          : "Yangilanishgacha yetadi";
      if (before && f.confidence == LimitForecastConfidence.low)
        forecast = '$forecast · ishonch past';
    }
  }

  return LimitCardModel(
    title: title,
    kind: kind,
    level: kind == LimitKind.reset ? LimitLevel.normal : limitLevel(pct),
    valueText: value,
    fraction: (pct / 100).clamp(0.0, 1.0),
    badge: switch (kind) {
      LimitKind.official => 'rasmiy',
      LimitKind.estimate => 'taxmin',
      LimitKind.stale => 'eskirgan',
      LimitKind.reset => 'yangilandi',
    },
    footer: parts.isEmpty ? '—' : parts.join(' · '),
    forecastText: forecast,
    forecastBeforeReset: before,
  );
}
