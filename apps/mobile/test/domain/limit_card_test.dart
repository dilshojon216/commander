import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/domain/limit_card.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fixtures/fixture.dart';

LimitWindowView window(Map<String, dynamic> patch) => LimitWindowView.fromJson({
      'usedPct': 8.0,
      'resetsAt': '2026-11-15T13:00:00.000Z',
      'observedAt': '2026-11-14T03:58:00.000Z',
      'source': 'official',
      'stale': false,
      'ageSeconds': 120,
      'reset': false,
      ...patch,
    });

final now = DateTime.parse('2026-11-14T04:00:00.000Z');

void main() {
  test('rasmiy: aniq raqam, "≈" yo\'q, "rasmiy" yorlig\'i', () {
    final m = buildLimitCard('Haftalik', window({}), now: now);
    expect(m.kind, LimitKind.official);
    expect(m.valueText, '8%');
    expect(m.badge, 'rasmiy');
    expect(m.footer, contains('kuzatilgan'));
  });

  test('taxmin: "≈" va "taxmin" yorlig\'i (rasmiydek ko\'rsatilmaydi)', () {
    final m = buildLimitCard('5 soat', window({'source': 'estimate', 'usedPct': 12.0, 'stale': true}), now: now);
    expect(m.kind, LimitKind.estimate);
    expect(m.valueText, '≈12%');
    expect(m.badge, 'taxmin');
  });

  test("eskirgan rasmiy: raqam saqlanadi, 'oldin kuzatilgan' va 'eskirgan'", () {
    final m = buildLimitCard('5 soat', window({'stale': true, 'ageSeconds': 3 * 3600, 'observedAt': '2026-11-14T01:00:00.000Z'}), now: now);
    expect(m.kind, LimitKind.stale);
    expect(m.valueText, '8%');
    expect(m.badge, 'eskirgan');
    expect(m.footer, contains('3 soat oldin kuzatilgan'));
  });

  test('yangilangan (reset): ≈0% · yangilandi', () {
    final m = buildLimitCard('5 soat', window({'reset': true, 'source': 'estimate', 'usedPct': 0.0}), now: now);
    expect(m.kind, LimitKind.reset);
    expect(m.valueText, '≈0%');
    expect(m.footer, contains('yangilandi'));
    expect(m.level, LimitLevel.normal);
  });

  test('chegaralar: 80% sariq, 95% qizil', () {
    expect(limitLevel(79.9), LimitLevel.normal);
    expect(limitLevel(80), LimitLevel.warn);
    expect(limitLevel(94.9), LimitLevel.warn);
    expect(limitLevel(95), LimitLevel.critical);
  });

  test('bashorat limit tugashini yangilanishdan oldin ko\'rsatadi', () {
    final m = buildLimitCard(
      'Haftalik',
      window({
        'usedPct': 70.0,
        'forecast': {
          'exhaustsAt': '2026-11-15T09:30:00.000Z',
          'beforeReset': true,
          'resetsAt': '2026-11-15T13:00:00.000Z',
          'ratePctPerHour': 2.0,
          'basisMinutes': 60,
          'basisWeightedTokens': 1000.0,
          'confidence': 'low',
          'source': 'estimate',
        },
      }),
      now: now,
    );
    expect(m.forecastBeforeReset, isTrue);
    expect(m.forecastText, contains('yangilanishdan oldin'));
    expect(m.forecastText, contains('ishonch past'));
  });

  test('jonli fixture (limits.json) dekodlanadi va kartaga aylanadi', () {
    final l = LimitsResponse.fromJson(fixture('limits'));
    final five = buildLimitCard('5 soat', l.fiveHour!, now: now);
    final week = buildLimitCard('Haftalik', l.sevenDay!, now: now);
    expect(five.kind, LimitKind.reset);
    expect(week.kind, LimitKind.estimate);
    expect(week.valueText, startsWith('≈'));
    expect(week.forecastText, isNotNull);
  });
}
