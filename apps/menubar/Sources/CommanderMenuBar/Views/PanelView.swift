import CommanderContracts
import MenuBarCore
import SwiftUI

/// Panel tanasi (aylanadigan qism): umumiy ko'rsatkichlar, ruxsat so'rovlari, limitlar, sessiyalar, mashinalar.
struct PanelBody: View {
    let model: AppModel
    static let maxApprovals = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.loadingToken {
                Banner(text: "Keychain ruxsati kutilmoqda: ochilgan oynada Mac parolini kiritib \"Doim ruxsat berish\"ni bosing", fg: Theme.yellow, bg: Theme.yellowBg, icon: "key.fill")
            } else if !model.isPaired {
                UnpairedView(model: model)
            } else {
                ConnectionBanner(model: model)
                if model.state.lockdown {
                    Banner(text: "Lockdown yoqiq: masofadan faqat rad etish mumkin", fg: Theme.red, bg: Theme.redBg, icon: "lock.fill")
                }
                StatTiles(summary: model.summary)
                approvals
                PanelCard(title: "Limitlar", icon: "gauge.with.dots.needle.67percent") {
                    LimitsCard(limits: model.state.limits)
                }
                SessionsCard(model: model)
                MachinesCard(model: model)
                if model.summary.openAlerts > 0 || model.summary.activeQueue > 0 { StatusStrip(summary: model.summary) }
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private var approvals: some View {
        let list = model.sortedApprovals
        if !list.isEmpty || !model.fading.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                CardTitle(title: "Ruxsat so'rovlari", icon: "hand.raised.fill", tint: Theme.orange, count: list.count)
                ForEach(list.prefix(Self.maxApprovals), id: \.id) { a in ApprovalCardView(approval: a, model: model) }
                if list.count > Self.maxApprovals {
                    MenuRow(title: "Yana \(list.count - Self.maxApprovals) ta so'rov — dashboard'da") { model.openDashboard() }
                }
                ForEach(Array(model.fading.keys.sorted()), id: \.self) { id in
                    if let f = model.fading[id] { FadingApprovalView(approval: f.approval, message: f.message) }
                }
            }
        }
    }
}

struct PanelHeader: View {
    let model: AppModel
    let summary: DashboardSummary

    var body: some View {
        let mood = model.mood
        HStack(spacing: 10) {
            MascotView(pose: mood.pose, light: mood.light, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("Commander").font(.system(size: 15, weight: .bold))
                Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            connectionPill
            Button { model.showSettings = true } label: {
                Image(systemName: "gearshape").font(.system(size: 13, weight: .medium)).frame(width: 26, height: 26)
            }
            .buttonStyle(IconButtonStyle())
            .help("Sozlamalar (⌘,)")
            .keyboardShortcut(",", modifiers: .command)
            .accessibilityLabel("Sozlamalar")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var subtitle: String {
        if !model.isPaired { return "Ulanmagan" }
        if summary.approvals > 0 { return "\(summary.approvals) ta so'rov javob kutmoqda" }
        if summary.waiting > 0 { return "\(summary.waiting) ta sessiya sizni kutmoqda" }
        if summary.working > 0 { return "\(summary.working) ta sessiya ishlayapti" }
        return "Hammasi tinch"
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

/// Pastki qator: asosiy amallar ikonka-tugma ko'rinishida.
struct PanelFooter: View {
    let model: AppModel

    var body: some View {
        HStack(spacing: 4) {
            FooterButton(title: "Dashboard", icon: "rectangle.3.group", shortcut: "d") { model.openDashboard() }
            FooterButton(title: "Brauzerda", icon: "safari") { model.openDashboardInBrowser() }
            Spacer()
            FooterButton(title: "Chiqish", icon: "power", shortcut: "q") { NSApp.terminate(nil) }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }
}

struct FooterButton: View {
    let title: String
    let icon: String
    var shortcut: Character?
    let action: () -> Void

    var body: some View {
        let b = Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11, weight: .medium))
                Text(title).font(.system(size: 12, weight: .medium))
                if let shortcut { Text("⌘\(String(shortcut).uppercased())").font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint) }
            }
            .padding(.horizontal, 9).frame(height: 26)
        }
        .buttonStyle(IconButtonStyle())
        if let shortcut { b.keyboardShortcut(KeyEquivalent(shortcut), modifiers: .command) } else { b }
    }
}

struct IconButtonStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.text)
            .background(RoundedRectangle(cornerRadius: 7).fill(configuration.isPressed ? Theme.surface3 : hover ? Theme.surface2 : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 7))
            .onHover { hover = $0 }
    }
}

