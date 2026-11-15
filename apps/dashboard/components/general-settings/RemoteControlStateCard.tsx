import type { MachineDto } from "@commander/contracts";
import Link from "next/link";
import { describeRemoteControl } from "@/lib/general-settings-view";
import type { RcTone } from "@/lib/general-settings-view";
import { machineLabel } from "@/lib/machines";
import { REMOTE_CONTROL_HELP_HREF } from "@/lib/remote-control-hint";

const TONE: Record<RcTone, string> = { ok: "bg-grn-bg text-grn", warn: "bg-yel-bg text-yel", off: "bg-gray-bg text-mu", unknown: "bg-gray-bg text-mu" };

/** Mashinalarda masofaviy boshqaruv holati (faqat o'qish): siyosat mashinaning o'zida o'zgaradi. */
export function RemoteControlStateCard({ machines }: { machines: MachineDto[] }) {
  return (
    <section className="card flex flex-col gap-3 p-4" aria-label="Masofaviy boshqaruv holati" data-testid="rc-state-card">
      <h2 className="m-0 text-sm font-semibold">Masofaviy boshqaruv (mashinalar)</h2>
      <p className="m-0 text-xs text-mu">
        Har mashinada agentd siyosati alohida: u yoqilmasa, bu mashinaga prompt yuborib, to&apos;xtatib yoki yangi sessiya ochib bo&apos;lmaydi. Bu yerdan o&apos;zgartirib bo&apos;lmaydi: yoqish/o&apos;chirish mashinaning o&apos;zida bajariladi.{" "}
        <Link href={REMOTE_CONTROL_HELP_HREF} className="text-blue underline" data-testid="rc-help-link">
          Yoqish yo&apos;riqnomasi
        </Link>
      </p>
      {machines.length === 0 ? (
        <span className="text-xs text-mu">Mashina yo&apos;q.</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {machines.map((m) => {
            const v = describeRemoteControl(m);
            return (
              <li key={m.id} className="flex flex-col gap-1 border-b border-bd pb-2.5 last:border-0 last:pb-0" data-testid="rc-machine">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[13px]">{machineLabel(m)}</b>
                  <span className={`pill ${TONE[v.tone]}`} data-tone={v.tone}>
                    {v.label}
                  </span>
                  <span className="text-[11px] text-mu">{m.online ? "onlayn" : "oflayn"}</span>
                </div>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-mu">
                  {v.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
