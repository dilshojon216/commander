import SwiftUI

/// Bo'lim sarlavhasi: kichik, bosh harfli, kengaytirilgan harf oralig'i.
public struct SectionLabel: View {
    private let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.muted)
    }
}
