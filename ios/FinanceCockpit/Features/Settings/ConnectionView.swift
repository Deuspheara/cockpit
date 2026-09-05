import SwiftUI

struct ConnectionView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var server = ""
  @State private var token = ""
  @State private var error: String?
  @State private var connecting = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Label("Your private portfolio", systemImage: "chart.xyaxis.line").font(.title2)
          Text(
            "Connect to your finance server with a device token. Crypto connections use public addresses only."
          ).foregroundStyle(.secondary)
        }
        Section("Server") {
          TextField("https://finance.example.com", text: $server).textContentType(.URL)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          SecureField("Device token", text: $token).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        if let message = error ?? environment.connectionError {
          Section { Text(message).foregroundStyle(.red) }
        }
        Section {
          Button {
            Task { await connect() }
          } label: {
            HStack {
              Text("Test and connect")
              Spacer()
              if connecting { ProgressView() }
            }
          }.disabled(connecting || server.isEmpty || token.isEmpty)
        } footer: {
          Text(
            "Generate a token on your server with make token. It stays in this device’s Keychain.")
        }
      }.navigationTitle("Connect")
        .onAppear { if server.isEmpty { server = environment.serverURL } }
    }
  }
  private func connect() async {
    connecting = true
    defer { connecting = false }
    do {
      try await environment.connect(server: server, token: token)
      token = ""
    } catch { self.error = error.localizedDescription }
  }
}
#Preview { ConnectionView().environment(AppEnvironment()) }
