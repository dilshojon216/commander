"use client";

import type { ProjectTaskDto, RenderTemplateResponse, TemplateDto } from "@commander/contracts";
import { ProjectTasksResponseSchema } from "@commander/contracts";
import { useEffect, useState } from "react";
import { InputGuard } from "@/components/ApprovalCard";
import { useLiveData } from "@/components/LiveData";
import { getJson } from "@/lib/client-api";
import { previewSegments, previewStatus } from "./template-vm";
import { templateApi } from "./useTemplates";

/** Preview: loyiha (va vazifa) tanlanadi, markazda render qilinadi; yetishmayotgan o'zgaruvchilar ajratib ko'rsatiladi. Hech narsa saqlanmaydi. */
export function TemplatePreview({ template }: { template: TemplateDto }) {
  const { projects } = useLiveData();
  const [projectId, setProjectId] = useState(template.projectId ?? "");
  const [taskKey, setTaskKey] = useState("");
  const [tasks, setTasks] = useState<ProjectTaskDto[]>([]);
  const [res, setRes] = useState<RenderTemplateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const ctl = new AbortController();
    getJson(`/projects/${projectId}/tasks`, ProjectTasksResponseSchema, ctl.signal)
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
    return () => ctl.abort();
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void templateApi.render(template.id, { ...(projectId ? { projectId } : {}), ...(taskKey ? { taskKey } : {}) }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setRes(r.value);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [template.id, template.body, projectId, taskKey]);

  const taskList = projectId ? tasks : [];
  const st = res ? previewStatus(res) : null;
  return (
    <div className="flex flex-col gap-3" data-testid="template-preview">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Loyiha</span>
          <select className="field" value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskKey(""); }}>
            <option value="">— tanlanmagan —</option>
            {(projects?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.machineSlug}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Vazifa</span>
          <select className="field" value={taskKey} onChange={(e) => setTaskKey(e.target.value)} disabled={taskList.length === 0}>
            <option value="">{taskList.length === 0 ? "— vazifa yo'q —" : "— tanlanmagan —"}</option>
            {taskList.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key} · {t.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
          {error}
        </div>
      )}
      {res && (
        <>
          <InputGuard detail={res.text} full={false} />
          <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-bd bg-s2 p-3 text-xs" data-testid="preview-text">
            {previewSegments(res.text, res.missing).map((s, i) =>
              s.missing ? (
                <mark key={i} className="rounded bg-yel-bg px-0.5 text-yel">
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </pre>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mu">
            <span>{res.length} belgi</span>
            {st?.note && (
              <span role="status" className="text-yel">
                {st.note}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
