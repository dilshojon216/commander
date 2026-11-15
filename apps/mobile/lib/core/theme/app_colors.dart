import 'package:flutter/material.dart';

/// Dizayn tokenlari (docs/design: MobileHome.dc.html `.t-dark` / `.t-light`).
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.bg,
    required this.s1,
    required this.s2,
    required this.s3,
    required this.bd,
    required this.tx,
    required this.mu,
    required this.fa,
    required this.blue,
    required this.yel,
    required this.org,
    required this.grn,
    required this.red,
    required this.blueBg,
    required this.yelBg,
    required this.orgBg,
    required this.grnBg,
    required this.redBg,
    required this.grayBg,
    required this.onOk,
  });

  final Color bg, s1, s2, s3, bd, tx, mu, fa;
  final Color blue, yel, org, grn, red;
  final Color blueBg, yelBg, orgBg, grnBg, redBg, grayBg, onOk;

  static const dark = AppColors(
    bg: Color(0xFF0B0D10),
    s1: Color(0xFF12151A),
    s2: Color(0xFF181C22),
    s3: Color(0xFF20252D),
    bd: Color(0xFF262C35),
    tx: Color(0xFFE6E8EB),
    mu: Color(0xFF9AA3B0),
    fa: Color(0xFF6E7684),
    blue: Color(0xFF5B9BFF),
    yel: Color(0xFFE8BE54),
    org: Color(0xFFFF8A4C),
    grn: Color(0xFF4CC38A),
    red: Color(0xFFFF6B66),
    blueBg: Color(0x225B9BFF),
    yelBg: Color(0x22E8BE54),
    orgBg: Color(0x24FF8A4C),
    grnBg: Color(0x224CC38A),
    redBg: Color(0x22FF6B66),
    grayBg: Color(0x1F9AA3B0),
    onOk: Color(0xFF06150D),
  );

  static const light = AppColors(
    bg: Color(0xFFF4F5F7),
    s1: Color(0xFFFFFFFF),
    s2: Color(0xFFF7F8FA),
    s3: Color(0xFFECEEF2),
    bd: Color(0xFFDFE2E8),
    tx: Color(0xFF14171C),
    mu: Color(0xFF525B68),
    fa: Color(0xFF7A8390),
    blue: Color(0xFF1D5FD6),
    yel: Color(0xFF8A5A00),
    org: Color(0xFFB23C08),
    grn: Color(0xFF13733F),
    red: Color(0xFFC42B27),
    blueBg: Color(0xFFE7EFFD),
    yelBg: Color(0xFFFBF1D6),
    orgBg: Color(0xFFFCE8DC),
    grnBg: Color(0xFFE1F3E8),
    redBg: Color(0xFFFCE5E4),
    grayBg: Color(0xFFECEEF2),
    onOk: Color(0xFFFFFFFF),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) =>
      t < 0.5 ? this : (other as AppColors? ?? this);
}

extension AppColorsContext on BuildContext {
  AppColors get c => Theme.of(this).extension<AppColors>()!;
}
