import AppKit
import DashboardUI
import MenuBarCore
import SwiftUI

/// "Navbatchi" (TASKS 4.6): terminal-yuzli robot, faqat SwiftUI shakllari bilan chizilgan (tashqi asset yo'q).
/// Koordinatalar Mascot.dc.html dagi 120x140 viewBox bo'yicha; har qism (antenna, qo'l, ko'z) alohida animatsiyalanadi.
struct MascotView: View {
    let pose: MascotPose
    let light: MascotLight
    var height: CGFloat = 140
    var animated = true
    var showBadge = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let live = animated && !reduceMotion
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !live)) { ctx in
            let t = live ? ctx.date.timeIntervalSinceReferenceDate : 0
            Canvas { gc, size in
                let s = size.height / 140
                gc.scaleBy(x: s, y: s)
                MascotDrawing.draw(in: &gc, pose: pose, light: Theme.light(light), t: t, animated: live)
            }
        }
        .frame(width: height * 120 / 140, height: height)
        .overlay(alignment: .topTrailing) {
            if showBadge { badge }
        }
        .accessibilityElement()
        .accessibilityLabel(Self.accessibilityLabel(pose))
        .accessibilityAddTraits(.isImage)
    }

    private var badge: some View {
        Text(Self.badge(pose))
            .font(.system(size: height * 0.11, weight: .heavy))
            .foregroundStyle(Color(hex: 0x0B0D10))
            .frame(minWidth: height * 0.18, minHeight: height * 0.18)
            .background(Circle().fill(Theme.light(light)))
            .offset(x: 2, y: 2)
            .accessibilityHidden(true)
    }

    static func badge(_ p: MascotPose) -> String {
        switch p {
        case .kutmoqda: return "?"
        case .ruxsat: return "!"
        case .tugatdi: return "✓"
        case .mudrayapti: return "z"
        }
    }

    static func accessibilityLabel(_ p: MascotPose) -> String {
        switch p {
        case .kutmoqda: return "Navbatchi javob kutmoqda"
        case .ruxsat: return "Navbatchi ruxsat so'ramoqda"
        case .tugatdi: return "Navbatchi ish tugaganini aytmoqda"
        case .mudrayapti: return "Navbatchi mudramoqda"
        }
    }
}

/// Sof chizish (Canvas). `t` = soniyalar; animatsiya fazalari dizayndagi CSS keyframe'lariga mos.
enum MascotDrawing {
    struct Eyes {
        let x1: CGFloat, x2: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, mouthY: CGFloat, mouthH: CGFloat, color: Color
    }

    static func eyes(_ p: MascotPose) -> Eyes {
        switch p {
        case .kutmoqda: return Eyes(x1: 42, x2: 68, y: 48, w: 10, h: 14, mouthY: 68, mouthH: 3, color: Color(hex: 0x6FE3FF))
        case .ruxsat: return Eyes(x1: 40, x2: 68, y: 44, w: 12, h: 18, mouthY: 68, mouthH: 5, color: Color(hex: 0xFFB27A))
        case .tugatdi: return Eyes(x1: 42, x2: 68, y: 52, w: 10, h: 4, mouthY: 64, mouthH: 6, color: Color(hex: 0x7DF0B0))
        case .mudrayapti: return Eyes(x1: 42, x2: 68, y: 56, w: 10, h: 2, mouthY: 68, mouthH: 2, color: Color(hex: 0x5C6B8A))
        }
    }

