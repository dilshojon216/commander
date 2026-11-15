import CommanderContracts
import MenuBarCore
import SwiftUI

/// Ruxsat so'rovi kartasi (dizayn: MacMenuBar paneli, to'q sariq fon).
/// "Ruxsat…" inline tasdiq so'raydi; reja: matn (qisqartirilgan) + "Fikr bilan rad" (masofadan tasdiq yo'q, PLAN 2.14).
struct ApprovalCardView: View {
    let approval: ApprovalDto
    let model: AppModel

    var body: some View {
        let actions = model.actions(for: approval)
        let phase = model.phase(approval.id)
        VStack(alignment: .leading, spacing: 8) {
            header
            if approval.kind == .plan {
                Text(ApprovalText.truncate(approval.plan ?? "(reja matni yo'q)", max: 600))
                    .font(.system(size: 11))
                    .lineLimit(8)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
                    .accessibilityLabel("Reja matni")
                Text("To'liq reja dashboard'da. Tasdiq faqat terminalda.")
                    .font(.system(size: 10)).foregroundStyle(Theme.muted)
            } else if approval.kind == .question {
                questionBody
            } else {
                Text(ApprovalText.summary(approval, max: 300))
                    .font(Theme.mono)
                    .lineLimit(3)
                    .truncationMode(.tail)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
                    .textSelection(.enabled)
                    .accessibilityLabel("So'rov: \(ApprovalText.summary(approval, max: 300))")
            }
            controls(actions: actions, phase: phase)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.orangeBg))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var questionBody: some View {
        let single = QuestionFlow.isSingleSelectSingleQuestion(approval)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array((approval.questions ?? []).enumerated()), id: \.offset) { _, q in
                Text(ApprovalText.truncate(q.question, max: 400))
                    .font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if !single {
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, o in
                        Text("• \(QuestionFlow.displayOptionLabel(o.label))")
                            .font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
            }
            if !single {
                Text(QuestionFlow.multiNote).font(.system(size: 10)).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(spacing: 6) {
            PulsingDot(color: Theme.orange, pulsing: true)
            Text("\(ApprovalText.project(approval)) · \(model.state.machineNames[approval.machineId] ?? approval.machineSlug)")
                .font(.system(size: 13, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let left = ApprovalText.remainingSeconds(approval, now: ctx.date) ?? 0
                Text(ApprovalText.remaining(approval, now: ctx.date) ?? "")
                    .font(Theme.mono.weight(.semibold))
                    .foregroundStyle(left < 60 ? Theme.red : Theme.text)
                    .accessibilityLabel("Qolgan vaqt \(max(0, left) / 60) daqiqa \(max(0, left) % 60) soniya")
            }
        }
    }

    @ViewBuilder
    private func controls(actions: ApprovalActions, phase: ApprovalCardPhase) -> some View {
        if let ro = actions.readOnlyReason {
            Text(ro).font(.system(size: 11)).foregroundStyle(Theme.muted)
        } else {
            switch phase {
            case .confirmingAllow:
                HStack(spacing: 6) {
                    Text("Rostdan ruxsat berasizmi?").font(.system(size: 12, weight: .medium))
                    Spacer()
                    Button("Bekor") { model.cancelPhase(approval.id) }.buttonStyle(CardButton(kind: .plain))
                    Button("Ha, ruxsat") { Task { await model.decide(approval, behavior: .allow) } }
                        .buttonStyle(CardButton(kind: .ok))
                        .keyboardShortcut(.defaultAction)
                }
            case .composingFeedback(let text):
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Claude'ga fikr (nima o'zgarsin?)", text: Binding(
                        get: { text }, set: { model.editFeedback(approval.id, String($0.prefix(ApprovalFlow.maxMessageLength))) }
                    ), axis: .vertical)
                    .lineLimit(2...5)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Rad etish izohi")
                    HStack {
                        Text("\(text.count)/\(ApprovalFlow.maxMessageLength)").font(.system(size: 10)).foregroundStyle(Theme.faint)
                        Spacer()
                        Button("Bekor") { model.cancelPhase(approval.id) }.buttonStyle(CardButton(kind: .plain))
                        Button("Fikr bilan rad") { Task { await model.decide(approval, behavior: .deny, message: text) } }
                            .buttonStyle(CardButton(kind: .no))
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            case .submitting:
                HStack { Spacer(); ProgressView().controlSize(.small); Text("Yuborilmoqda…").font(.system(size: 12)) }
            case .idle, .error:
                VStack(alignment: .trailing, spacing: 6) {
                    if case .error(let m) = phase {
                        Text(m).font(.system(size: 11)).foregroundStyle(Theme.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if approval.kind == .question {
                        ForEach(QuestionFlow.buttons(for: approval), id: \.index) { b in
                            Button {
                                Task { await model.answer(approval, optionIndex: b.index) }
                            } label: {
                                Text(b.title).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(CardButton(kind: .ok))
                            .disabled(model.state.lockdown)
                            .help(model.state.lockdown ? "Lockdown: faqat rad etish mumkin" : b.description)
                        }
                    }
                    HStack(spacing: 6) {
                        Spacer()
                        if actions.showDenyWithFeedback {
                            Button("Fikr bilan rad") { model.startFeedback(approval.id) }.buttonStyle(CardButton(kind: .plain))
                        }
                        if actions.showDeny {
                            Button("Rad") { Task { await model.decide(approval, behavior: .deny) } }
                                .buttonStyle(CardButton(kind: .no))
                        }
                        if actions.showAllow {
                            Button("Ruxsat…") { model.tapAllow(approval.id) }
                                .buttonStyle(CardButton(kind: .ok))
                                .disabled(actions.allowDisabledReason != nil)
                                .help(actions.allowDisabledReason ?? "Ruxsat berish (tasdiq so'raladi)")
                        }
                    }
                }
            }
        }
    }
}

/// Hal bo'lgan karta: natija xabari bilan xiralashib turadi.
struct FadingApprovalView: View {
    let approval: ApprovalDto
    let message: String

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.muted).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(ApprovalText.project(approval)) · \(approval.toolName)").font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text(message).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer()
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.grayBg))
        .opacity(0.75)
    }
}

struct CardButton: ButtonStyle {
    enum Kind { case ok, no, plain }
    let kind: Kind
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 10)
            .frame(height: 26)
            .foregroundStyle(fg)
            .background(RoundedRectangle(cornerRadius: 6).fill(bg))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(stroke))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
    }

    private var fg: Color { kind == .ok ? Theme.onOk : (kind == .no ? Theme.red : Theme.text) }
    private var bg: Color { kind == .ok ? Theme.green : (kind == .plain ? Theme.surface2 : .clear) }
    private var stroke: Color { kind == .ok ? .clear : (kind == .no ? Theme.red : Theme.border) }
}
