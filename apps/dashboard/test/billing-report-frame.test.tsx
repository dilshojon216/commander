import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportFrame } from "@/components/billing/ClientReportPanel";

describe("<ReportFrame /> (6.8 ko'rib chiqish)", () => {
  it("bo'sh sandbox: skript/forma/same-origin ruxsati yo'q; hujjat srcdoc'da escape qilingan atribut", () => {
    const hostile = '<!doctype html><script>fetch("/api/c/commands")</script><img src=x onerror=alert(1)>"\'';
    const html = renderToStaticMarkup(<ReportFrame html={hostile} />);
    expect(html).toContain('sandbox=""');
    expect(html).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
    expect(html).toMatch(/referrer-?policy="no-referrer"/i);
    // srcdoc qiymati atribut ichida escape qilingan: tashqariga chiqib teg ochmaydi
    const outside = html.replace(/srcDoc="[^"]*"/i, "");
    expect(outside).not.toContain("<script");
    expect(outside).not.toContain("onerror");
  });
});
