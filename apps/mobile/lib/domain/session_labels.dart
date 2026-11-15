import 'package:commander_contracts/commander_contracts.dart';

/// Rang roli (dizayn tokenlariga presentation qatlamida xaritalanadi).
enum StatusTone { blue, yellow, orange, gray, green, red, faint }

String sessionStatusLabel(SessionStatus s) => switch (s) {
  SessionStatus.working => 'Ishlamoqda',
  SessionStatus.waiting => 'Javob kutmoqda',
  SessionStatus.awaitingApproval => 'Ruxsat kutmoqda',
  SessionStatus.idle => "Bo'sh",
  SessionStatus.done => 'Tugatdi',
  SessionStatus.ended => 'Yopilgan',
  SessionStatus.unknown => "Noma'lum",
};

StatusTone sessionStatusTone(SessionStatus s) => switch (s) {
  SessionStatus.working => StatusTone.blue,
  SessionStatus.waiting => StatusTone.yellow,
  SessionStatus.awaitingApproval => StatusTone.orange,
  SessionStatus.idle => StatusTone.gray,
  SessionStatus.done => StatusTone.green,
  SessionStatus.ended => StatusTone.faint,
  SessionStatus.unknown => StatusTone.gray,
};

bool isLive(SessionStatus s) =>
    s == SessionStatus.working || s == SessionStatus.awaitingApproval;

/// Mashina oflayn bo'lsa (`staleSince`) sessiya "Aloqa yo'q".
bool isStale(SessionDto s) =>
    s.staleSince != null && s.status != SessionStatus.ended;

String controlReasonText(ControlReason? r) => switch (r) {
  ControlReason.machineOffline => 'Mashina oflayn',
  ControlReason.policyDisabled =>
    "Masofaviy boshqaruv mashinada o'chiq (agentd siyosati)",
  ControlReason.interactive =>
    "Terminal sessiyasi: faqat ko'rish (boshqarish uchun tmux ichida oching)",
  ControlReason.sessionEnded => 'Sessiya yopilgan',
  ControlReason.promptNotAllowed => 'Bu mashinada prompt yuborish taqiqlangan',
  ControlReason.agentNotReady => 'agentd hali tayyor emas',
  ControlReason.agentOutdated => 'agentd eskirgan: yangilang',
  ControlReason.unknown || null => "Boshqarib bo'lmaydi",
};

String machineSessionsSummary(MachineSessionCounts c) {
  final parts = <String>[
    if (c.working > 0) '${c.working} ishlamoqda',
    if (c.waiting > 0) '${c.waiting} kutmoqda',
    if (c.awaitingApproval > 0) '${c.awaitingApproval} ruxsat',
    if (c.idle > 0) "${c.idle} bo'sh",
    if (c.done > 0) '${c.done} tugatdi',
  ];
  if (parts.isEmpty) return c.open > 0 ? '${c.open} sessiya' : 'sessiya yo\'q';
  return parts.take(2).join(' · ');
}

String machineName(MachineDto m) => m.hostname ?? m.displayName ?? m.slug;

String healthStatusLabel(HealthStatus s) => switch (s) {
  HealthStatus.ok => 'Soz',
  HealthStatus.warn => 'Ogohlantirish',
  HealthStatus.critical => 'Jiddiy',
  HealthStatus.offline => 'Oflayn',
  _ => "Noma'lum",
};

int healthSeverity(HealthStatus s) => switch (s) {
  HealthStatus.critical => 4,
  HealthStatus.offline => 3,
  HealthStatus.warn => 2,
  HealthStatus.ok => 0,
  _ => 1,
};

String permissionModeLabel(RemotePermissionMode m) => switch (m) {
  RemotePermissionMode.default_ => "Har safar so'rash",
  RemotePermissionMode.acceptEdits => "Tahrirlarni qabul qilish",
  RemotePermissionMode.plan => 'Reja rejimi',
  RemotePermissionMode.auto => 'Avto',
  RemotePermissionMode.unknown => "Noma'lum",
};
