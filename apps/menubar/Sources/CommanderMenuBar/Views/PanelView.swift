import CommanderContracts
import MenuBarCore
import SwiftUI

/// MenuBarExtra (.window) paneli (dizayn: MacMenuBar.dc.html, 380px).
struct PanelView: View {
    let model: AppModel
    static let maxApprovals = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if model.showSettings {
                SettingsView(model: model)
            } else {
                main
            }
        }
        .padding(8)
        .frame(width: 380)
        .onAppear { model.panelAppeared() }
        .onDisappear { model.panelDisappeared() }
    }

    @ViewBuilder
    private var main: some View {
        let summary = model.summary
        PanelHeader(model: model, summary: summary)
        if !model.isPaired {
            UnpairedView(model: model)
        } else {
            ConnectionBanner(model: model)
            if model.state.lockdown {
                Banner(text: "Lockdown yoqiq: masofadan faqat rad etish mumkin", fg: Theme.red, bg: Theme.redBg, icon: "lock.fill")
            }
            // Panel cheklangan balandlikda: ko'pi bilan 3 ta ruxsat kartasi va 8 ta loyiha; qolgani dashboard'da.
            let approvals = model.sortedApprovals
            ForEach(approvals.prefix(Self.maxApprovals), id: \.id) { a in
                ApprovalCardView(approval: a, model: model)
            }
            if approvals.count > Self.maxApprovals {
                MenuRow(title: "Yana \(approvals.count - Self.maxApprovals) ta ruxsat so'rovi — dashboard'da") { model.openDashboard() }
            }
            ForEach(Array(model.fading.keys.sorted()), id: \.self) { id in
                if let f = model.fading[id] { FadingApprovalView(approval: f.approval, message: f.message) }
            }
            SessionsSection(model: model)

            Divider().padding(.horizontal, 4).padding(.vertical, 2)
            LimitsCard(limits: model.state.limits)
            StatusStrip(summary: summary)
        }
        Divider().padding(.horizontal, 4).padding(.vertical, 2)
        MenuRow(title: "Dashboard'ni ochish", shortcut: "⌘D") { model.openDashboard() }
            .keyboardShortcut("d", modifiers: .command)
        MenuRow(title: "Brauzerda ochish") { model.openDashboardInBrowser() }
        MenuRow(title: "Sozlamalar…", shortcut: "⌘,") { model.showSettings = true }
            .keyboardShortcut(",", modifiers: .command)
        MenuRow(title: "Chiqish", shortcut: "⌘Q") { NSApp.terminate(nil) }
            .keyboardShortcut("q", modifiers: .command)
    }
}

struct PanelHeader: View {
    let model: AppModel
    let summary: DashboardSummary

    var body: some View {
        let mood = model.mood
        HStack(spacing: 8) {
            MascotView(pose: mood.pose, light: mood.light, height: 30)
            Text("Commander").font(.system(size: 14, weight: .bold))
            Spacer()
            connectionPill
            if summary.totalMachines > 0 {
                Pill(text: "\(summary.onlineMachines)/\(summary.totalMachines) mashina", fg: Theme.muted, bg: Theme.grayBg, dot: false, mono: true)
                    .accessibilityLabel("\(summary.onlineMachines) ta mashina onlayn, jami \(summary.totalMachines)")
            }
        }
        .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 6)
    }

    @ViewBuilder
    private var connectionPill: some View {
        switch model.connection {
        case .live: Pill(text: "Jonli", fg: Theme.green, bg: Theme.greenBg, pulsing: true)
        case .connecting: Pill(text: "Ulanmoqda…", fg: Theme.muted, bg: Theme.grayBg)
        case .reconnecting: Pill(text: "Qayta ulanmoqda…", fg: Theme.yellow, bg: Theme.yellowBg)
        case .unauthorized: Pill(text: "Token rad etildi", fg: Theme.red, bg: Theme.redBg)
        case .unpaired: Pill(text: "Ulanmagan", fg: Theme.muted, bg: Theme.grayBg)
        }
    }
}

