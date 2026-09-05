import SwiftUI

struct PaperBot: Codable, Identifiable, Sendable {
  let id: UUID
  let name: String
  let enabled: Bool
  let scheduleMinutes: Int
  let allocatedPaperCapital: Amount
  let currency: String
  let lastRunAt: Date?
  let nextRunAt: Date?
  let errorMessage: String?
  let paperPnl: Amount?
}
struct PaperBotRun: Codable, Identifiable, Sendable {
  let id: UUID
  let status: String
  let scheduledFor: Date
  let paperPnl: Amount?
  let orderCount: Int
}
struct BotsView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var bots: [PaperBot] = []
  @State private var error: String?
  @State private var creating = false
  var body: some View {
    List {
      Section {
        Text("Paper only · no trading credentials").font(.subheadline).foregroundStyle(.secondary)
      }
      if bots.isEmpty {
        AppEmptyState(
          title: "Paper strategies",
          description: "Add a heartbeat strategy to verify scheduled execution and run history.",
          icon: .bot)
        Button("Add disabled heartbeat strategy") { Task { await create() } }.disabled(creating)
      }
      ForEach(bots) { bot in
        Section(bot.name) {
          Toggle(
            "Enabled",
            isOn: Binding(
              get: { bot.enabled }, set: { enabled in Task { await setEnabled(bot, enabled) } }))
          LabeledContent(
            "Paper capital",
            value: FinanceFormat.amount(bot.allocatedPaperCapital, currency: bot.currency))
          LabeledContent("Schedule", value: "Every \(bot.scheduleMinutes) minutes")
          if let pnl = bot.paperPnl {
            LabeledContent("Paper PnL", value: FinanceFormat.amount(pnl, currency: bot.currency))
          }
          if let at = bot.lastRunAt {
            LabeledContent("Last run", value: at.formatted(date: .abbreviated, time: .shortened))
          }
          if let at = bot.nextRunAt {
            LabeledContent("Next run", value: at.formatted(date: .abbreviated, time: .shortened))
          }
          if let message = bot.errorMessage { Text(message).foregroundStyle(.red) }
          NavigationLink("Run history") { BotHistoryView(bot: bot) }
          Text("The heartbeat makes no trades. It proves scheduling and records zero orders.").font(
            .caption
          ).foregroundStyle(.secondary)
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Bots").task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      bots = try await environment.api?.send("bots") ?? []
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func create() async {
    creating = true
    defer { creating = false }
    do {
      let _: PaperBot? = try await environment.api?.send(
        "bots", method: "POST",
        body: [
          "name": .string("Paper heartbeat"), "allocatedPaperCapital": .string("10000"),
          "currency": .string("EUR"), "scheduleMinutes": .number(60),
        ])
      await load()
    } catch { self.error = error.localizedDescription }
  }
  private func setEnabled(_ bot: PaperBot, _ enabled: Bool) async {
    do {
      let _: PaperBot? = try await environment.api?.send(
        "bots/\(bot.id)", method: "PATCH", body: ["enabled": .bool(enabled)])
      await load()
    } catch { self.error = error.localizedDescription }
  }
}
struct BotHistoryView: View {
  let bot: PaperBot
  @Environment(AppEnvironment.self) private var environment
  @State private var runs: [PaperBotRun] = []
  @State private var error: String?
  var body: some View {
    List {
      if runs.isEmpty {
        AppEmptyState(
          title: "No runs yet",
          description: "Enable the strategy to start scheduled heartbeats.",
          icon: .clock)
      }
      ForEach(runs) { run in
        VStack(alignment: .leading, spacing: 5) {
          Text(run.scheduledFor.formatted(date: .abbreviated, time: .shortened))
          Text("\(run.status.capitalized) · \(run.orderCount) paper orders").font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle(bot.name).task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do { runs = try await environment.api?.send("bots/\(bot.id)/runs") ?? [] } catch {
      self.error = error.localizedDescription
    }
  }
}
#Preview { NavigationStack { BotsView() }.environment(AppEnvironment()) }
