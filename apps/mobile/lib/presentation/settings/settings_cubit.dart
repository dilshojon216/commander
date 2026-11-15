import 'package:equatable/equatable.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsState extends Equatable {
  const SettingsState({this.themeMode = ThemeMode.dark});
  final ThemeMode themeMode;
  @override
  List<Object?> get props => [themeMode];
}

/// Mavzu (qorong'i/yorug'/tizim). Maxfiy bo'lmagan sozlama: shared_preferences.
class SettingsCubit extends Cubit<SettingsState> {
  SettingsCubit() : super(const SettingsState());
  static const _key = 'themeMode';

  Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final v = p.getString(_key);
      emit(
        SettingsState(
          themeMode: ThemeMode.values.firstWhere(
            (m) => m.name == v,
            orElse: () => ThemeMode.dark,
          ),
        ),
      );
    } catch (_) {
      // sozlama o'qilmasa default (qorong'i)
    }
  }

  Future<void> setTheme(ThemeMode m) async {
    emit(SettingsState(themeMode: m));
    try {
      (await SharedPreferences.getInstance()).setString(_key, m.name);
    } catch (_) {}
  }
}
