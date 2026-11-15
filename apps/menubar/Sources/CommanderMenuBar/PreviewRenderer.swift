import AppKit
import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// `Commander --render-previews <chiqish papkasi> [fixtures papkasi]`: maskot pozalari, menu-bar ikonkasi, pop-up va
/// panelni (fixture ma'lumotlari bilan, qorong'i/yorug') PNG'ga chizadi. Ekranni yozib olish ruxsatisiz vizual tekshiruv uchun.
@MainActor
enum PreviewRenderer {
    static func runIfRequested() -> Bool {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--render-previews"), i + 1 < args.count else { return false }
        let out = URL(fileURLWithPath: args[i + 1])
        let fixtures = i + 2 < args.count ? URL(fileURLWithPath: args[i + 2]) : nil
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        render(out: out, fixtures: fixtures)
        return true
    }

    private static func render(out: URL, fixtures: URL?) {
        for scheme in [ColorScheme.dark, .light] {
            let tag = scheme == .dark ? "dark" : "light"
            let bg = scheme == .dark ? Color(hex: 0x1E2128) : Color(hex: 0xF4F5F7)
            save(HStack(spacing: 24) {
                ForEach(MascotPose.allCases, id: \.self) { p in
                    VStack {
                        MascotView(pose: p, light: light(p), height: 140, animated: false, showBadge: true)
                        Text(p.rawValue).foregroundStyle(Theme.text)
                    }
                }
            }.padding(24).background(bg), scheme: scheme, to: out.appendingPathComponent("mascot-\(tag).png"))

            save(HStack(spacing: 12) {
                ForEach([MascotLight.gray, .blue, .yellow, .orange, .green, .red], id: \.self) { l in
                    Image(nsImage: MascotGlyphRenderer.image(light: l, attention: l != .gray, dark: scheme == .dark))
                        .renderingMode(l == .gray ? .template : .original)
                        .foregroundStyle(Theme.text)
                }
            }.padding(8).background(bg), scheme: scheme, to: out.appendingPathComponent("glyph-\(tag).png"))

            save(MascotPopupView(spec: PopupSpec(pose: .ruxsat, light: .orange, title: "backend-services ruxsat so'rayapti",
                                                 text: "srv-01 · Bash: docker compose up -d · 4:12 qoldi", autoHide: nil, approvalId: "x"),
                                 onOpen: {}, onClose: {})
                .frame(width: 360, height: 128).background(bg), scheme: scheme, to: out.appendingPathComponent("popup-\(tag).png"))

            if let fixtures, let model = previewModel(fixtures) {
                let counters = SidebarCounters(summary: model.summary)
                let limit = SidebarLimitSummary(limits: model.state.limits, now: Date())
                save(ShellPreview(counters: counters, limit: limit).background(bg), scheme: scheme, to: out.appendingPathComponent("shell-\(tag).png"))
            }

            save(ComponentGallery().background(bg), scheme: scheme, to: out.appendingPathComponent("components-\(tag).png"))

            if let fixtures, let model = previewModel(fixtures) {
                save(PanelContainer(model: model, maxBodyHeight: 2000, onResize: {}, staticRender: true).background(bg), scheme: scheme, to: out.appendingPathComponent("panel-\(tag).png"))
            }
        }
        print("previews -> \(out.path)")
    }

    private static func light(_ p: MascotPose) -> MascotLight {
        switch p {
        case .kutmoqda: return .yellow
        case .ruxsat: return .orange
        case .tugatdi: return .green
        case .mudrayapti: return .gray
        }
    }

    private static func previewModel(_ dir: URL) -> AppModel? {
        func load<T: Decodable>(_ t: T.Type, _ n: String) -> T? {
            (try? Data(contentsOf: dir.appendingPathComponent("\(n).json"))).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
        }
        guard let sessions = load(ListSessionsResponseV1.self, "sessions") else { return nil }
        var pending: [ApprovalDto] = []
        if let raw = try? Data(contentsOf: dir.appendingPathComponent("approval.json")),
           var o = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] {
            o["status"] = "pending"
            o["behavior"] = NSNull()
            o["deadline"] = ContractDates.format(Date().addingTimeInterval(252))
            if let d = try? JSONSerialization.data(withJSONObject: o), let a = try? JSONDecoder().decode(ApprovalDto.self, from: d) { pending.append(a) }
            o["id"] = "11111111-1111-4111-8111-111111111111"
            o["kind"] = "plan"
            o["plan"] = "## Reja\n1. Migratsiya yozish\n2. Servisni yangilash\n3. Testlar"
            o["toolName"] = "ExitPlanMode"
            if let d = try? JSONSerialization.data(withJSONObject: o), let a = try? JSONDecoder().decode(ApprovalDto.self, from: d) { pending.append(a) }
        }
        let snap = DashboardSnapshot(
            sessions: sessions.items, machines: load(ListMachinesResponse.self, "machines")?.items ?? [],
            limits: load(LimitsResponse.self, "limits"), pendingApprovals: pending,
            alerts: load(ListAlertsResponse.self, "alerts")?.items ?? [], health: load(HealthSummaryResponse.self, "health-summary"),
            queue: load(ListQueueResponse.self, "queue")?.items ?? []
        )
        let model = AppModel()
        model.loadPreview(snap, scopes: ["read", "approve"])
        return model
    }

    private static func save(_ view: some View, scheme: ColorScheme, to url: URL) {
        let r = ImageRenderer(content: view.environment(\.colorScheme, scheme))
        r.scale = 2
        var image: CGImage?
        NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance { image = r.cgImage }
        guard let cg = image else { print("render failed: \(url.lastPathComponent)"); return }
        let rep = NSBitmapImageRep(cgImage: cg)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}
