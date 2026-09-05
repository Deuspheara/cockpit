import SwiftUI
import Textual
import UIKit

struct AgentMarkdown: View {
  let content: String
  var body: some View {
    StructuredText(content, parser: ChatMarkdownParser())
      .textual.textSelection(.enabled)
      .textual.codeBlockStyle(ChatCodeStyle())
      .textual.tableStyle(ChatTableStyle())
      .textual.imageAttachmentLoader(DisabledImageLoader())
      .textual.structuredTextStyle(.gitHub)
      .font(.body)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .environment(
        \.openURL,
        OpenURLAction { url in
          guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
            return .discarded
          }
          return .systemAction
        }
      )
      .contextMenu {
        Button("Copy response", systemImage: "doc.on.doc") { UIPasteboard.general.string = content }
      }
  }
}
struct AgentToolActivity: View {
  let steps: [AgentToolStep]
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(steps) { step in
          HStack(alignment: .top, spacing: 9) {
            if step.status == "running" {
              ProgressView().controlSize(.small)
            } else {
              Image(systemName: icon(step.status)).foregroundStyle(
                step.status == "failed" ? Color.red : Color.secondary)
            }
            VStack(alignment: .leading, spacing: 3) {
              Text(step.label).font(.callout)
              if let summary = step.summary {
                Text(summary).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel("\(step.label), \(step.status). \(step.summary ?? "")")
        }
      }.padding(.top, 8)
    } label: {
      Text(steps.last(where: { $0.status == "running" })?.label ?? "\(steps.count) activity steps")
        .font(.callout).foregroundStyle(.secondary)
    }
    .padding(12)
    .background(Color.primary.opacity(0.04), in: .rect(cornerRadius: 14))
  }
  private func icon(_ status: String) -> String {
    switch status {
    case "completed": "checkmark.circle"
    case "failed": "exclamationmark.circle"
    case "cancelled": "stop.circle"
    default: "circle.dotted"
    }
  }
}

private struct ChatCodeStyle: StructuredText.CodeBlockStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(configuration.languageHint ?? "Code").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Copy code", systemImage: "doc.on.doc") {
          configuration.codeBlock.copyToPasteboard()
        }
        .font(.caption).buttonStyle(.borderless)
      }.padding(12)
      Divider()
      ScrollView(.horizontal) {
        configuration.label.monospaced().padding(12).fixedSize(horizontal: true, vertical: false)
      }
    }
    .background(Color.primary.opacity(0.045), in: .rect(cornerRadius: 12))
    .textual.blockSpacing(.init(top: 0, bottom: 16))
  }
}
private struct ChatTableStyle: StructuredText.TableStyle {
  func makeBody(configuration: Configuration) -> some View {
    ScrollView(.horizontal) {
      configuration.label.fixedSize(horizontal: true, vertical: false).padding(1)
    }
    .textual.blockSpacing(.init(top: 0, bottom: 16))
  }
}
private struct DisabledImageLoader: AttachmentLoader {
  func attachment(for url: URL, text: String, environment: ColorEnvironmentValues) async throws
    -> PlaceholderAttachment
  {
    PlaceholderAttachment(description: text.isEmpty ? "Image" : text)
  }
}
private struct PlaceholderAttachment: Attachment {
  let description: String
  var body: some View {
    Image(systemName: "photo").foregroundStyle(.secondary).accessibilityLabel(description)
  }
  func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
    CGSize(width: 20, height: 20)
  }
}

// Preserve readable text even when the newest streaming suffix is not valid Markdown yet.
private struct ChatMarkdownParser: MarkupParser {
  func attributedString(for input: String) throws -> AttributedString {
    let parser = AttributedStringMarkdownParser(
      baseURL: nil,
      options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
    return (try? parser.attributedString(for: input)) ?? AttributedString(input)
  }
}
