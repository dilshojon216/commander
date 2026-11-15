import "server-only";
import {
  ListAlertsResponseSchema,
  ListApprovalsResponseSchema,
  ListMachinesResponseSchema,
  ListProjectsResponseSchema,
  ListSessionsResponseV1Schema,
  LimitsResponseSchema,
  SessionDtoSchema,
  ListSessionEventsResponseV1Schema,
  UsageSummaryResponseSchema,
  ProjectDetailDtoSchema,
  ProjectTasksResponseSchema,
} from "@commander/contracts";
import { getParsed } from "./commander";
import { getConfig } from "./config";
import type { HideRules } from "./machines";

export function hideRules(): HideRules {
  return { legacy: true, names: getConfig().hideMachines };
}

export function canApprove(): boolean {
  return getConfig().approveToken !== null;
}

export function canControl(): boolean {
  return getConfig().controlToken !== null;
}

export const fetchOpenAlerts = () => getParsed("/alerts?state=open&limit=50", ListAlertsResponseSchema);
export const fetchMachines = () => getParsed("/machines", ListMachinesResponseSchema);
export const fetchLimits = () => getParsed("/limits", LimitsResponseSchema);
export const fetchSummary = () => getParsed("/usage/summary", UsageSummaryResponseSchema);
export const fetchApprovals = () => getParsed("/approvals?recentLimit=10", ListApprovalsResponseSchema);
export const fetchProjects = () => getParsed("/projects?limit=500", ListProjectsResponseSchema);
export const fetchSessions = (opts: { active: boolean }) =>
  getParsed(`/sessions?limit=500${opts.active ? "&active=1" : ""}`, ListSessionsResponseV1Schema);
export const fetchSession = (id: string) => getParsed(`/sessions/${encodeURIComponent(id)}`, SessionDtoSchema);
export const fetchSessionEvents = (id: string) =>
  getParsed(`/sessions/${encodeURIComponent(id)}/events?limit=100`, ListSessionEventsResponseV1Schema);
export const fetchProjectSessions = (projectId: string) =>
  getParsed(`/sessions?project=${encodeURIComponent(projectId)}&limit=50`, ListSessionsResponseV1Schema);
export const fetchProjectDetail = (id: string) => getParsed(`/projects/${encodeURIComponent(id)}`, ProjectDetailDtoSchema);
export const fetchProjectTasks = (id: string) => getParsed(`/projects/${encodeURIComponent(id)}/tasks`, ProjectTasksResponseSchema);
