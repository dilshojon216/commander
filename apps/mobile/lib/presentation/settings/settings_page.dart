import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/pairing_repository.dart';
import '../auth/auth_cubit.dart';
import '../widgets/common.dart';
import 'settings_cubit.dart';

const appVersion = '1.0.0';

/// Sozlamalar: mavzu, ulangan qurilma, unpair, ilova haqida.
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final creds = context.watch<AuthCubit>().state.credentials;
    final theme = context.watch<SettingsCubit>().state.themeMode;
    return Scaffold(
      appBar: AppBar(title: const Text('Sozlamalar')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          const SectionLabel('Mavzu'),
          const SizedBox(height: AppSpacing.sm),
          SegmentedButton<ThemeMode>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: ThemeMode.dark, label: Text("Qorong'i")),
              ButtonSegment(value: ThemeMode.light, label: Text("Yorug'")),
              ButtonSegment(value: ThemeMode.system, label: Text('Tizim')),
            ],
            selected: {theme},
            onSelectionChanged: (v) =>
                context.read<SettingsCubit>().setTheme(v.first),
          ),
          const SizedBox(height: AppSpacing.xl),
          const SectionLabel('Ulangan markaz'),
          const SizedBox(height: AppSpacing.sm),
          AppCard(
            child: creds == null
                ? const Text('Juftlanmagan')
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        creds.centerUrl.toString(),
                        style: monoStyle(context, size: 13),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Qurilma: ${creds.deviceName}',
                        style: TextStyle(color: c.mu),
                      ),
                      Text(
                        'Ruxsatlar: ${creds.scopes.join(', ')}',
                        style: TextStyle(color: c.mu),
                      ),
                      if (creds.expiresAt != null)
                        Text(
                          'Token muddati: ${_date(creds.expiresAt!)}',
                          style: TextStyle(color: c.mu),
                        ),
                      const SizedBox(height: 6),
                      FutureBuilder(
                        future: context.read<PairingRepository>().me(),
                        builder: (context, snap) {
                          final me = snap.data;
                          if (me == null) return const SizedBox.shrink();
                          return Text(
                            me.stepUpExempt
                                ? "Step-up istisnosi: yo'q tasdiq so'ralmaydi"
                                : "Yangi sessiya ochish Telegram'da ikkinchi tasdiq talab qiladi",
                            style: TextStyle(color: c.mu, fontSize: 12),
                          );
                        },
                      ),
                    ],
                  ),
          ),
          const SizedBox(height: AppSpacing.lg),
          SizedBox(
            height: AppSizes.tap,
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: c.red,
                side: BorderSide(color: c.red),
              ),
              icon: const Icon(Icons.link_off),
              label: const Text('Qurilmani ajratish (unpair)'),
              onPressed: () async {
                final auth = context.read<AuthCubit>();
                final nav = Navigator.of(context);
                final ok = await confirmDialog(
                  context,
                  title: 'Ajratilsinmi?',
                  body: "Token markazda bekor qilinadi va telefondan o'chiriladi. Qayta ulash uchun yangi juftlash kodi kerak.",
                  confirmLabel: 'Ajratish',
                  destructive: true,
                );
                if (!ok) return;
                nav.popUntil((r) => r.isFirst);
                await auth.unpair();
              },
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          const SectionLabel('Ilova haqida'),
          const SizedBox(height: AppSpacing.sm),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Commander mobil',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                Text('Versiya $appVersion', style: TextStyle(color: c.mu)),
                const SizedBox(height: 6),
                Text(
                  "Faqat ilova ochiq paytida jonli ulanadi (fonda WebSocket yo'q). Token Android Keystore / iOS Keychain'da saqlanadi va logga yozilmaydi.",
                  style: TextStyle(color: c.mu, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _date(String iso) {
    final d = parseIso(iso);
    return d == null ? iso : '${d.day}.${d.month}.${d.year}';
  }
}
