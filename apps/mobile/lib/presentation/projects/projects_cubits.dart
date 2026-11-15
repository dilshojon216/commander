import 'package:commander_contracts/commander_contracts.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/api_exception.dart';
import '../../data/repositories.dart';
import '../dashboard/dashboard_cubit.dart';

class ProjectsState extends Equatable {
  const ProjectsState({this.phase = LoadPhase.initial, this.data, this.error});
  final LoadPhase phase;
  final ListProjectsResponse? data;
  final String? error;
  @override
  List<Object?> get props => [phase, data, error];
}

class ProjectsCubit extends Cubit<ProjectsState> {
  ProjectsCubit(this._repo) : super(const ProjectsState());
  final ProjectsRepository _repo;

  Future<void> load() async {
    emit(
      ProjectsState(
        phase: state.data == null ? LoadPhase.loading : LoadPhase.loaded,
        data: state.data,
      ),
    );
    try {
      final d = await _repo.list();
      emit(ProjectsState(phase: LoadPhase.loaded, data: d));
    } on ApiException catch (e) {
      emit(
        ProjectsState(
          phase: state.data == null ? LoadPhase.error : LoadPhase.loaded,
          data: state.data,
          error: e.userMessage,
        ),
      );
    }
  }
}

class ProjectDetailState extends Equatable {
  const ProjectDetailState({
    this.phase = LoadPhase.initial,
    this.detail,
    this.tasks,
    this.daily,
    this.error,
  });
  final LoadPhase phase;
  final ProjectDetailDto? detail;
  final ProjectTasksResponse? tasks;
  final UsageResponse? daily;
  final String? error;
  @override
  List<Object?> get props => [phase, detail, tasks, daily, error];
}

/// Loyiha sahifasi: tafsilot + vazifalar doskasi (faqat o'qish) + kunlik tokenlar.
class ProjectDetailCubit extends Cubit<ProjectDetailState> {
  ProjectDetailCubit(this._repo, this.projectId)
    : super(const ProjectDetailState());
  final ProjectsRepository _repo;
  final String projectId;

  Future<void> load() async {
    emit(
      ProjectDetailState(
        phase: state.detail == null ? LoadPhase.loading : LoadPhase.loaded,
        detail: state.detail,
        tasks: state.tasks,
        daily: state.daily,
      ),
    );
    try {
      final detail = await _repo.detail(projectId);
      // Vazifalar va kunlik ma'lumot ixtiyoriy (reja yo'q bo'lishi mumkin).
      ProjectTasksResponse? tasks;
      UsageResponse? daily;
      try {
        tasks = await _repo.tasks(projectId);
      } on ApiException {
        tasks = null;
      }
      try {
        daily = await _repo.daily(projectId);
      } on ApiException {
        daily = null;
      }
      emit(
        ProjectDetailState(
          phase: LoadPhase.loaded,
          detail: detail,
          tasks: tasks,
          daily: daily,
        ),
      );
    } on ApiException catch (e) {
      emit(
        ProjectDetailState(
          phase: state.detail == null ? LoadPhase.error : LoadPhase.loaded,
          detail: state.detail,
          tasks: state.tasks,
          daily: state.daily,
          error: e.userMessage,
        ),
      );
    }
  }
}
