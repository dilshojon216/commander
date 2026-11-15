"use client";

import { IconPlus } from "@/components/ui/icons";
import { useShellUi } from "./ShellUi";

export function NewSessionButton() {
  const { openNewSession } = useShellUi();
  return (
    <button type="button" className="btn btn-pri" onClick={() => openNewSession()}>
      <IconPlus size={14} />
      Yangi sessiya
    </button>
  );
}
