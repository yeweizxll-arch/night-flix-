import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var pushChannel: FlutterMethodChannel?
  private var pendingPushLink: String?
  private var pushReady = false

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