/// Bo'lim kartasi: sarlavha + yengil fon.
struct PanelCard<Content: View>: View {
    let title: String
    let icon: String
    var tint: Color = Theme.muted
    var trailing: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                CardTitle(title: title, icon: icon, tint: tint)
                Spacer()
                if let trailing { Text(trailing).font(.system(size: 11)).foregroundStyle(Theme.faint) }
            }
            content()
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
    }
}

struct CardTitle: View {
    let title: String
    let icon: String
    var tint: Color = Theme.muted
    var count: Int?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint).accessibilityHidden(true)
            SectionLabel(text: title)
            if let count, count > 0 {
                Text("\(count)").font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
                    .padding(.horizontal, 5).background(Capsule().fill(tint.opacity(0.16)))
            }
        }
    }
}

/// Bir qarashda: nechta sessiya ishlayapti / kutmoqda / tugadi va mashinalar.
struct StatTiles: View {
    let summary: DashboardSummary

    var body: some View {
        HStack(spacing: 8) {
            tile("\(summary.working)", "Ishlayapti", "bolt.fill", Theme.blue, Theme.blueBg)
            tile("\(summary.waiting + summary.approvals)", "Kutmoqda", "hourglass", Theme.yellow, Theme.yellowBg,
                 highlight: summary.waiting + summary.approvals > 0)
            tile("\(summary.done)", "Tugadi", "checkmark.circle.fill", Theme.green, Theme.greenBg)
            tile("\(summary.onlineMachines)/\(summary.totalMachines)", "Mashina", "desktopcomputer",
                 summary.onlineMachines < summary.totalMachines ? Theme.orange : Theme.muted, Theme.grayBg)
        }
    }

