"use client";

import { ClientDtoSchema, ClientReportPreviewSchema, CreateClientReportResponseSchema, ExportFileSchema, ListBillingProjectsResponseSchema, ListClientReportSnapshotsResponseSchema, ListClientsResponseSchema, TimesheetDtoSchema } from "@commander/contracts";
import type { BillingProjectDto, ClientDto, ClientReportPreview, ClientReportSnapshotDto, CreateClientBody, CreateClientReportBody, CreateClientReportResponse, ExportFile, TimesheetDto, UpdateClientBody } from "@commander/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { billingHttpErrorText } from "@/lib/billing-view";
import { ApiCallError, getJson, patchJson, postJson, requestJson } from "@/lib/client-api";

type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
const fail = (e: unknown): string => (e instanceof ApiCallError ? billingHttpErrorText(e.status, e.body) : billingHttpErrorText(0, null));

/** Mijozlar va loyiha guruhlari (6.7): REST snapshot; yozuvlardan keyin qayta o'qiladi. */
export function useBillingClients(): {
  clients: ClientDto[];
  projects: BillingProjectDto[];
  loaded: boolean;
  error: string | null;
  reload: () => void;
  create: (b: CreateClientBody) => Promise<Result>;
  update: (id: string, b: UpdateClientBody) => Promise<Result>;
  remove: (id: string) => Promise<Result>;
  setProjects: (id: string, keys: string[]) => Promise<Result>;
} {
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [projects, setProjects] = useState<BillingProjectDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    Promise.all([getJson("/billing/clients", ListClientsResponseSchema, ctl.signal), getJson("/billing/projects", ListBillingProjectsResponseSchema, ctl.signal)])
      .then(([c, p]) => {
        setClients(c.items);
        setProjects(p.items);
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Xatolik");
      });
  }, []);

  useEffect(() => {
    load();
    return () => aborter.current?.abort();
  }, [load]);

  const write = useCallback(
    async (fn: () => Promise<unknown>): Promise<Result> => {
      try {
        await fn();
        load();
        return { ok: true, value: undefined };
      } catch (e) {
        load();
        return { ok: false, error: fail(e) };
      }
    },
    [load],
  );

  return {
    clients,
    projects,
    loaded,
    error,
    reload: load,
    create: (b) => write(() => postJson("/billing/clients", b, ClientDtoSchema)),
    update: (id, b) => write(() => patchJson(`/billing/clients/${id}`, b, ClientDtoSchema)),
    remove: (id) => write(() => requestJson("DELETE", `/billing/clients/${id}`)),
    setProjects: (id, keys) => write(() => requestJson("PUT", `/billing/clients/${id}/projects`, { projectKeys: keys })),
  };
}

/** Timesheet: so'rov qatori o'zgarganda qayta yuklanadi (`null` = so'rov yo'q). */
export function useTimesheet(query: string | null): { dto: TimesheetDto | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ dto: TimesheetDto | null; loading: boolean; error: string | null }>({ dto: null, loading: false, error: null });
  useEffect(() => {
    if (query === null) return;
    const ctl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- so'rov boshlanishi holati
    setState((s) => ({ ...s, loading: true, error: null }));
    getJson(`/billing/timesheet?${query}`, TimesheetDtoSchema, ctl.signal)
      .then((dto) => setState({ dto, loading: false, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setState((s) => ({ ...s, loading: false, error: fail(e) }));
      });
    return () => ctl.abort();
  }, [query]);
  return state;
}

export async function fetchExport(query: string): Promise<Result<ExportFile>> {
  try {
    return { ok: true, value: await getJson(`/billing/timesheet/export?${query}`, ExportFileSchema) };
  } catch (e) {
    return { ok: false, error: fail(e) };
  }
}

export async function fetchReportPreview(query: string): Promise<Result<ClientReportPreview>> {
  try {
    return { ok: true, value: await getJson(`/client-reports/preview?${query}`, ClientReportPreviewSchema) };
  } catch (e) {
    return { ok: false, error: fail(e) };
  }
}

export async function createReport(body: CreateClientReportBody): Promise<Result<CreateClientReportResponse>> {
  try {
    return { ok: true, value: await postJson("/client-reports", body, CreateClientReportResponseSchema) };
  } catch (e) {
    return { ok: false, error: fail(e) };
  }
}

export async function fetchSnapshots(): Promise<Result<ClientReportSnapshotDto[]>> {
  try {
    return { ok: true, value: (await getJson("/client-reports", ListClientReportSnapshotsResponseSchema)).items };
  } catch (e) {
    return { ok: false, error: fail(e) };
  }
}
