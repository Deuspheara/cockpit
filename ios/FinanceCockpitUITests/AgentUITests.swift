import XCTest

@MainActor final class AgentUITests: XCTestCase {
  private func open(_ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures"] + arguments
    app.launch()
    XCTAssertTrue(app.buttons["portfolio-assistant"].waitForExistence(timeout: 15))
    app.buttons["portfolio-assistant"].tap()
    XCTAssertTrue(app.buttons["Summarize my portfolio"].waitForExistence(timeout: 8))
    app.buttons["Summarize my portfolio"].tap()
    return app
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testStreamingMarkdownToolsAndScrollPosition() {
    let app = open()
    XCTAssertTrue(app.buttons["Stop response"].waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.staticTexts["Thinking…"].exists || app.staticTexts["Checking your accounts"].exists)
    let copy = app.buttons["Copy code"]
    XCTAssertTrue(copy.waitForExistence(timeout: 8))
    app.swipeDown()
    XCTAssertTrue(app.buttons["Jump to latest"].waitForExistence(timeout: 5))
    capture("Streaming markdown while reading earlier content", app)
    let latest = app.buttons["Jump to latest"]
    latest.tap()
    XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 15))
    app.swipeDown()
    app.swipeDown()
    app.swipeDown()
    capture("Completed long Markdown response", app)
  }
  func testStopRetryAndReopen() {
    let app = open()
    let stop = app.buttons["Stop response"]
    XCTAssertTrue(stop.waitForExistence(timeout: 5))
    sleep(3)
    stop.tap()
    XCTAssertTrue(app.buttons["Retry response"].waitForExistence(timeout: 5))
    capture("Interrupted response retains progress", app)
    app.buttons["Close"].tap()
    app.buttons["portfolio-assistant"].tap()
    XCTAssertTrue(app.buttons["Retry response"].waitForExistence(timeout: 5))
    app.buttons["Retry response"].tap()
    XCTAssertTrue(app.buttons["Stop response"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    sleep(10)
    app.buttons["portfolio-assistant"].tap()
    XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5))
    capture("Completed response restored after closing chat", app)
  }
  func testDarkModeAndDynamicType() {
    let app = open(["--dark", "--large-text"])
    XCTAssertTrue(app.buttons["Stop response"].waitForExistence(timeout: 5))
    sleep(4)
    capture("Chat dark mode accessibility text", app)
    app.buttons["Stop response"].tap()
    XCTAssertTrue(app.buttons["Retry response"].waitForExistence(timeout: 5))
    capture("Interrupted chat dark mode accessibility text", app)
  }
}
