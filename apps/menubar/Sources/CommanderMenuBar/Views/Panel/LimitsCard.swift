import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Limitlar: 5 soat / Haftalik (+ bashorat), taxmin "≈" va xira uslub bilan (CLAUDE.md #6).
struct LimitsCard: View {
    let limits: LimitsResponse?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 6) {
                    cell("5 soat", limits?.fiveHour, now: ctx.date)
                    cell("Haftalik", limits?.sevenDay, now: ctx.date)
                }
                if let pace = limits?.pace { paceRow(pace, now: ctx.date) }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
        }
    }

    /// 6.12: "Bugun 9,8% / 18,0% (54%) · rejada" + bar; taxmin "≈" va shtrixli (CLAUDE.md #6).
    @ViewBuilder
    private func paceRow(_ p: WeeklyPace, now: Date) -> some View {
        let est = PaceFormat.isEstimate(p) || p.stale
        let tint: Color = {
            switch PaceFormat.level(p) {
            case .critical: return Theme.red
            case .warn: return Theme.yellow
            case .normal: return est ? Theme.muted : Theme.text
            }
        }()
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(PaceFormat.compactLine(p)).font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(tint)
                    .lineLimit(1).minimumScaleFactor(0.8)
                if let n = PaceFormat.note(p) { Text(n).font(.system(size: 10)).foregroundStyle(Theme.faint) }
            }
            LimitBar(pct: PaceFormat.barPct(p), color: tint, estimate: est)
            if let f = PaceFormat.forecast(p, now: now) {
                Text(f).font(.system(size: 10, weight: .medium)).italic().foregroundStyle(Theme.orange).lineLimit(1)
            }
            if let g = PaceFormat.gateNote(p) { Text(g).font(.system(size: 10)).foregroundStyle(Theme.yellow) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PaceFormat.accessibility(p, now: now))
        .help(p.dayStartFrom == .windowStart ? "Oyna bugun yangilangan: 0 dan" : "Kun boshidagi rasmiy foiz: \(PaceFormat.comma1(p.dayStartPct))%")
    }

    @ViewBuilder
    private func cell(_ title: String, _ w: LimitWindowView?, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            SectionLabel(title)
            if let w {
                let est = LimitFormat.isEstimate(w)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(LimitFormat.percent(w))
                        .font(.system(size: 15, weight: .semibold, design: .monospaced))
                        .foregroundStyle(color(w, estimate: est))
                    if let note = LimitFormat.note(w, now: now) {
                        Text(note).font(.system(size: 10)).foregroundStyle(Theme.faint)
                    }
                }
                LimitBar(pct: w.usedPct, color: color(w, estimate: est), estimate: est || w.stale)
                if let f = LimitFormat.forecast(w, now: now) {
                    Text(f).font(.system(size: 11, weight: .medium)).italic().foregroundStyle(Theme.orange)
                        .help("Taxmin: \(w.forecast.map { String(format: "%.2f%%/soat, ishonch: %@", $0.ratePctPerHour, $0.confidence.rawValue) } ?? "")")
                } else if let r = LimitFormat.resetText(w, now: now) {
                    Text(r).font(.system(size: 10)).foregroundStyle(Theme.faint)
                }
            } else {
                Text("—").font(.system(size: 15, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.faint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility(title, w, now: now))
    }

    private func color(_ w: LimitWindowView, estimate: Bool) -> Color {
        switch LimitFormat.level(w) {
        case .critical: return Theme.red
        case .warn: return Theme.yellow
        case .normal: return estimate ? Theme.muted : Theme.text
        }
    }

    private func accessibility(_ title: String, _ w: LimitWindowView?, now: Date) -> String {
        guard let w else { return "\(title) limit: ma'lumot yo'q" }
        var s = "\(title) limit \(LimitFormat.isEstimate(w) ? "taxminan " : "")\(Int(w.usedPct.rounded())) foiz"
        if let f = LimitFormat.forecast(w, now: now) { s += ", \(f.replacingOccurrences(of: "≈", with: "taxminan"))" }
        return s
    }
}
