import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_spacing.dart';

abstract final class AppTheme {
  static ThemeData build(Brightness b) {
    final c = b == Brightness.dark ? AppColors.dark : AppColors.light;
    final scheme = ColorScheme.fromSeed(seedColor: c.blue, brightness: b)
        .copyWith(
          surface: c.s1,
          onSurface: c.tx,
          primary: c.blue,
          error: c.red,
          outline: c.bd,
        );
    return ThemeData(
      useMaterial3: true,
      brightness: b,
      colorScheme: scheme,
      scaffoldBackgroundColor: c.bg,
      extensions: [c],
      dividerColor: c.bd,
      appBarTheme: AppBarTheme(
        backgroundColor: c.bg,
        foregroundColor: c.tx,
        elevation: 0,
        scrolledUnderElevation: 0,
        titleTextStyle: TextStyle(
          color: c.tx,
          fontSize: 18,
          fontWeight: FontWeight.w700,
        ),
      ),
      textTheme: Typography.material2021().black
          .apply(bodyColor: c.tx, displayColor: c.tx)
          .copyWith(
            bodyMedium: TextStyle(color: c.tx, fontSize: 14, height: 1.45),
            bodySmall: TextStyle(color: c.mu, fontSize: 12),
          ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: c.s1,
        selectedItemColor: c.tx,
        unselectedItemColor: c.mu,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.s2,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: BorderSide(color: c.bd),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: BorderSide(color: c.bd),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: c.s3,
        contentTextStyle: TextStyle(color: c.tx),
        behavior: SnackBarBehavior.floating,
      ),
      dialogTheme: DialogThemeData(backgroundColor: c.s1),
    );
  }
}
