import Capacitor
import UIKit

// Capacitor's SPM integration only auto-registers plugins that ship as Swift
// packages, so the app-local AudioEngine plugin must be registered explicitly.
// The storyboard's root view controller is set to this class (see Main.storyboard).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AudioEnginePlugin())
    }
}
