import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';
import '../home/home_page.dart';
import '../projects/projects_cubits.dart';
import '../projects/projects_page.dart';
import '../sessions/sessions_cubit.dart';
import '../sessions/sessions_page.dart';
import '../tokens/tokens_cubit.dart';
import '../tokens/tokens_page.dart';
import '../../core/theme/app_colors.dart';

/// Pastki navigatsiya: Umumiy, Sessiyalar (diqqat nishoni), Loyihalar, Tokenlar.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _i = 0;

  @override
  Widget build(BuildContext context) {
    final badge = context.select(
      (DashboardCubit d) => d.state.attention.badgeCount,
    );
    final c = context.c;
    return MultiBlocProvider(
      providers: [
        BlocProvider(
          create: (ctx) => SessionsCubit(ctx.read<SessionsRepository>()),
        ),
        BlocProvider(
          create: (ctx) =>
              ProjectsCubit(ctx.read<ProjectsRepository>())..load(),
        ),
        BlocProvider(
          create: (ctx) => TokensCubit(ctx.read<UsageRepository>())..load(),
        ),
      ],
      child: Scaffold(
        body: IndexedStack(
          index: _i,
          children: [
            const HomePage(),
            const SessionsPage(),
            const ProjectsPage(),
            Scaffold(
              appBar: AppBar(title: const Text('Tokenlar')),
              body: const TokensView(),
            ),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _i,
          onDestinationSelected: (v) => setState(() => _i = v),
          backgroundColor: c.s1,
          destinations: [
            const NavigationDestination(
              icon: Icon(Icons.dashboard_outlined),
              selectedIcon: Icon(Icons.dashboard),
              label: 'Umumiy',
            ),
            NavigationDestination(
              icon: Badge(
                isLabelVisible: badge > 0,
                label: Text('$badge'),
                backgroundColor: c.org,
                child: const Icon(Icons.terminal),
              ),
              label: 'Sessiyalar',
              tooltip: badge > 0
                  ? 'Sessiyalar, $badge diqqat talab qiladi'
                  : 'Sessiyalar',
            ),
            const NavigationDestination(
              icon: Icon(Icons.folder_outlined),
              selectedIcon: Icon(Icons.folder),
              label: 'Loyihalar',
            ),
            const NavigationDestination(
              icon: Icon(Icons.bar_chart),
              label: 'Tokenlar',
            ),
          ],
        ),
      ),
    );
  }
}