    private func tile(_ value: String, _ label: String, _ icon: String, _ fg: Color, _ bg: Color, highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(fg)
            Text(value).font(.system(size: 20, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(Theme.text)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(highlight ? bg : Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(highlight ? fg.opacity(0.35) : Theme.border.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
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

/// Sessiyalar loyiha bo'yicha. Faol (ishlayotgan/kutayotgan) loyihalar ochiq turadi; bosilsa yig'iladi/ochiladi.
struct SessionsCard: View {
    let model: AppModel
    static let maxGroups = 8
    static let maxSessionsPerGroup = 6
    @State private var toggled: Set<String> = []

    var body: some View {
        let groups = model.projectGroups
        let total = groups.reduce(0) { $0 + $1.sessions.count }
        PanelCard(title: "Sessiyalar", icon: "terminal", trailing: total > 0 ? "\(total) ta · \(groups.count) loyiha" : nil) {
            if groups.isEmpty {
                Text(model.state.hasSnapshot ? "Faol sessiya yo'q" : "Yuklanmoqda…")
                    .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.vertical, 2)
            }
            VStack(spacing: 2) {
                ForEach(groups.prefix(Self.maxGroups)) { g in
                    let open = isOpen(g)
                    Button {
                        if toggled.contains(g.name) { toggled.remove(g.name) } else { toggled.insert(g.name) }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint).frame(width: 10)
                                .rotationEffect(.degrees(open ? 90 : 0))
                            Image(systemName: "folder.fill").font(.system(size: 11)).foregroundStyle(Theme.blue.opacity(0.8))
                            Text(g.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            Spacer(minLength: 4)
                            ForEach(g.counts, id: \.self) { c in
                                let k = StatusKind.of(c.status)
                                let colors = Theme.status(k)
                                Pill(text: "\(c.count) \(StatusText.label(c.status))", fg: colors.fg, bg: colors.bg, pulsing: k == .working)
                            }
                        }
                        .padding(.horizontal, 6).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityLabel("\(g.name): " + g.counts.map { "\($0.count) \(StatusText.label($0.status))" }.joined(separator: ", "))
                    .accessibilityHint(open ? "Yopish" : "Sessiyalarni ko'rsatish")
                    if open {
                        VStack(spacing: 0) {
                            ForEach(g.sessions.prefix(Self.maxSessionsPerGroup), id: \.id) { s in SessionRow(session: s) }
                        }
                        .padding(.bottom, 4)
                    }
                }
            }
            if groups.count > Self.maxGroups {
                MenuRow(title: "Yana \(groups.count - Self.maxGroups) loyiha — dashboard'da") { model.openDashboard() }
            }
        }
    }

    /// Sukut: ishlayotgan/kutayotgan sessiyasi bor loyiha ochiq. Foydalanuvchi bosgani buni teskari qiladi.
    private func isOpen(_ g: ProjectGroup) -> Bool {
        let active = g.sessions.contains { [.working, .waiting, .awaitingApproval].contains($0.status) }
        return active != toggled.contains(g.name)
    }
}

enum StatusKind {
    static func of(_ s: SessionStatus) -> SessionStatusKind {
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

/// Mashinalar: onlayn holati, sessiyalar soni va resurslar (CPU / xotira / disk).
struct MachinesCard: View {
    let model: AppModel

    var body: some View {
        let machines = model.state.machines.values.sorted {
            $0.online != $1.online ? $0.online : name($0).localizedCaseInsensitiveCompare(name($1)) == .orderedAscending
        }
        if !machines.isEmpty {
            PanelCard(title: "Mashinalar", icon: "server.rack", trailing: "\(machines.filter(\.online).count)/\(machines.count) onlayn") {
                VStack(spacing: 6) {
                    ForEach(machines, id: \.id) { m in MachineRow(machine: m, health: model.state.health[m.id], name: name(m)) }
                }
            }
        }
    }

    private func name(_ m: MachineDto) -> String { m.displayName ?? m.hostname ?? m.slug }
}

struct MachineRow: View {
    let machine: MachineDto
    let health: HealthSummaryItem?
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                PulsingDot(color: machine.online ? healthColor : Theme.faint)
                Image(systemName: osIcon).font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 14)
                Text(name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if machine.online {
                    let c = machine.sessions
                    if c.working > 0 { Pill(text: "\(c.working) ishda", fg: Theme.blue, bg: Theme.blueBg, dot: false) }
                    if c.waiting + c.awaitingApproval > 0 { Pill(text: "\(c.waiting + c.awaitingApproval) kutmoqda", fg: Theme.yellow, bg: Theme.yellowBg, dot: false) }
                    if c.working == 0 && c.waiting + c.awaitingApproval == 0 { Text("\(c.open) sessiya").font(.system(size: 11)).foregroundStyle(Theme.faint) }
                } else {
                    Text(offlineText).font(.system(size: 11)).foregroundStyle(Theme.faint)
                }
            }
            if machine.online, let h = health, h.cpuPct != nil || h.memPct != nil || h.diskMaxPct != nil {
                HStack(spacing: 10) {
                    Meter(label: "CPU", pct: h.cpuPct)
                    Meter(label: "RAM", pct: h.memPct)
                    Meter(label: "Disk", pct: h.diskMaxPct)
                }
                .padding(.leading, 33)
            }
        }
        .padding(.vertical, 2)
        .opacity(machine.online ? 1 : 0.6)
        .help(helpText)
        .accessibilityElement(children: .combine)
    }

    private var healthColor: Color {
        switch health?.status {
        case .critical: return Theme.red
        case .warn: return Theme.yellow
        default: return Theme.green
        }
    }

    private var osIcon: String {
        let os = (machine.os ?? "").lowercased()
        if os.contains("darwin") || os.contains("mac") { return "laptopcomputer" }
        if os.contains("win") { return "pc" }
        return "server.rack"
    }

    private var offlineText: String {
        guard let s = machine.lastSeenAt, let d = ContractDates.parse(s) else { return "oflayn" }
        return "oflayn · \(LimitFormat.relative(from: d, to: Date()))"
    }

    private var helpText: String {
        var parts: [String] = []
        if let h = health {
            parts.append("Holat: \(StatusText.health(h.status))")
            if let m = h.diskMaxMount { parts.append("eng to'la disk: \(m)") }
            if h.containersBad > 0 { parts.append("\(h.containersBad)/\(h.containersTotal) konteyner muammoli") }
            if h.failedUnits > 0 { parts.append("\(h.failedUnits) systemd xizmati xato") }
            if h.openIncidents > 0 { parts.append("\(h.openIncidents) ochiq hodisa") }
        }
        if let v = machine.claudeVersion { parts.append("Claude \(v)") }
        return parts.joined(separator: " · ")
    }
}

/// Kichik resurs o'lchagichi: yorliq + foiz + chiziq (70%+ sariq, 90%+ qizil).
struct Meter: View {
    let label: String
    let pct: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 3) {
                Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
                Spacer(minLength: 0)
                Text(pct.map { "\(Int($0.rounded()))%" } ?? "—").font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundStyle(pct == nil ? Theme.faint : color)
            }
            LimitBar(pct: pct ?? 0, color: color, estimate: false).frame(height: 4)
        }
        .frame(maxWidth: .infinity)
    }

    private var color: Color {
        guard let pct else { return Theme.faint }
        return pct >= 90 ? Theme.red : pct >= 70 ? Theme.yellow : Theme.green
    }
}

struct SessionRow: View {
    let session: SessionDto

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            let k = StatusKind.of(session.status)
            PulsingDot(color: Theme.status(k).fg, pulsing: k == .working).padding(.top, 4)
                .help(StatusText.label(session.status))
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
        .padding(.leading, 24).padding(.trailing, 6).padding(.vertical, 3)
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
