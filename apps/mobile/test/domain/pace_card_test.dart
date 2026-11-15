import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/domain/pace_card.dart';
import 'package:flutter_test/flutter_test.dart';

WeeklyPace pace([Map<String, dynamic> patch = const {}]) => WeeklyPace.fromJson({
      'dayStartPct': 20.0,
      'dayStartFrom': 'prev_sample',
      'allowancePct': 18.0,
      'usedTodayPct': 9.8,
      'pctOfAllowance': 54.4,
      'expectedPct': 50.0,
      'currentPct': 29.8,
      'onTrack': true,
      'status': 'on_track',
      'exhaustAt': null,
      'exhaustBeforeReset': null,
      'resetsAt': '2026-11-15T13:00:00.000Z',
      'windowStartsAt': '2026-11-08T13:00:00.000Z',
      'dayStartsAt': '2026-11-11T19:00:00.000Z',
      'remainingDays': 4.44,
      'source': 'official',
      'stale': false,
      'enabled': true,
      'softPct': 80.0,
      'hardPct': 100.0,
      'enforce': false,
      'overriddenToday': false,
      'blocked': false,
      'alertsToday': {'soft': null, 'hard': null},
      ...patch,
    });

final now = DateTime.parse('2026-11-14T04:00:00.000Z');

void main() {
  test('rasmiy: "Bugungi ulush: 9,8% / 18,0% (54%)", rejada, ≈ yo\'q', () {
    final m = buildPaceCard(pace(), now: now);
    expect(m.shareText, 'Bugungi ulush: 9,8% / 18,0% (54%)');
    expect(m.statusText, 'rejada');
    expect(m.level, PaceLevel.normal);
    expect(m.estimate, false);
    expect(m.note, isNull);
    expect(m.fraction, closeTo(0.544, 1e-9));
  });

  test('taxmin: "≈" va "taxmin" izohi (rasmiydek ko\'rsatilmaydi)', () {
    final m = buildPaceCard(pace({'source': 'estimate', 'stale': true}), now: now);
    expect(m.shareText, 'Bugungi ulush: ≈9,8% / ≈18,0% (54%)');
    expect(m.estimate, true);
    expect(m.note, 'taxmin');
  });

  test('eskirgan rasmiy: izoh, ≈ yo\'q', () {
    final m = buildPaceCard(pace({'stale': true}), now: now);
    expect(m.note, 'rasmiy kuzatuv eskirgan');
    expect(m.shareText, isNot(contains('≈')));
  });

  test('holatlar va bar chegarasi', () {
    final fast = buildPaceCard(pace({'status': 'fast', 'onTrack': false, 'pctOfAllowance': 85.0}), now: now);
    expect((fast.statusText, fast.level), ('tez ketmoqda', PaceLevel.warn));
    final over = buildPaceCard(pace({'status': 'exceeded', 'onTrack': false, 'pctOfAllowance': 140.0}), now: now);
    expect((over.statusText, over.level, over.fraction), ('ulush tugadi', PaceLevel.critical, 1.0));
  });

  test('bashorat: tugaydi / yetadi / yo\'q; ruxsat va kechiktirish izohlari', () {
    expect(buildPaceCard(pace(), now: now).forecastText, isNull);
    final soon = buildPaceCard(pace({'exhaustAt': '2026-11-14T10:00:00.000Z', 'exhaustBeforeReset': true}), now: now);
    expect(soon.forecastText, startsWith('shu tezlikda '));
    expect(soon.forecastText, endsWith(' da tugaydi'));
    expect(soon.forecastWarn, true);
    final safe = buildPaceCard(pace({'exhaustAt': '2026-11-20T00:00:00.000Z', 'exhaustBeforeReset': false}), now: now);
    expect(safe.forecastText, 'shu tezlikda hafta oxirigacha yetadi');
    expect(buildPaceCard(pace({'source': 'estimate', 'exhaustAt': '2026-11-14T10:00:00.000Z', 'exhaustBeforeReset': true}), now: now).forecastText, startsWith('≈ '));
    expect(buildPaceCard(pace({'overriddenToday': true}), now: now).gateNote, 'Bugun uchun ruxsat berilgan');
    expect(buildPaceCard(pace({'blocked': true, 'enforce': true}), now: now).gateNote, 'Yangi sessiyalar kechiktirilmoqda');
  });

  test('LimitsResponse: pace yo\'q (eski center) va bor holda dekodlanadi', () {
    final base = {'computedAt': '2026-11-14T04:00:00.000Z', 'freshSeconds': 180, 'fiveHour': null, 'sevenDay': null};
    expect(LimitsResponse.fromJson(base).pace, isNull);
    final withPace = LimitsResponse.fromJson({...base, 'pace': pace().toJson()});
    expect(withPace.pace?.status, PaceStatus.onTrack);
  });
}
