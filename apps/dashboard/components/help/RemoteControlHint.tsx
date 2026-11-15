"use client";

import Link from "next/link";
import { useState } from "react";
import { buildEnableCommand, REMOTE_CONTROL_HELP_HREF } from "@/lib/remote-control-hint";

/** "Yoqish" buyrug'i (nusxalash tugmasi bilan) va yo'riqnomaga havola. */
export function RemoteControlHint({ machineName }: { machineName?: string | null }) {
  const cmd = buildEnableCommand(machineName);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard mavjud emas: matn belgilab nusxalanadi */
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-[7px] bg-s2 px-2.5 py-2 text-xs" data-testid="remote-control-hint">
      <span className="text-mu">Masofaviy boshqaruv o&apos;chiq. Mac&apos;da ishga tushiring:</span>
      <pre className="mono m-0 overflow-x-auto whitespace-pre-wrap break-all text-[11px]">{cmd}</pre>
      <div className="flex items-center gap-3">
        <button type="button" className="btn h-6 px-2 text-[11px]" onClick={copy}>
          {copied ? "Nusxalandi" : "Nusxalash"}
        </button>
        <Link href={REMOTE_CONTROL_HELP_HREF} className="text-blue underline">
          Batafsil: yo&apos;riqnoma
        </Link>
      </div>
    </div>
  );
}

/** Mavjud sabab matni yoniga qo'yiladigan kichik havola. */
export function HelpLink() {
  return (
    <Link href={REMOTE_CONTROL_HELP_HREF} className="text-blue underline" data-testid="help-link">
      Batafsil: yo&apos;riqnoma
    </Link>
  );
}
