import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions) {
    if let response = connectionOptions.notificationResponse {
      (UIApplication.shared.delegate as? AppDelegate)?.recordPushLink(response.notification.request.content.userInfo)
    }
    super.scene(scene, willConnectTo: session, options: connectionOptions)
  }
}