    static func draw(in gc: inout GraphicsContext, pose: MascotPose, light: Color, t: TimeInterval, animated: Bool) {
        // Tana harakati: bob (2.4 s, -4px) yoki jump (0.7 s, -10px, alternate).
        var dy: CGFloat = 0
        if animated {
            switch pose {
            case .kutmoqda, .tugatdi: dy = -4 * CGFloat((1 - cos(t * 2 * .pi / 2.4)) / 2)
            case .ruxsat: dy = -10 * CGFloat(abs(sin(t * .pi / 1.4)))
            case .mudrayapti: dy = 0
            }
        }
        gc.translateBy(x: 0, y: dy)

        let limb = GraphicsContext.Shading.color(Theme.Mascot.limb)
        // Antenna
        var antenna = Path()
        antenna.move(to: CGPoint(x: 60, y: 24))
        antenna.addLine(to: CGPoint(x: 60, y: 10))
        gc.stroke(antenna, with: limb, style: StrokeStyle(lineWidth: 4, lineCap: .round))
        // Chiroq: miltillash (1 s, steps) kutmoqda/ruxsat pozalarida.
        let blinkOn = !(animated && (pose == .kutmoqda || pose == .ruxsat)) || Int(t * 2) % 2 == 0
        gc.fill(Path(ellipseIn: CGRect(x: 53, y: 1, width: 14, height: 14)), with: .color(light.opacity(blinkOn ? 1 : 0.25)))
        if blinkOn && pose != .mudrayapti {
            gc.fill(Path(ellipseIn: CGRect(x: 49, y: -3, width: 22, height: 22)), with: .color(light.opacity(0.18)))
        }
        // Chap qo'l
        gc.fill(Path(roundedRect: CGRect(x: 8, y: 54, width: 14, height: 22), cornerRadius: 7), with: limb)
        // O'ng qo'l: silkitish (0.9 s, -28°) — mudrayapti'dan boshqa pozalarda.
        var arm = gc
        if animated && pose != .mudrayapti {
            let angle = -28 * (1 - cos(t * 2 * .pi / 0.9)) / 2
            arm.translateBy(x: 96, y: 62)
            arm.rotate(by: .degrees(angle))
            arm.translateBy(x: -96, y: -62)
        }
        arm.fill(Path(roundedRect: CGRect(x: 98, y: 40, width: 14, height: 24), cornerRadius: 7), with: limb)
        // Tana va ekran
        gc.fill(Path(roundedRect: CGRect(x: 18, y: 24, width: 84, height: 78), cornerRadius: 24), with: .color(Theme.Mascot.body))
        gc.fill(Path(roundedRect: CGRect(x: 28, y: 36, width: 64, height: 42), cornerRadius: 13), with: .color(Theme.Mascot.screen))
        // Ko'zlar va og'iz
        let e = eyes(pose)
        gc.fill(Path(roundedRect: CGRect(x: e.x1, y: e.y, width: e.w, height: e.h), cornerRadius: min(3, e.h / 2)), with: .color(e.color))
        gc.fill(Path(roundedRect: CGRect(x: e.x2, y: e.y, width: e.w, height: e.h), cornerRadius: min(3, e.h / 2)), with: .color(e.color))
        gc.fill(Path(roundedRect: CGRect(x: 54, y: e.mouthY, width: 12, height: e.mouthH), cornerRadius: min(2, e.mouthH / 2)),
                with: .color(e.color.opacity(0.8)))
        // Yonoqlar
        gc.fill(Path(ellipseIn: CGRect(x: 30, y: 82, width: 8, height: 8)), with: .color(Theme.Mascot.cheek.opacity(0.5)))
        gc.fill(Path(ellipseIn: CGRect(x: 82, y: 82, width: 8, height: 8)), with: .color(Theme.Mascot.cheek.opacity(0.5)))
        // Oyoqlar
        gc.fill(Path(roundedRect: CGRect(x: 34, y: 100, width: 18, height: 12), cornerRadius: 6), with: limb)
        gc.fill(Path(roundedRect: CGRect(x: 68, y: 100, width: 18, height: 12), cornerRadius: 6), with: limb)
        // Mudrayapti: "z" suzib chiqadi (2.4 s).
        if pose == .mudrayapti && animated {
            let phase = CGFloat(t.truncatingRemainder(dividingBy: 2.4) / 2.4)
            let opacity = phase < 0.5 ? phase * 2 : (1 - phase) * 2
            gc.draw(Text("z").font(.system(size: 16, weight: .bold)).foregroundColor(Color(hex: 0x9AA3B0).opacity(opacity)),
                    at: CGPoint(x: 100 + 8 * phase, y: 26 - 14 * phase))
        }
    }

    /// Menu-bar uchun soddalashtirilgan bosh (MacMenuBar.dc.html: 120x120 viewBox).
    /// Ekran "teshik" (destinationOut) — template rejimida tizim rangiga moslashadi.
    static func drawGlyph(in gc: inout GraphicsContext, ink: Color, light: Color?) {
        var antenna = Path()
        antenna.move(to: CGPoint(x: 60, y: 22))
        antenna.addLine(to: CGPoint(x: 60, y: 10))
        gc.stroke(antenna, with: .color(ink), style: StrokeStyle(lineWidth: 10, lineCap: .round))
        gc.fill(Path(ellipseIn: CGRect(x: 49, y: -1, width: 22, height: 22)), with: .color(light ?? ink))
        gc.fill(Path(roundedRect: CGRect(x: 14, y: 26, width: 92, height: 80), cornerRadius: 26), with: .color(ink))
        var cut = gc
        cut.blendMode = .destinationOut
        cut.fill(Path(roundedRect: CGRect(x: 28, y: 40, width: 64, height: 44), cornerRadius: 12), with: .color(.black))
        gc.fill(Path(roundedRect: CGRect(x: 42, y: 52, width: 10, height: 16), cornerRadius: 3), with: .color(ink))
        gc.fill(Path(roundedRect: CGRect(x: 68, y: 52, width: 10, height: 16), cornerRadius: 3), with: .color(ink))
    }
}

/// Menu-bar ikonkasi uchun NSImage (ImageRenderer). Diqqat kerak bo'lmasa template (tizim rangi).
@MainActor
enum MascotGlyphRenderer {
    static func image(light: MascotLight, attention: Bool, dark: Bool) -> NSImage {
        let template = !attention && (light == .gray)
        let ink: Color = template ? .black : (dark ? .white : .black)
        let lightColor: Color? = template ? nil : Theme.light(light)
        let view = Canvas { gc, size in
            let s = size.width / 120
            gc.scaleBy(x: s, y: s)
            gc.translateBy(x: 0, y: 4)
            MascotDrawing.drawGlyph(in: &gc, ink: ink, light: lightColor)
        }
        .frame(width: 18, height: 18)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let img = renderer.nsImage ?? NSImage(size: NSSize(width: 18, height: 18))
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = template
        return img
    }
}
