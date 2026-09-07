import Flutter
import UIKit
import UserNotifications
import Vision

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var pushChannel: FlutterMethodChannel?
  private var pendingPushLink: String?
  private var pushReady = false
  private var recognitionChannel: FlutterMethodChannel?
  private var settingsChannel: FlutterMethodChannel?

  func recordPushLink(_ payload: [AnyHashable: Any]) {
    guard let link = payload["deepLink"] as? String, link.count < 2048 else { return }
    if pushReady { pushChannel?.invokeMethod("open", arguments: link) }
    else { pendingPushLink = link }
  }

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] { recordPushLink(payload) }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func userNotificationCenter(_ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    recordPushLink(response.notification.request.content.userInfo)
    // This application uses direct APNs on iOS. Complete once; do not forward
    // back into Firebase's delegate proxy (which already forwarded to us).
    completionHandler()
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NightFlixSettings") {
      let channel = FlutterMethodChannel(name: "nightflix/settings", binaryMessenger: registrar.messenger())
      settingsChannel = channel
      channel.setMethodCallHandler { call, result in
        switch call.method {
        case "appInfo":
          result(["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                  "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                  "package": Bundle.main.bundleIdentifier ?? ""])
        case "notificationsAllowed":
          UNUserNotificationCenter.current().getNotificationSettings { settings in
            let allowed = [UNAuthorizationStatus.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
            DispatchQueue.main.async { result(allowed) }
          }
        case "openAppSettings":
          guard let url = URL(string: UIApplication.openSettingsURLString) else { result(false); return }
          UIApplication.shared.open(url, options: [:]) { opened in result(opened) }
        default: result(FlutterMethodNotImplemented)
        }
      }
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NightFlixTextRecognition") {
      let channel = FlutterMethodChannel(name: "nightflix/text-recognition", binaryMessenger: registrar.messenger())
      recognitionChannel = channel
      channel.setMethodCallHandler { call, result in
        guard call.method == "recognize" else { result(FlutterMethodNotImplemented); return }
        guard let args = call.arguments as? [String: Any], let path = args["path"] as? String else {
          result(FlutterError(code: "INVALID_IMAGE", message: "Invalid image", details: nil)); return
        }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let roots = [NSTemporaryDirectory()] + FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).map { $0.path + "/" }
        guard roots.contains(where: { url.path.hasPrefix($0) }) else {
          result(FlutterError(code: "INVALID_IMAGE", message: "Invalid image", details: nil)); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let supported = try request.supportedRecognitionLanguages()
            let preferred = [args["locale"] as? String ?? "en-US", "zh-Hans", "en-US"].filter { supported.contains($0) }
            if !preferred.isEmpty {
              request.recognitionLanguages = preferred.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            }
            try VNImageRequestHandler(url: url).perform([request])
            let lines = (request.results ?? []).prefix(100).compactMap { $0.topCandidates(1).first?.string }
            DispatchQueue.main.async { result(lines) }
          } catch {
            DispatchQueue.main.async { result(FlutterError(code: "RECOGNITION_FAILED", message: "Could not read image text", details: nil)) }
          }
        }
      }
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NightFlixApnsLinks") {
      let channel = FlutterMethodChannel(name: "nightflix/apns-links", binaryMessenger: registrar.messenger())
      pushChannel = channel
      channel.setMethodCallHandler { [weak self] call, result in
        guard call.method == "initial" else { result(FlutterMethodNotImplemented); return }
        self?.pushReady = true
        result(self?.pendingPushLink)
        self?.pendingPushLink = nil
      }
    }
  }
}
