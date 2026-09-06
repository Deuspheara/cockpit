import Charts
import SwiftUI

struct PortfolioValueChart: View {
  @Environment(AppEnvironment.self) private var environment
  let dashboard: PortfolioDashboard
  @Binding var range: PortfolioRange
  let compactEmptyHistory: Bool
  @MotionPreference private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var selectedDate: Date?
  @State private var changeExplanationPresented = false
  @State private var coverageInspection: CoverageInspection?

  init(
    dashboard: PortfolioDashboard, range: Binding<PortfolioRange>, initialSelection: Date? = nil,
    compactEmptyHistory: Bool = false
  ) {
    self.dashboard = dashboard
    self.compactEmptyHistory = compactEmptyHistory
    _range = range
    _selectedDate = State(initialValue: initialSelection)
  }

  private var selected: ValuationPoint? {
    guard let date = selectedDate else { return nil }
    return dashboard.chart.min {
      abs($0.at.timeIntervalSince(date)) < abs($1.at.timeIntervalSince(date))
    }
  }

  var body: some View {
    let selected = self.selected
    let segmentCounts = Dictionary(grouping: dashboard.chart, by: { $0.segmentId ?? "complete" })
      .mapValues(\.count)
    VStack(alignment: .leading, spacing: 12) {
      Text(FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))
        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityLabel(
          (selected?.complete ?? dashboard.complete) ? "Portfolio value" : "Known value"
        )
        .accessibilityValue(
          FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))

      if !compactEmptyHistory || !dashboard.chart.isEmpty {
        ZStack(alignment: .leading) {
          Text(
            (selected?.sourceAt ?? selected?.at ?? dashboard.asOf).formatted(
              date: .abbreviated, time: .shortened)
          )
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .opacity(selected == nil ? 0 : 1)
          .accessibilityHidden(selected == nil)
          Group {
            if let change = dashboard.absoluteChange, let percent = dashboard.percentChange {
              HStack(spacing: 8) {
                AppIcon(name: change.decimal >= 0 ? .arrowUp : .arrowDown, size: 17)
                Text(
                  "\(FinanceFormat.amount(change, currency: dashboard.currency)) · \(FinanceFormat.percent(percent))"
                )
                Button {
                  changeExplanationPresented.toggle()
                } label: {
                  AppIcon(name: .info, size: 17)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("About value change")
                .accessibilityHint("Explains how deposits and withdrawals affect this value")
                .popover(isPresented: $changeExplanationPresented) {
                  Text(
                    "Value change includes deposits and withdrawals; it is not investment performance."
                  )
                  .font(.callout)
                  .padding()
                  .presentationCompactAdaptation(.popover)
                }
              }
              .font(.subheadline)
              .foregroundStyle(change.decimal >= 0 ? Color.green : Color.red)
              .accessibilityElement(children: .combine)
              .accessibilityLabel(
                "Value change for \(dashboard.range.title): \(FinanceFormat.amount(change, currency: dashboard.currency)), \(FinanceFormat.percent(percent))"
              )
            } else {
              Text("Change unavailable")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
          }
          .opacity(selected == nil ? 1 : 0)
          .allowsHitTesting(selected == nil)
          .accessibilityHidden(selected != nil)
        }
        .frame(minHeight: 28, alignment: .leading)
        .animation(AppMotion.fade(reduceMotion), value: selected != nil)
        .accessibilityIdentifier("chart-subtitle")
      }

      Group {
        if dashboard.chart.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text(
              dashboard.historyStatus == "loading"
                ? "History is loading" : "No recorded values for this period"
            )
            .font(.subheadline.weight(.medium))
          }
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: compactEmptyHistory ? .leading : .center)
        } else {
          Chart {
            ForEach(dashboard.chart) { point in
              if segmentCounts[point.segmentId ?? "complete"] == 1 {
                PointMark(
                  x: .value("Date", point.at),
                  y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
                )
                .foregroundStyle(Color.accentColor).symbolSize(24)
              }
              LineMark(
                x: .value("Date", point.at),
                y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue),
                series: .value("Coverage", point.segmentId ?? "complete")
              )
              .interpolationMethod(.monotone)
              .foregroundStyle(Color.accentColor)
              .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
              .accessibilityLabel(point.at.formatted(date: .abbreviated, time: .omitted))
              .accessibilityValue(FinanceFormat.amount(point.value, currency: dashboard.currency))
            }
            if let point = selected {
              RuleMark(x: .value("Selected date", point.at))
                .foregroundStyle(.secondary.opacity(0.4))
              PointMark(
                x: .value("Date", point.at),
                y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
              )
              .foregroundStyle(Color.accentColor)
            }
          }
          .chartYScale(domain: .automatic(includesZero: false))
          .chartYAxis(.hidden)
          .chartXAxis {
            if typeSize.isAccessibilitySize {
              AxisMarks(values: [dashboard.chart[dashboard.chart.count / 2].at]) {
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
              }
            } else {
              AxisMarks(values: .automatic(desiredCount: 3)) { AxisValueLabel() }
            }
          }
          .chartXSelection(value: $selectedDate)
          .frame(height: 200)
          .accessibilityLabel("Historical portfolio value")
        }

      }
      .frame(height: compactEmptyHistory && dashboard.chart.isEmpty ? nil : 200)
      .frame(minHeight: compactEmptyHistory && dashboard.chart.isEmpty ? 64 : nil)
      .modifier(DatasetTransition(key: "\(dashboard.scope.rawValue)-\(dashboard.range.rawValue)"))
      .accessibilityIdentifier("portfolio-chart-plot")

      ChartRangePicker(selection: $range)
      if !(selected?.complete ?? dashboard.complete)
        || dashboard.chart.contains(where: { $0.complete == false })
        || dashboard.valuationIssues?.isEmpty == false
      {
        Button {
          coverageInspection = CoverageInspection(
            issues: selected?.coverage?.missing ?? dashboard.valuationIssues ?? [],
            title: selected == nil ? "Valuation coverage" : "Coverage at selected date")
        } label: {
          Label(
            !(selected?.complete ?? dashboard.complete)
              ? "Some values unavailable"
              : "Incomplete history", systemImage: "info.circle"
          )
          .font(.caption).multilineTextAlignment(.leading).frame(minHeight: 44)
        }
        .accessibilityIdentifier("valuation-coverage")
      }
      if environment.advancedMode {
        if dashboard.historyStatus == "loading" {
          ProgressView("Recovering historical values…").font(.caption)
        } else if dashboard.historyStatus == "paused" {
          Text("History recovery paused · see account for details").font(.caption).foregroundStyle(
            .secondary)
        } else if dashboard.historyStatus == "failed" {
          Text("History recovery needs attention · open the account to retry").font(.caption)
            .foregroundStyle(.secondary)
        }

      }

    }
    .sheet(item: $coverageInspection) { inspection in
      NavigationStack {
        ValuationIssuesView(issues: inspection.issues).navigationTitle(inspection.title)
      }
    }
    .onChange(of: range) { selectedDate = nil }
    .onChange(of: dashboard.scope) { selectedDate = nil }
  }
}

