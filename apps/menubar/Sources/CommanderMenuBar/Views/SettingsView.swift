import CommanderContracts
import MenuBarCore
import SwiftUI

/// Panel ichidagi sozlamalar sahifasi.
struct SettingsView: View {
    @Bindable var settings: AppSettings
    let model: AppModel
    @State private var loginOn = LoginItem.isEnabled
    @State private var message: String?
    @State private var confirmUnpair = false
    @State private var busy = false
    @State private var dashboardText = ""
    @State private var dashboardError: String?

    init(model: AppModel) {
        self.model = model
        self.settings = model.settings
    }

    private func saveDashboardURL() {
        let raw = dashboardText.isEmpty ? DashboardBaseURL.default.absoluteString : dashboardText
        guard let url = DashboardBaseURL.parse(raw) else {
            dashboardError = "Faqat http(s)://host:port ko'rinishidagi manzil"
            return
        }
        dashboardError = nil
        settings.dashboardURL = url
        dashboardText = url.absoluteString
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button { model.showSettings = false } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless).accessibilityLabel("Orqaga")
                Text("Sozlamalar").font(.system(size: 14, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 6)

            Form {
                Section("Menu bar") {
                    Picker("Matn", selection: $settings.textFormat) {
                        ForEach(MenuTextFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    Picker("Limit", selection: $settings.limitWindow) {
                        ForEach(LimitWindowChoice.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    Text("Namuna: \(model.menuText.isEmpty ? "(faqat ikonka)" : model.menuText)").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                Section("Ogohlantirishlar") {
                    Toggle("Bildirishnomalar", isOn: $settings.notificationsEnabled)
                        .onChange(of: settings.notificationsEnabled) { _, on in if on { model.notifier.requestAuthorization() } }
                    Toggle("Maskot burchakdan chiqsin", isOn: $settings.mascotPopupsEnabled)
                    HStack {
                        Text("Sinash").foregroundStyle(Theme.muted)
                        Spacer()
                        Button("Ruxsat") { model.demoPopup(.ruxsat) }
                        Button("Kutmoqda") { model.demoPopup(.kutmoqda) }
                        Button("Tugatdi") { model.demoPopup(.tugatdi) }
                    }
                    .controlSize(.small)
                }
                Section("Tizim") {
                    Toggle("Login'da ishga tushirish", isOn: $loginOn)
                        .onChange(of: loginOn) { _, on in
                            if let err = LoginItem.set(on) { message = err; loginOn = LoginItem.isEnabled }
                        }
                }
                Section("Dashboard") {
                    HStack {
                        TextField("Manzil", text: $dashboardText, prompt: Text(DashboardBaseURL.default.absoluteString))
                            .onSubmit(saveDashboardURL)
                        Button("Saqlash", action: saveDashboardURL)
                            .disabled(dashboardText == settings.dashboardURL.absoluteString)
                    }
                    if let dashboardError {
                        Text(dashboardError).font(.system(size: 11)).foregroundStyle(Theme.orange)
                    } else {
                        Text("Commander oynasi (⌘D) shu manzilni ochadi; boshqa saytlar brauzerda ochiladi.")
                            .font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
                Section("Qurilma") {
                    LabeledContent("Center", value: settings.centerURL?.host() ?? "—")
                    if let me = model.me {
                        LabeledContent("Nom", value: me.name ?? "—")
                        LabeledContent("Huquqlar", value: me.scopes.map(\.rawValue).joined(separator: ", "))
                        if let exp = me.expiresAt.flatMap(ContractDates.parse) {
                            LabeledContent("Token muddati", value: exp.formatted(date: .abbreviated, time: .omitted))
                        }
                    }
                    if !model.state.canApprove && model.isPaired {
                        Text("Bu qurilmada approve huquqi yo'q: Ruxsat tugmalari yashirilgan.").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    if model.isPaired {
                        Button("Ulanishni uzish (unpair)…", role: .destructive) { confirmUnpair = true }
                            .disabled(busy)
                    } else {
                        Button("Ulash…") { model.showPairing() }
                    }
                }
            }
            .formStyle(.grouped)
            .onAppear { dashboardText = settings.dashboardURL.absoluteString }
            .frame(height: 430)

            if let message {
                Text(message).font(.system(size: 11)).foregroundStyle(Theme.orange).padding(.horizontal, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .confirmationDialog("Bu Mac'ni Commander'dan uzasizmi?", isPresented: $confirmUnpair) {
            Button("Uzish", role: .destructive) {
                busy = true
                Task {
                    message = await model.unpair()
                    busy = false
                }
            }
            Button("Bekor", role: .cancel) {}
        } message: {
            Text("Token markazda bekor qilinadi va Keychain'dan o'chiriladi. Qayta ulash uchun yangi kod kerak.")
        }
    }
}
