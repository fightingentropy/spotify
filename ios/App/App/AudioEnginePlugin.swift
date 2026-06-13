import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

// Native AVFoundation playback engine. The JS player (PlayerBar.tsx) keeps all
// orchestration (queue, scrobble, podcast resume, *when* to crossfade); this
// plugin owns audio output so it survives a locked screen — two AVPlayer "decks"
// (A/B) for crossfade, the AVAudioSession, the equal-power crossfade ramp, and
// the lock-screen Now Playing info + remote commands. See docs/native-audio-engine.md.
@objc(AudioEnginePlugin)
public class AudioEnginePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioEnginePlugin"
    public let jsName = "AudioEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "crossfade", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveDeck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseDeck", returnType: CAPPluginReturnPromise),
    ]

    private final class Deck {
        let id: String
        let player = AVPlayer()
        var item: AVPlayerItem?
        var songId: String?
        var desiredRate: Float = 1.0
        var wantsPlaying = false
        var volume: Float = 1.0
        var startAt: Double = 0
        var timeObserver: Any?
        var statusObs: NSKeyValueObservation?
        var rateObs: NSKeyValueObservation?
        var endObserver: NSObjectProtocol?
        var lastDuration: Double = 0

        init(id: String) {
            self.id = id
            player.volume = 1.0
            player.automaticallyWaitsToMinimizeStalling = true
        }
    }

    private var decks: [String: Deck] = [:]
    private var activeDeck = "A"
    private var configured = false
    private var rampTimer: DispatchSourceTimer?

    // MARK: - Lifecycle

    // Capacitor calls load() on the main thread during bridge setup, before any JS
    // method runs — so the decks exist before the player's adapters call prepare().
    override public func load() {
        ensureConfigured()
    }

    @objc func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.ensureConfigured()
            call.resolve()
        }
    }

    private func ensureConfigured() {
        if configured { return }
        let a = Deck(id: "A")
        let b = Deck(id: "B")
        decks["A"] = a
        decks["B"] = b
        setupDeckObservers(a)
        setupDeckObservers(b)
        configureSession()
        setupRemoteCommands()
        setupInterruptionObserver()
        configured = true
    }

    // Public: just put the shared AVAudioSession into .playback + active. Used by
    // the M1a path where audio still plays from the WebView <audio> element — this
    // keeps that audio alive when the screen locks (combined with UIBackgroundModes).
    @objc func activateSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.configureSession()
            call.resolve()
        }
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("[AudioEngine] session activation failed: \(error)")
        }
    }

    private func setupDeckObservers(_ deck: Deck) {
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        deck.timeObserver = deck.player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self, weak deck] _ in
            self?.emitTime(deck)
        }
        deck.rateObs = deck.player.observe(\.timeControlStatus, options: [.new]) { [weak self, weak deck] player, _ in
            guard let self = self, let deck = deck else { return }
            switch player.timeControlStatus {
            case .playing:
                self.notifyListeners("playing", data: ["deck": deck.id])
            case .waitingToPlayAtSpecifiedRate:
                self.notifyListeners("waiting", data: ["deck": deck.id])
            default:
                break
            }
        }
    }

    // MARK: - Load / transport

    @objc func prepare(_ call: CAPPluginCall) {
        guard let deckId = call.getString("deck"), let deck = decks[deckId] else {
            call.reject("deck not configured")
            return
        }
        guard let urlString = call.getString("url") else {
            call.reject("missing url")
            return
        }
        let songId = call.getString("id")
        let startAt = call.getDouble("startAt") ?? 0
        let url: URL
        if urlString.hasPrefix("/") {
            url = URL(fileURLWithPath: urlString)
        } else if let parsed = URL(string: urlString) {
            url = parsed
        } else {
            call.reject("bad url")
            return
        }

        DispatchQueue.main.async {
            self.cancelRamp()
            deck.statusObs?.invalidate()
            deck.statusObs = nil
            if let obs = deck.endObserver {
                NotificationCenter.default.removeObserver(obs)
                deck.endObserver = nil
            }

            let item = AVPlayerItem(url: url)
            deck.item = item
            deck.songId = songId
            deck.startAt = startAt
            deck.lastDuration = 0
            deck.player.replaceCurrentItem(with: item)
            deck.player.volume = deck.volume

            deck.statusObs = item.observe(\.status, options: [.new]) { [weak self, weak deck] item, _ in
                guard let self = self, let deck = deck else { return }
                if item.status == .readyToPlay {
                    let dur = item.duration.isNumeric ? item.duration.seconds : 0
                    deck.lastDuration = dur.isFinite ? dur : 0
                    self.notifyListeners("loaded", data: ["deck": deck.id, "duration": deck.lastDuration])
                    if deck.startAt > 0.5 {
                        item.seek(to: CMTime(seconds: deck.startAt, preferredTimescale: 600)) { _ in }
                        deck.startAt = 0
                    }
                    if deck.wantsPlaying {
                        self.startPlayback(deck)
                    }
                } else if item.status == .failed {
                    let nsError = item.error as NSError?
                    var message = nsError?.localizedDescription ?? "load failed"
                    if let nsError = nsError {
                        message += " [\(nsError.domain) \(nsError.code)]"
                        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
                            message += " under(\(underlying.domain) \(underlying.code))"
                        }
                    }
                    self.notifyListeners("error", data: ["deck": deck.id, "message": message])
                }
            }

            deck.endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: item,
                queue: .main
            ) { [weak self, weak deck] _ in
                guard let self = self, let deck = deck else { return }
                self.notifyListeners("ended", data: ["deck": deck.id])
            }

            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        DispatchQueue.main.async {
            deck.wantsPlaying = true
            self.startPlayback(deck)
            call.resolve()
        }
    }

    private func startPlayback(_ deck: Deck) {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback {
            configureSession()
        } else {
            try? session.setActive(true)
        }
        if deck.desiredRate != 1.0 {
            deck.player.playImmediately(atRate: deck.desiredRate)
        } else {
            deck.player.play()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        DispatchQueue.main.async {
            deck.wantsPlaying = false
            self.cancelRamp()
            deck.player.pause()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        DispatchQueue.main.async {
            self.teardownDeck(deck)
            call.resolve()
        }
    }

    @objc func releaseDeck(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.resolve()
            return
        }
        DispatchQueue.main.async {
            self.teardownDeck(deck)
            call.resolve()
        }
    }

    private func teardownDeck(_ deck: Deck) {
        deck.wantsPlaying = false
        deck.player.pause()
        deck.player.replaceCurrentItem(with: nil)
        deck.statusObs?.invalidate()
        deck.statusObs = nil
        if let obs = deck.endObserver {
            NotificationCenter.default.removeObserver(obs)
            deck.endObserver = nil
        }
        deck.item = nil
        deck.songId = nil
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        let position = max(0, call.getDouble("position") ?? 0)
        DispatchQueue.main.async {
            self.cancelRamp()
            let target = CMTime(seconds: position, preferredTimescale: 600)
            deck.player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak deck] _ in
                guard let self = self, let deck = deck else { return }
                self.notifyListeners("seeked", data: ["deck": deck.id, "currentTime": position])
            }
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        let volume = max(0, min(1, Float(call.getDouble("volume") ?? 1.0)))
        DispatchQueue.main.async {
            self.cancelRamp()
            deck.volume = volume
            deck.player.volume = volume
            call.resolve()
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        guard let deck = deck(call) else {
            call.reject("deck not configured")
            return
        }
        let rate = Float(call.getDouble("rate") ?? 1.0)
        DispatchQueue.main.async {
            deck.desiredRate = rate
            if deck.player.timeControlStatus != .paused {
                deck.player.rate = rate
            }
            call.resolve()
        }
    }

    @objc func setActiveDeck(_ call: CAPPluginCall) {
        if let deckId = call.getString("deck") {
            activeDeck = deckId
        }
        call.resolve()
    }

    // MARK: - Crossfade (native equal-power ramp, background-safe)

    @objc func crossfade(_ call: CAPPluginCall) {
        guard let fromId = call.getString("from"), let toId = call.getString("to"),
              let from = decks[fromId], let to = decks[toId] else {
            call.reject("bad decks")
            return
        }
        let durationMs = max(1, call.getDouble("durationMs") ?? 4000)
        let peak = max(0, Float(call.getDouble("peak") ?? 1.0))

        DispatchQueue.main.async {
            self.cancelRamp()
            let startFrom = from.volume
            to.volume = 0
            to.player.volume = 0
            to.wantsPlaying = true
            self.startPlayback(to)

            let startNanos = DispatchTime.now().uptimeNanoseconds
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now(), repeating: 0.033)
            timer.setEventHandler { [weak self, weak from, weak to] in
                guard let self = self, let from = from, let to = to else { return }
                let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000
                let progress = max(0, min(1, elapsedMs / durationMs))
                let outGain = Float(cos(progress * 0.5 * Double.pi))
                let inGain = Float(sin(progress * 0.5 * Double.pi))
                from.volume = startFrom * outGain
                from.player.volume = from.volume
                to.volume = peak * inGain
                to.player.volume = to.volume
                if progress >= 1 {
                    self.cancelRamp()
                    from.volume = 0
                    from.player.volume = 0
                    from.player.pause()
                    from.wantsPlaying = false
                    to.volume = peak
                    to.player.volume = peak
                    self.activeDeck = to.id
                    self.notifyListeners("crossfadeComplete", data: ["from": from.id, "to": to.id])
                }
            }
            self.rampTimer = timer
            timer.resume()
            call.resolve()
        }
    }

    private func cancelRamp() {
        rampTimer?.cancel()
        rampTimer = nil
    }

    // MARK: - Now Playing / lock screen

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let duration = call.getDouble("duration") ?? 0
        let artworkUrl = call.getString("artworkUrl")

        DispatchQueue.main.async {
            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPMediaItemPropertyAlbumTitle: album,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
                MPNowPlayingInfoPropertyPlaybackRate: 0.0,
            ]
            if duration > 0 {
                info[MPMediaItemPropertyPlaybackDuration] = duration
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            self.loadArtwork(artworkUrl)
            call.resolve()
        }
    }

    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        let position = call.getDouble("position") ?? 0
        let rate = call.getDouble("rate") ?? 1
        let playing = call.getBool("playing") ?? false

        DispatchQueue.main.async {
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
            info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? rate : 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
            call.resolve()
        }
    }

    private func loadArtwork(_ urlString: String?) {
        guard let urlString = urlString, let url = URL(string: urlString) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }.resume()
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.emitRemote("play"); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.emitRemote("pause"); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.emitRemote("toggle"); return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.emitRemote("next"); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.emitRemote("prev"); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.notifyListeners("remote", data: ["action": "seek", "value": event.positionTime])
            return .success
        }
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
    }

    private func emitRemote(_ action: String) {
        notifyListeners("remote", data: ["action": action])
    }

    private func setupInterruptionObserver() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        if type == .began {
            emitRemote("pause")
        } else if type == .ended {
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt,
               AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume) {
                emitRemote("play")
            }
        }
    }

    // MARK: - Helpers

    private func deck(_ call: CAPPluginCall) -> Deck? {
        guard let id = call.getString("deck") else { return nil }
        return decks[id]
    }

    private func emitTime(_ deck: Deck?) {
        guard let deck = deck else { return }
        let player = deck.player
        guard deck.id == activeDeck || player.timeControlStatus == .playing else { return }
        let current = player.currentTime().seconds
        guard current.isFinite else { return }
        var duration = 0.0
        if let itemDuration = deck.item?.duration, itemDuration.isNumeric {
            let seconds = itemDuration.seconds
            if seconds.isFinite { duration = seconds }
        }
        notifyListeners("time", data: ["deck": deck.id, "currentTime": current, "duration": duration])
    }
}