struct ChartRangePicker: View {
  @Binding var selection: PortfolioRange
  @Namespace private var indicator
  @MotionPreference private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    if typeSize.isAccessibilitySize {
      ScrollViewReader { scroll in
        ScrollView(.horizontal) { buttons }
          .scrollIndicators(.hidden)
          .onAppear { scroll.scrollTo(selection, anchor: .center) }
          .onChange(of: selection) {
            withAnimation(AppMotion.selection(reduceMotion)) {
              scroll.scrollTo(selection, anchor: .center)
            }
          }
      }
    } else {
      buttons
    }
  }
  private var buttons: some View {
    HStack(spacing: 0) {
      ForEach(PortfolioRange.allCases, id: \.self) { range in
        Button {
          withAnimation(AppMotion.selection(reduceMotion)) { selection = range }
        } label: {
          Text(range.title)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, typeSize.isAccessibilitySize ? 14 : 0)
            .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .background {
              if selection == range {
                Capsule().fill(Color.accentColor.opacity(0.12))
                  .matchedGeometryEffect(id: "range", in: indicator)
              }
            }
        }
        .buttonStyle(.plain)
        .id(range)
        .accessibilityAddTraits(selection == range ? .isSelected : [])
      }
    }
  }
}

struct PortfolioScopePicker: View {
  @Binding var selection: PortfolioScope
  @Namespace private var indicator
  @MotionPreference private var reduceMotion
  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(PortfolioScope.allCases, id: \.self) { scope in
          Button {
            withAnimation(AppMotion.selection(reduceMotion)) { selection = scope }
          } label: {
            Text(scope.title)
              .font(.subheadline.weight(.medium))
              .padding(.horizontal, 15)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
              .background {
                if selection == scope {
                  Capsule().fill(Color.primary.opacity(0.07))
                    .matchedGeometryEffect(id: "scope", in: indicator)
                }
              }
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(selection == scope ? .isSelected : [])
        }
      }
    }
    .scrollIndicators(.hidden)
  }
}

private struct CoverageInspection: Identifiable {
  let id = UUID()
  let issues: [ValuationIssue]
  let title: String
}
struct ValuationIssuesView: View {
  let issues: [ValuationIssue]
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var retrying = false
  @State private var result: String?
  var body: some View {
    List {
      if environment.advancedMode {
        Text(
          "Unknown values are excluded from the known value. Chart lines break when coverage changes. Select a chart date to inspect its missing values."
        )
        .font(.callout).foregroundStyle(.secondary)
      }
      ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
        VStack(alignment: .leading, spacing: 6) {
          Text(issue.name).font(.headline)
          if environment.advancedMode, let network = issue.network {
            Text(network).font(.caption).foregroundStyle(.secondary)
          }
          if environment.advancedMode, let contract = issue.contractAddress {
            Text(contract).font(.caption2).textSelection(.enabled)
          }
          Text(environment.advancedMode ? issue.message : "This value couldn’t be updated.").font(
            .callout)
          if environment.advancedMode, let date = issue.quotedAt {
            Text("Last quote: " + date.formatted()).font(.caption)
          }
          if issue.retryable {
            Button(
              issue.code == "missing_fx"
                ? "Refresh currency conversions"
                : issue.retryAction == "history" ? "Retry historical data" : "Retry account data"
            ) {
              Task { await retry(issue) }
            }.disabled(retrying)
          }
        }
      }
      if issues.isEmpty {
        Text(
          "Current values are complete. Select an earlier chart point to inspect historical coverage."
        )
      }
      if let result { Text(result).font(.caption) }
    }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
  }
  private func retry(_ issue: ValuationIssue) async {
    guard let api = environment.api else { return }
    retrying = true
    defer { retrying = false }
    do {
      let path: String
      if issue.code == "missing_fx" {
        path = "fx/refresh"
      } else if let account = issue.accountId {
        path =
          "accounts/\(account)/" + (issue.retryAction == "history" ? "history-jobs" : "sync-runs")
      } else {
        return
      }
      let _: JSONValue = try await api.send(path, method: "POST")
      result = "Refresh requested. Values will update when it finishes."
      environment.dataRevision += 1
    } catch { result = error.localizedDescription }
  }
}
