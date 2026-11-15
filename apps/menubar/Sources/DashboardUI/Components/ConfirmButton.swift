import SwiftUI

/// Ikki bosqichli tugma: birinchi bosish "Tasdiqlang"ga aylantiradi, ikkinchisi amalni bajaradi.
/// Tasdiqlanmasa `armedDuration` soniyadan keyin avvalgi holatga qaytadi (tasodifiy bosishdan himoya).
public struct ConfirmButton: View {
    private let title: String
    private let confirmTitle: String
    private let role: ButtonRole?
    private let armedDuration: Duration
    private let action: () -> Void
    @State private var armed = false
    @State private var disarmTask: Task<Void, Never>?

    public init(
        _ title: String,
        confirmTitle: String = Strings.confirmPrompt,
        role: ButtonRole? = nil,
        armedDuration: Duration = .seconds(4),
        action: @escaping () -> Void
    ) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.role = role
        self.armedDuration = armedDuration
        self.action = action
    }

    public var body: some View {
        Button(role: role) {
            if armed {
                disarm()
                action()
            } else {
                arm()
            }
        } label: {
            Text(armed ? confirmTitle : title)
        }
        .onDisappear { disarm() }
    }

    private func arm() {
        armed = true
        disarmTask?.cancel()
        disarmTask = Task { @MainActor in
            try? await Task.sleep(for: armedDuration)
            if !Task.isCancelled { armed = false }
        }
    }

    private func disarm() {
        disarmTask?.cancel()
        disarmTask = nil
        armed = false
    }
}
