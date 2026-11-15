"use client";

import type { ConfigMachineState, ConfigProfileDetail, ConfigProfileSummary } from "@commander/contracts";
import { useEffect, useMemo, useState } from "react";
import { IconSpinner } from "@/components/ui/icons";
import { formatDateTime } from "@/lib/format";
import { buildFileTree, captureGate, defaultCaptureMachine, formatBytes, groupProfiles, isValidProfileName, settingsFragmentLines } from "@/lib/config-view";
import type { ControlEnv } from "@/lib/config-view";
import type { Result } from "./useConfigSync";
import type { useConfigSync } from "./useConfigSync";

type Api = ReturnType<typeof useConfigSync>;

/** Profil bo'limi: nom/versiya tanlash, mashinadan olish, tanlangan versiya fayllari (faqat o'qish) va settings bo'lagi. */
export function ProfilesPanel({
  profiles,
  machines,
  env,
  name,
  versionId,
  onName,
  onVersion,
  api,
}: {
  profiles: ConfigProfileSummary[];
  machines: ConfigMachineState[];
  env: ControlEnv;
  name: string;
  versionId: string | null;
  onName: (n: string) => void;
  onVersion: (id: string | null) => void;
  api: Pick<Api, "capture" | "detail" | "fileContent">;
}) {
  const groups = useMemo(() => groupProfiles(profiles), [profiles]);
  const current = groups.find((g) => g.name === name);
  const [newName, setNewName] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const sourceId = source && machines.some((m) => m.machineId === source) ? source : defaultCaptureMachine(machines, env);
  const sourceMachine = machines.find((m) => m.machineId === sourceId) ?? null;
  const gate = sourceMachine ? captureGate(sourceMachine, env) : { enabled: false, reason: "Mashina yo'q" };
  const targetName = newName.trim() || name;
  const nameOk = isValidProfileName(targetName);

  async function capture() {
    if (!sourceId || !nameOk) return;
    setBusy(true);
    setMessage(null);
    const r = await api.capture(sourceId, targetName);
    setBusy(false);
    if (!r.ok) return setMessage({ tone: "err", text: r.error });
    setNewName("");
    onName(r.value.profile.name);
    onVersion(r.value.profile.id);
    const sk = r.value.skipped.length;
    setMessage({ tone: "ok", text: `${r.value.profile.name} v${r.value.profile.version} olindi: ${r.value.profile.fileCount} fayl${sk ? `, ${sk} ta o'tkazib yuborildi` : ""}` });
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Profillar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="lbl flex-1">Profillar</span>
        <label className="flex items-center gap-2 text-xs text-mu">
          Profil
          <select className="btn" value={name} onChange={(e) => onName(e.target.value)} aria-label="Profil nomi">
            {!current && <option value={name}>{name} (yangi)</option>}
            {groups.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.versions.length})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2" data-testid="capture-form">
        <label className="flex flex-col gap-1 text-xs text-mu">
          Manba mashina
          <select className="btn" value={sourceId ?? ""} onChange={(e) => setSource(e.target.value)} aria-label="Manba mashina">
            {machines.map((m) => (
              <option key={m.machineId} value={m.machineId}>
                {m.name}
                {m.online ? "" : " (oflayn)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-mu">
          Yangi profil nomi (ixtiyoriy)
          <input className="btn font-normal" style={{ cursor: "text" }} value={newName} placeholder={name} maxLength={64} onChange={(e) => setNewName(e.target.value)} aria-label="Yangi profil nomi" />
        </label>
        <button type="button" className="btn btn-pri" disabled={busy || !gate.enabled || !nameOk} title={gate.reason ?? (nameOk ? "Mashinadagi ~/.claude sozlamalaridan yangi versiya yaratish" : "Nom noto'g'ri")} onClick={capture}>
          {busy ? <IconSpinner size={14} /> : null} {busy ? "Olinmoqda (45 s gacha)…" : "Mashinadan olish"}
        </button>
      </div>
      {!gate.enabled && gate.reason && <div className="text-xs text-yel">{gate.reason}</div>}
      {!nameOk && <div className="text-xs text-red">Nom harf/raqam bilan boshlanishi va 64 belgidan oshmasligi kerak (A-Z a-z 0-9 bo&apos;sh joy . _ -)</div>}
      {message && (
        <div role={message.tone === "err" ? "alert" : "status"} className={`rounded-md px-3 py-2 text-xs ${message.tone === "err" ? "bg-red-bg text-red" : "bg-grn-bg text-grn"}`}>
          {message.text}
        </div>
      )}

      {current ? (
        <div className="grid gap-3 md:grid-cols-[240px_1fr]">
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Versiyalar">
            {current.versions.map((v) => (
              <li key={v.id}>
                <button type="button" className={`btn w-full justify-between ${v.id === versionId ? "btn-pri" : ""}`} aria-pressed={v.id === versionId} onClick={() => onVersion(v.id)} data-testid="profile-version">
                  <span>
                    v{v.version}
                    {v.latest ? " · eng yangi" : ""}
                  </span>
                  <span className="text-xs opacity-80">{v.fileCount} fayl</span>
                </button>
                <div className="px-1 pt-0.5 text-xs text-mu">
                  {formatDateTime(v.createdAt)} · {formatBytes(v.totalBytes)}
                  {v.sourceMachineSlug ? ` · ${v.sourceMachineSlug}` : ""}
                </div>
              </li>
            ))}
          </ul>
          <ProfileDetail versionId={versionId} detail={api.detail} fileContent={api.fileContent} />
        </div>
      ) : (
        <div className="text-xs text-mu">Bu nomda hali versiya yo&apos;q. Manba mashinani tanlab &quot;Mashinadan olish&quot; ni bosing.</div>
      )}
    </section>
  );
}

function ProfileDetail({ versionId, detail, fileContent }: { versionId: string | null; detail: Api["detail"]; fileContent: Api["fileContent"] }) {
  const [state, setState] = useState<{ id: string; result: Result<ConfigProfileDetail> } | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState<{ key: string; result: Result<{ content: string; size: number }> } | null>(null);

  useEffect(() => {
    if (!versionId) return;
    let live = true;
    detail(versionId).then((result) => {
      if (live) {
        setState({ id: versionId, result });
        setFile(null);
      }
    });
    return () => {
      live = false;
    };
  }, [versionId, detail]);

  useEffect(() => {
    if (!versionId || !file) return;
    let live = true;
    const key = `${versionId}:${file}`;
    fileContent(versionId, file).then((result) => live && setContent({ key, result }));
    return () => {
      live = false;
    };
  }, [versionId, file, fileContent]);

  if (!versionId) return <div className="text-xs text-mu">Versiyani tanlang</div>;
  if (!state || state.id !== versionId) return <div className="text-xs text-mu" aria-busy="true">Yuklanmoqda…</div>;
  if (!state.result.ok) return <div role="alert" className="text-xs text-red">{state.result.error}</div>;
  const d = state.result.value;
  const rows = buildFileTree(d.files);
  const frag = settingsFragmentLines(d.settings);
  const shown = content && content.key === `${versionId}:${file}` ? content.result : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="lbl">Fayllar ({d.files.length})</span>
          <ul className="m-0 max-h-72 list-none overflow-auto rounded-md border border-bd p-1" aria-label="Fayllar daraxti" data-testid="file-tree">
            {rows.map((r) => (
              <li key={r.path} style={{ paddingLeft: r.depth * 14 }}>
                {r.isDir ? (
                  <span className="mono text-xs text-mu">{r.name}/</span>
                ) : (
                  <button type="button" className={`mono w-full truncate rounded px-1 text-left text-xs hover:bg-s2 ${file === r.path ? "bg-s3" : ""}`} onClick={() => setFile(r.path)} title={r.path}>
                    {r.name} <span className="text-fa">{formatBytes(r.file?.size ?? 0)}</span>
                  </button>
                )}
              </li>
            ))}
            {rows.length === 0 && <li className="p-1 text-xs text-mu">Fayl yo&apos;q</li>}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="lbl">{file ?? "Fayl mazmuni"}</span>
          {/* Faqat matn sifatida (markdown/HTML bajarilmaydi) */}
          <pre className="mono m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-bd bg-s2 p-2 text-xs" data-testid="file-viewer">
            {!file ? "Faylni tanlang" : !shown ? "Yuklanmoqda…" : shown.ok ? shown.value.content : shown.error}
          </pre>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="lbl">settings.json bo&apos;lagi</span>
        {frag.length === 0 ? (
          <span className="text-xs text-mu">{d.hasSettings ? "Bo'sh bo'lak" : "Profilda settings bo'lagi yo'q"}</span>
        ) : (
          frag.map((s) => (
            <div key={s.label} className="text-xs">
              <b className="mono">{s.label}</b>
              <ul className="mono m-0 list-none p-0 text-mu">
                {s.items.map((it) => (
                  <li key={it} className="truncate" title={it}>
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      {d.skipped.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="skipped-list">
          <span className="lbl">O&apos;tkazib yuborilgan ({d.skipped.length})</span>
          <ul className="m-0 list-none p-0 text-xs">
            {d.skipped.map((s) => (
              <li key={`${s.path}:${s.reason}`}>
                <span className="mono">{s.path}</span> <span className="text-yel">· {s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