struct ConnectionBanner: View {
    let model: AppModel

    var body: some View {
        switch model.connection {
        case .reconnecting(let attempt, let retryAt):
            HStack {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let s = max(0, Int(retryAt.timeIntervalSince(ctx.date)))
                    Text("Markaz bilan aloqa yo'q. \(s) s dan keyin qayta urinadi (\(attempt)-urinish). Ma'lumot eskirgan bo'lishi mumkin.")
                        .font(.system(size: 11))
                }
                Spacer()
                Button("Hozir") { model.reconnectNow() }.buttonStyle(CardButton(kind: .plain))
            }
            .padding(8).foregroundStyle(Theme.yellow)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.yellowBg))
        case .unauthorized(let reason):
            HStack {
                Text(reason).font(.system(size: 11))
                Spacer()
                Button("Qayta ulash…") { model.showPairing() }.buttonStyle(CardButton(kind: .plain))
            }
            .padding(8).foregroundStyle(Theme.red)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.redBg))
        default:
            if let e = model.lastError {
                Banner(text: e, fg: Theme.yellow, bg: Theme.yellowBg, icon: "exclamationmark.triangle")
            }
        }
    }
}

struct Banner: View {
    let text: String
    let fg: Color
    let bg: Color
    let icon: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).accessibilityHidden(true)
            Text(text).font(.system(size: 11, weight: .medium))
            Spacer()
        }
        .padding(8).foregroundStyle(fg)
        .background(RoundedRectangle(cornerRadius: 8).fill(bg))
    }
}

struct UnpairedView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 10) {
            MascotView(pose: .mudrayapti, light: .gray, height: 80)
            Text("Commander hali ulanmagan").font(.system(size: 13, weight: .semibold))
            Text("Center'da bir martalik kod yarating va shu Mac'ni ulang.")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Button("Ulash…") { model.showPairing() }.buttonStyle(CardButton(kind: .ok))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

/// Sessiyalar loyiha bo'yicha (holat pill'lari bilan); bosilsa loyiha sessiyalari ochiladi.
struct SessionsSection: View {
    let model: AppModel
    static let maxGroups = 8
    @State private var expanded: Set<String> = []

