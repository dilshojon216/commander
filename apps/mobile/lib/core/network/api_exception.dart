/// Xato turlari: UI ularni tushunarli o'zbekcha matnga o'giradi.
enum ApiFailure {
  /// Tarmoq/Tailscale: markazga ulanib bo'lmadi.
  unreachable,
  unauthorized,
  forbidden,

  /// 403 `lockdown`.
  lockdown,

  /// 409 (allaqachon hal qilingan, muddati o'tgan).
  conflict,
  invalidPairingCode,
  rateLimited,
  validation,
  server,
  unknown,
}

class ApiException implements Exception {
  const ApiException(this.failure, {this.status, this.code, this.detail});

  final ApiFailure failure;
  final int? status;

  /// Markaz `error` kodi (`approval_conflict`, `lockdown`...).
  final String? code;

  /// Markaz `message` (texnik; UI'ga faqat yordamchi sifatida).
  final String? detail;

  String get userMessage => switch (failure) {
    ApiFailure.unreachable => "Markazga ulanib bo'lmadi. Telefonda Tailscale yoqilganini va markaz Mac ishlayotganini tekshiring.",
    ApiFailure.unauthorized =>
      "Qurilma tasdiqlanmagan yoki bekor qilingan. Qayta juftlang.",
    ApiFailure.forbidden => "Bu amal uchun ruxsat (scope) yo'q.",
    ApiFailure.lockdown => "Lockdown yoqiq: masofadan faqat rad etish mumkin.",
    ApiFailure.conflict =>
      code == 'approval_expired'
          ? "So'rov muddati o'tgan."
          : "Allaqachon hal qilingan (boshqa joyda javob berildi).",
    ApiFailure.invalidPairingCode =>
      "Kod noto'g'ri, ishlatilgan yoki muddati o'tgan. Yangi kod oling.",
    ApiFailure.rateLimited =>
      "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.",
    ApiFailure.validation => detail ?? "So'rov noto'g'ri.",
    ApiFailure.server => "Markaz xatosi. Birozdan keyin qayta urinib ko'ring.",
    ApiFailure.unknown => detail ?? "Noma'lum xato.",
  };

  @override
  String toString() => 'ApiException($failure, status=$status, code=$code)';
}
