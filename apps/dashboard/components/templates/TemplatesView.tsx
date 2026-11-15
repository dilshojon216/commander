"use client";

import type { TemplateDto } from "@commander/contracts";
import { useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { IconPlus } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { TemplateFormDialog } from "./TemplateFormDialog";
import { TemplatePreview } from "./TemplatePreview";
import { groupTemplates, scopeBadge } from "./template-vm";
import { templateApi, useTemplateList } from "./useTemplates";

/** "Shablonlar" sahifasi: ko'lam bo'yicha ro'yxat, yaratish/tahrirlash/o'chirish, preview. */
export function TemplatesView() {
  const list = useTemplateList({ all: true });
  const { lockdown, canControl } = useLiveData();
  const [form, setForm] = useState<{ editing: TemplateDto | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [del, setDel] = useState<TemplateDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const groups = useMemo(() => groupTemplates(list.items), [list.items]);
  const selected = list.items.find((t) => t.id === selectedId) ?? null;
  const blocked = lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv tokeni sozlanmagan" : null;

  async function doDelete(t: TemplateDto) {
    setDel(null);
    const r = await templateApi.remove(t.id);
    if (!r.ok) setActionError(r.error);
    else {
      setActionError(null);
      if (selectedId === t.id) setSelectedId(null);
      list.reload();
    }
  }

  return (
    <>
      <PageHeader title="Shablonlar" count={`${list.items.length} ta`}>
        <button type="button" className="btn btn-pri" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setForm({ editing: null })}>
          <IconPlus size={14} /> Yangi shablon
        </button>
      </PageHeader>
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <ApiErrorBar error={list.error} />
        {actionError && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {actionError}
          </div>
        )}
        {list.loaded && list.items.length === 0 ? (
          <EmptyState title="Shablon yo'q">Takroriy promptlarni (review, testlar, CHANGELOG…) shablon qilib saqlang: sessiya ochishda, promptga yuborishda va navbatda bir bosishda ishlatiladi.</EmptyState>
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex min-w-[280px] flex-[1_1_360px] flex-col gap-4">
              {groups.map((g) => (
                <section key={g.scope} aria-label={g.label} className="flex flex-col gap-2">
                  <span className="lbl">{g.label}</span>
                  {g.items.map((t) => (
                    <div key={t.id} className={`card flex flex-col gap-1.5 p-3 ${selectedId === t.id ? "border-blue" : ""}`} data-testid="template-row">
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left font-semibold text-tx" style={{ cursor: "pointer" }} onClick={() => setSelectedId(t.id)}>
                          {t.name}
                        </button>
                        {t.builtin && <span className="pill bg-gray-bg text-mu">tizim</span>}
                        <span className="pill bg-blue-bg text-blue">{scopeBadge(t)}</span>
                      </div>
                      {t.description && <span className="text-xs text-mu">{t.description}</span>}
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-mu">
                        {t.variables.map((v) => (
                          <span key={v} className="mono rounded bg-s2 px-1.5 py-0.5">{`{{${v}}}`}</span>
                        ))}
                        {t.model && <span className="mono">· {t.model}</span>}
                        {t.permissionMode && <span className="mono">· {t.permissionMode}</span>}
                      </div>
                      <div className="flex gap-2">
                        <button type="button" className="btn h-7 text-xs" onClick={() => setSelectedId(t.id)}>
                          Preview
                        </button>
                        <button type="button" className="btn h-7 text-xs" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setForm({ editing: t })}>
                          Tahrirlash
                        </button>
                        <button type="button" className="btn btn-no h-7 text-xs" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setDel(t)}>
                          O&apos;chirish
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <aside className="card flex min-w-[280px] flex-[1_1_360px] flex-col gap-3 p-4" aria-label="Preview">
              <span className="lbl">Preview</span>
              {selected ? (
                <>
                  <b>{selected.name}</b>
                  <TemplatePreview template={selected} />
                </>
              ) : (
                <span className="text-mu">Shablonni tanlang: loyiha va vazifa bilan qanday render bo&apos;lishini ko&apos;rasiz.</span>
              )}
            </aside>
          </div>
        )}
      </div>
      {form && <TemplateFormDialog editing={form.editing} onClose={() => setForm(null)} onSaved={list.reload} />}
      {del && (
        <Dialog labelledBy="td-title" onClose={() => setDel(null)} maxWidth={440} top={120}>
          <div className="flex flex-col gap-3 px-5 py-5">
            <h2 id="td-title" className="m-0 text-base font-semibold">
              Shablonni o&apos;chirasizmi?
            </h2>
            <p className="m-0 text-mu">
              <b className="text-tx">{del.name}</b> o&apos;chiriladi. Bu amal audit jurnaliga yoziladi.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setDel(null)}>
                Bekor
              </button>
              <button type="button" className="btn btn-no" onClick={() => void doDelete(del)}>
                Ha, o&apos;chirish
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