    var body: some View {
        let groups = model.projectGroups
        SectionLabel(text: "Loyihalar bo'yicha").padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
        if groups.isEmpty {
            Text(model.state.hasSnapshot ? "Faol sessiya yo'q" : "Yuklanmoqda…")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.vertical, 4)
        }
        ForEach(groups.prefix(Self.maxGroups)) { g in
            Button {
                if expanded.contains(g.name) { expanded.remove(g.name) } else { expanded.insert(g.name) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded.contains(g.name) ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint).frame(width: 10)
                    Text(g.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    ForEach(g.counts, id: \.self) { c in
                        let k = kind(c.status)
                        let colors = Theme.status(k)
                        Pill(text: "\(c.count) \(StatusText.label(c.status))", fg: colors.fg, bg: colors.bg, pulsing: k == .working)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())
            .accessibilityLabel("\(g.name): " + g.counts.map { "\($0.count) \(StatusText.label($0.status))" }.joined(separator: ", "))
            .accessibilityHint(expanded.contains(g.name) ? "Yopish" : "Sessiyalarni ko'rsatish")
            if expanded.contains(g.name) {
                ForEach(g.sessions.prefix(8), id: \.id) { s in SessionRow(session: s) }
            }
        }
        if groups.count > Self.maxGroups {
            MenuRow(title: "Yana \(groups.count - Self.maxGroups) loyiha — dashboard'da") { model.openDashboard() }
        }
    }

    private func kind(_ s: SessionStatus) -> SessionStatusKind {
        switch s {
        case .working: return .working
        case .waiting: return .waiting
        case .awaitingApproval: return .approval
        case .done: return .done
        case .idle: return .idle
        default: return .other
        }
    }
}

struct SessionRow: View {
    let session: SessionDto

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if session.staleSince != nil {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.yellow).font(.system(size: 9))
                            .accessibilityLabel("Aloqa yo'q")
                    }
                    Text(session.name ?? String(session.claudeSessionId.prefix(8))).font(Theme.mono).lineLimit(1)
                    Text("· \(session.machineName)").font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                if let m = session.message, !m.isEmpty {
                    Text(m).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
            Spacer()
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                Text(ContractDates.parse(session.statusSince).map { LimitFormat.relative(from: $0, to: ctx.date) } ?? "")
                    .font(.system(size: 10)).foregroundStyle(Theme.faint)
            }
        }
        .padding(.leading, 26).padding(.trailing, 10).padding(.vertical, 3)
        .opacity(session.staleSince != nil ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

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
            SectionLabel(text: title)
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

/// Salomatlik (eng yomon mashina), ogohlantirishlar va navbat soni.
struct StatusStrip: View {
    let summary: DashboardSummary

    var body: some View {
        HStack(spacing: 6) {
            healthPill
            Spacer(minLength: 2)
            Pill(text: "\(summary.openAlerts) ogohlantirish", fg: summary.openAlerts > 0 ? Theme.yellow : Theme.muted,
                 bg: summary.openAlerts > 0 ? Theme.yellowBg : Theme.grayBg, dot: false)
                .help("Watchdog: uzoq kutayotgan / tokenni tez yoqayotgan / xato aylanishidagi sessiyalar")
            Pill(text: "\(summary.activeQueue) navbatda", fg: Theme.muted, bg: Theme.grayBg, dot: false)
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
    }

    @ViewBuilder
    private var healthPill: some View {
        if let w = summary.worstHealthItem {
            let (fg, bg): (Color, Color) = switch w.status {
            case .critical: (Theme.red, Theme.redBg)
            case .warn: (Theme.yellow, Theme.yellowBg)
            case .ok: (Theme.green, Theme.greenBg)
            default: (Theme.muted, Theme.grayBg)
            }
            Pill(text: w.status == .ok ? "Serverlar joyida" : "\(w.name): \(StatusText.health(w.status))", fg: fg, bg: bg)
                .help(detail(w))
                .accessibilityLabel("Server salomatligi: \(w.name) \(StatusText.health(w.status)). \(detail(w))")
        } else {
            Pill(text: "Salomatlik: —", fg: Theme.muted, bg: Theme.grayBg)
        }
    }

    private func detail(_ w: HealthSummaryItem) -> String {
        var parts: [String] = []
        if let d = w.diskMaxPct { parts.append(String(format: "disk %.0f%%%@", d, w.diskMaxMount.map { " \($0)" } ?? "")) }
        if let m = w.memPct { parts.append(String(format: "xotira %.0f%%", m)) }
        if let c = w.cpuPct { parts.append(String(format: "CPU %.0f%%", c)) }
        if w.containersBad > 0 { parts.append("\(w.containersBad) konteyner muammoli") }
        if w.openIncidents > 0 { parts.append("\(w.openIncidents) ochiq hodisa") }
        return parts.joined(separator: " · ")
    }
}

struct MenuRow: View {
    let title: String
    var shortcut: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if let shortcut { Text(shortcut).font(Theme.mono).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
    }
}

struct RowButtonStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.text)
            .background(RoundedRectangle(cornerRadius: 7).fill(hover || configuration.isPressed ? Theme.surface3 : .clear))
            .onHover { hover = $0 }
    }
}

/// Limit chizig'i; taxmin/eskirgan bo'lsa xira va shtrixli (rasmiydan farq qilsin).
struct LimitBar: View {
    let pct: Double
    let color: Color
    let estimate: Bool

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width * min(max(pct, 0), 100) / 100
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface3)
                if estimate {
                    Capsule().strokeBorder(color.opacity(0.8), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .frame(width: max(w, 4))
                } else {
                    Capsule().fill(color).frame(width: max(w, 4))
                }
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}
