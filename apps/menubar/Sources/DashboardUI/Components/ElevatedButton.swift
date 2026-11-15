import SwiftUI

/// Xavfli amal tugmasi: avval egasini tasdiqlaydi (lokal Touch ID, `authorize`), faqat muvaffaqiyatda `action` bajariladi.
/// Tasdiqlash vaqtida tugma o'chiq turadi, takroriy bosish yo'q.
public struct ElevatedButton: View {
    private let title: String
    private let role: ButtonRole?
    private let authorize: @MainActor () async -> Bool
    private let action: @MainActor () -> Void
    @State private var verifying = false

    public init(
        _ title: String,
        role: ButtonRole? = nil,
        authorize: @escaping @MainActor () async -> Bool,
        action: @escaping @MainActor () -> Void
    ) {
        self.title = title
        self.role = role
        self.authorize = authorize
        self.action = action
    }

    public var body: some View {
        Button(role: role) {
            verifying = true
            Task { @MainActor in
                let allowed = await authorize()
                verifying = false
                if allowed { action() }
            }
        } label: {
            Label(verifying ? Strings.verifying : title, systemImage: "touchid")
        }
        .disabled(verifying)
    }
}
