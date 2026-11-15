import AppKit
import CoreImage
import DashboardUI
import MenuBarCore
import SwiftUI
import UniformTypeIdentifiers

/// "Ulash" oynasi. LSUIElement ilovada SwiftUI `Window` sahnasini delegatdan ochish noqulay, shuning uchun NSWindow.
@MainActor
final class PairingWindowController {
    private weak var model: AppModel?
    private var window: NSWindow?
    private let form = PairingForm()

    init(model: AppModel) { self.model = model }

    func show(prefill: PairingRequest?, error: String? = nil) {
        if let prefill {
            form.link = ""
            form.center = prefill.centerURL.absoluteString
            form.code = prefill.code
            form.fingerprint = prefill.fingerprint
        }
        form.error = error
        form.busy = false
        if window == nil, let model {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 560),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Commander'ni ulash"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: PairingView(model: model, form: form, close: { [weak self] in self?.close() }))
            w.center()
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    func close() { window?.orderOut(nil) }
}

@MainActor @Observable
final class PairingForm {
    var link = ""
    var center = ""
    var code = ""
    var fingerprint: String?
    var error: String?
    var busy = false
}

struct PairingView: View {
    let model: AppModel
    @Bindable var form: PairingForm
    let close: () -> Void
    @State private var copied = false

    private static let cli = "ops/mac/commander-admin.sh client pair --kind menubar --name mac-menubar --scopes read,approve"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                MascotView(pose: .kutmoqda, light: .yellow, height: 72)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Commander'ni ulash").font(.system(size: 17, weight: .semibold))
                    Text("Center (Mac) terminalida bir martalik kod yarating va havolani shu yerga qo'ying yoki bosing.")
                        .font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            if model.isPaired {
                Text("Diqqat: hozirgi ulanish yangi token bilan almashtiriladi.")
                    .font(.system(size: 12)).foregroundStyle(Theme.orange)
            }

            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("1. Kod yaratish")
                HStack(alignment: .top) {
                    Text(Self.cli).font(Theme.mono).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
                    Button(copied ? "Nusxalandi" : "Nusxa") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(Self.cli, forType: .string)
                        copied = true
                    }
                    .accessibilityLabel("Buyruqni nusxalash")
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("2. Havola yoki QR")
                TextField("commander://pair?c=…&code=…", text: $form.link)
                    .textFieldStyle(.roundedBorder).font(Theme.mono)
                    .accessibilityLabel("Ulash havolasi")
                HStack {
                    Button("Clipboard'dan qo'yish") { pasteFromClipboard() }
                    Button("QR rasmdan o'qish…") { pickQRImage() }
                    Spacer()
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("yoki qo'lda")
                TextField("https://<mac>.<tailnet>.ts.net", text: $form.center)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("Center manzili")
                TextField("XXXXX-XXXXX", text: $form.code)
                    .textFieldStyle(.roundedBorder).font(Theme.mono).accessibilityLabel("Bir martalik kod")
                if let fp = form.fingerprint {
                    Text("Barmoq izi (fp): \(fp)").font(Theme.mono).foregroundStyle(Theme.muted).textSelection(.enabled)
                }
            }

            if let e = form.error {
                Text(e).font(.system(size: 12)).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Xato: \(e)")
            }

            HStack {
                Text("Token faqat shu Mac'ning Keychain'ida saqlanadi.").font(.system(size: 11)).foregroundStyle(Theme.faint)
                Spacer()
                Button("Bekor", action: close).keyboardShortcut(.cancelAction)
                Button {
                    Task { await submit() }
                } label: {
                    if form.busy { ProgressView().controlSize(.small) } else { Text("Ulash") }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(form.busy)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func submit() async {
        form.error = nil
        switch PairingRequest.parse(link: form.link, center: form.center, code: form.code) {
        case .failure(let e):
            form.error = e.message
        case .success(let req):
            form.busy = true
            let err = await model.pair(req)
            form.busy = false
            if let err {
                form.error = err
            } else {
                form.link = ""
                form.code = ""
                close()
                model.openPanel()
            }
        }
    }

    private func pasteFromClipboard() {
        let pb = NSPasteboard.general
        if let s = pb.string(forType: .string) {
            form.link = s.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let img = NSImage(pasteboard: pb), let s = QRReader.read(img) {
            form.link = s
        } else {
            form.error = "Clipboard'da havola yoki QR rasm yo'q"
        }
    }

    private func pickQRImage() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let img = NSImage(contentsOf: url) else { return }
        if let s = QRReader.read(img) { form.link = s } else { form.error = "Rasmda QR kod topilmadi" }
    }
}

/// QR rasm -> matn (CoreImage; kamera kerak emas: terminal QR'ining skrinshoti yetarli).
enum QRReader {
    static func read(_ image: NSImage) -> String? {
        guard let tiff = image.tiffRepresentation, let ci = CIImage(data: tiff) else { return nil }
        let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let features = detector?.features(in: ci) as? [CIQRCodeFeature] ?? []
        return features.compactMap(\.messageString).first { $0.hasPrefix("commander:") } ?? features.first?.messageString
    }
}
