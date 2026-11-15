import type { ExportFile } from "@commander/contracts";
import { base64ToBytes, safeFilename } from "@/lib/billing-view";

/** Brauzerda faylni yuklab oladi (Blob + vaqtinchalik havola). Hech qayerga yuborilmaydi. */
export function downloadFile(file: Pick<ExportFile, "filename" | "contentType" | "dataBase64">): void {
  const blob = new Blob([base64ToBytes(file.dataBase64)], { type: file.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(file.filename);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
