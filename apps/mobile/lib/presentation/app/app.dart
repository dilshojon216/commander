import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../app_dependencies.dart';
import '../../core/theme/app_theme.dart';
import '../../data/biometric_gate.dart';
import '../../data/pairing_repository.dart';
import '../../data/realtime_client.dart';
import '../../data/repositories.dart';
import '../../data/snapshot.dart';
import '../auth/auth_cubit.dart';
import '../dashboard/approval_actions_cubit.dart';
import '../dashboard/dashboard_cubit.dart';
import '../pairing/pairing_page.dart';
import '../settings/settings_cubit.dart';
import 'home_shell.dart';

class CommanderApp extends StatefulWidget {
  const CommanderApp({super.key, required this.deps});
  final AppDependencies deps;

  @override
  State<CommanderApp> createState() => _CommanderAppState();
}

class _CommanderAppState extends State<CommanderApp>
    with WidgetsBindingObserver {
  late final AuthCubit _auth = AuthCubit(
    repo: widget.deps.pairing,
    realtime: widget.deps.realtime,
    holder: widget.deps.holder,
  )..init();
  late final SettingsCubit _settings = SettingsCubit()..load();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.close();
    _settings.close();
    super.dispose();
  }

  /// Faqat oldingi planda jonli ulanish (fonda WS yo'q).
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final rt = widget.deps.realtime;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      rt.stop();
    } else if (state == AppLifecycleState.resumed &&
        widget.deps.holder.value != null) {
      rt.start();
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.deps;
    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider<AppDependencies>.value(value: d),
        RepositoryProvider<RealtimeClient>.value(value: d.realtime),
        RepositoryProvider<ConfirmGate>.value(value: d.gate),
        RepositoryProvider<PairingRepository>.value(value: d.pairing),
        RepositoryProvider<OverviewRepository>.value(value: d.overview),
        RepositoryProvider<SessionsRepository>.value(value: d.sessions),
        RepositoryProvider<ProjectsRepository>.value(value: d.projects),
        RepositoryProvider<UsageRepository>.value(value: d.usage),
        RepositoryProvider<QueueRepository>.value(value: d.queue),
        RepositoryProvider<ControlRepository>.value(value: d.control),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider.value(value: _auth),
          BlocProvider.value(value: _settings),
        ],
        // Dashboard/ruxsat cubit'lari MaterialApp'dan YUQORIDA: push qilingan sahifalar (Navigator) ham ko'radi.
        child: BlocBuilder<AuthCubit, AuthState>(
          buildWhen: (a, b) =>
              a.phase != b.phase ||
              a.credentials?.deviceId != b.credentials?.deviceId,
          builder: (context, a) {
            final app = BlocBuilder<SettingsCubit, SettingsState>(
              builder: (context, s) => MaterialApp(
                title: 'Commander',
                debugShowCheckedModeBanner: false,
                theme: AppTheme.build(Brightness.light),
                darkTheme: AppTheme.build(Brightness.dark),
                themeMode: s.themeMode,
                home: switch (a.phase) {
                  AuthPhase.loading => const Scaffold(
                    body: Center(child: CircularProgressIndicator()),
                  ),
                  AuthPhase.unpaired => const PairingPage(),
                  AuthPhase.paired => const HomeShell(),
                },
              ),
            );
            if (a.phase != AuthPhase.paired) return app;
            return _PairedScope(
              key: ValueKey(a.credentials!.deviceId),
              child: app,
            );
          },
        ),
      ),
    );
  }
}

/// Juftlangan holat: Dashboard va ruxsat qarorlari cubit'lari (har juftlashda yangidan).
class _PairedScope extends StatelessWidget {
  const _PairedScope({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => MultiBlocProvider(
    providers: [
      BlocProvider(
        create: (ctx) => DashboardCubit(
          repo: ctx.read<OverviewRepository>(),
          realtime: ctx.read<RealtimeClient>(),
        )..load(),
      ),
      BlocProvider(
        create: (ctx) {
          final dash = ctx.read<DashboardCubit>();
          return ApprovalActionsCubit(
            control: ctx.read<ControlRepository>(),
            onResolved: dash.applyApproval,
            onConflict: dash.refresh,
          );
        },
      ),
    ],
    child: BlocListener<DashboardCubit, DashboardState>(
      listenWhen: (a, b) =>
          a.failure != b.failure && b.failure?.name == 'unauthorized',
      listener: (context, st) => context.read<AuthCubit>().sessionExpired(),
      child: child,
    ),
  );
}
