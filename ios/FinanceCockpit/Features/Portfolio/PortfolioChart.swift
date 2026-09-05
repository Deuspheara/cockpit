import Charts
import SwiftUI

struct PortfolioValueChart: View {
  let dashboard: PortfolioDashboard
  @Binding var range: PortfolioRange
  @State private var selectedDate: Date?
  private var selected: ValuationPoint? {
    guard let date = selectedDate else { return nil }
    return dashboard.chart.min {
      abs($0.at.timeIntervalSince(date)) < abs($1.at.timeIntervalSince(date))
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))
        .font(.system(.largeTitle, design: .rounded, weight: .semibold)).monospacedDigit()
        .minimumScaleFactor(0.7)
        .accessibilityLabel(dashboard.complete ? "Portfolio value" : "Known subtotal")
        .accessibilityValue(
          FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))
      if let selected {
        Text((selected.sourceAt ?? selected.at).formatted(date: .abbreviated, time: .shortened))
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else if let change = dashboard.absoluteChange, let percent = dashboard.percentChange {
        Label(
          "\(FinanceFormat.amount(change, currency: dashboard.currency)) · \(FinanceFormat.percent(percent))",
          systemImage: change.decimal >= 0 ? "arrow.up.right" : "arrow.down.right"
        )
        .font(.subheadline).foregroundStyle(change.decimal >= 0 ? Color.green : Color.red)
        .accessibilityLabel(
          "Value change for \(range.title): \(FinanceFormat.amount(change, currency: dashboard.currency)), \(FinanceFormat.percent(percent))"
        )
      } else {
        Text("Period change unavailable").font(.subheadline).foregroundStyle(.secondary)
      }
      if !dashboard.complete {
        Label(
          "Known subtotal · some prices or currency conversions are missing",
          systemImage: "exclamationmark.circle"
        ).font(.caption).foregroundStyle(.orange)
      }
      if dashboard.chart.isEmpty {
        ContentUnavailableView(
          "History starts here", systemImage: "chart.xyaxis.line",
          description: Text("Valuations are recorded periodically as data becomes available.")
        ).frame(minHeight: 190)
      } else {
        Chart {
          ForEach(dashboard.chart) { point in
            if dashboard.chart.count == 1 {
              PointMark(
                x: .value("Date", point.at),
                y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
              )
              .foregroundStyle(Color.accentColor).symbolSize(45)
            }
            LineMark(
              x: .value("Date", point.at),
              y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
            )
            .interpolationMethod(.monotone)
            .foregroundStyle(Color.accentColor).lineStyle(StrokeStyle(lineWidth: 2))
            .accessibilityLabel(point.at.formatted(date: .abbreviated, time: .omitted))
            .accessibilityValue(FinanceFormat.amount(point.value, currency: dashboard.currency))
          }
          if let point = selected {
            RuleMark(x: .value("Selected date", point.at)).foregroundStyle(.secondary.opacity(0.4))
            PointMark(
              x: .value("Date", point.at),
              y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
            ).foregroundStyle(Color.accentColor)
          }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis(.hidden)
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 3)) }
        .chartXSelection(value: $selectedDate)
        .frame(height: 200)
        .accessibilityLabel("Historical portfolio value")
      }
      if let first = dashboard.chart.first {
        Text(
          dashboard.chart.count == 1
            ? "First valuation recorded. The trend will appear as new valuations arrive."
            : "Recorded history from " + first.at.formatted(date: .abbreviated, time: .shortened)
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      ChartRangePicker(selection: $range)
      Text("Change in value includes deposits and withdrawals.").font(.caption2).foregroundStyle(
        .secondary)
    }.onChange(of: dashboard.range) { selectedDate = nil }
  }
}
struct ChartRangePicker: View {
  @Binding var selection: PortfolioRange
  var body: some View {
    HStack(spacing: 0) {
      ForEach(PortfolioRange.allCases, id: \.self) { range in
        Button {
          selection = range
        } label: {
          Text(range.title).font(.caption.weight(.semibold)).frame(
            maxWidth: .infinity, minHeight: 44
          )
          .background(selection == range ? Color.accentColor.opacity(0.12) : .clear, in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(selection == range ? .isSelected : [])
      }
    }
  }
}
struct PortfolioScopePicker: View {
  @Binding var selection: PortfolioScope
  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(PortfolioScope.allCases, id: \.self) { scope in
          Button {
            selection = scope
          } label: {
            Text(scope.title).font(.subheadline.weight(selection == scope ? .semibold : .regular))
              .padding(.horizontal, 15).frame(minHeight: 44)
              .background(selection == scope ? Color.primary.opacity(0.07) : .clear, in: Capsule())
          }.buttonStyle(.plain).accessibilityAddTraits(selection == scope ? .isSelected : [])
        }
      }
    }.scrollIndicators(.hidden)
  }
}
