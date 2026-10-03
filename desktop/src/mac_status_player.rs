//! A native artwork-led player popover that stays alive without the desktop.

use std::cell::{Cell, OnceCell, RefCell};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image::ImageEncoder;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, MethodImplementation, Sel};
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSAccessibility, NSAppearance, NSAppearanceNameDarkAqua, NSApplication,
    NSApplicationActivationPolicy, NSButton, NSCellImagePosition, NSColor, NSControl, NSFont,
    NSFontWeightMedium, NSFontWeightSemibold, NSImage, NSImageScaling, NSImageView,
    NSLineBreakMode, NSPopover, NSPopoverBehavior, NSSlider, NSStatusBar, NSStatusItem,
    NSTextAlignment, NSTextField, NSView, NSViewController,
};
use objc2_foundation::{
    NSData, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRectEdge, NSSize, NSString, ns_string,
};

use crate::model::Action;
use crate::player::RepeatMode;

#[derive(Clone, Default)]
pub struct Snapshot {
    pub uri: String,
    pub title: String,
    pub artist: String,
    pub position_ms: u32,
    pub duration_ms: u32,
    pub art_file: Option<PathBuf>,
    pub playing: bool,
    pub loading: bool,
    pub saved: bool,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    pub can_control: bool,
    pub can_set_volume: bool,
    pub volume: u8,
}

static COMMANDS: Mutex<Vec<Action>> = Mutex::new(Vec::new());
static WAKER: Mutex<Option<egui::Context>> = Mutex::new(None);

thread_local! {
    static SNAPSHOT: RefCell<Snapshot> = RefCell::new(Snapshot::default());
    static PENDING_SHOW: Cell<Option<Instant>> = const { Cell::new(None) };
    // AppKit's targets are weak; retain the controller for the whole process.
    static STATUS: OnceCell<StatusPlayer> = const { OnceCell::new() };
}

const WIDTH: f64 = 328.0;
const HEIGHT: f64 = 562.0;

struct StatusPlayer {
    status: Retained<NSStatusItem>,
    popover: Retained<NSPopover>,
    _handler: Retained<StatusPlayerHandler>,
    art: Retained<NSImageView>,
    title: Retained<NSTextField>,
    artist: Retained<NSTextField>,
    elapsed: Retained<NSTextField>,
    remaining: Retained<NSTextField>,
    seek: Retained<NSSlider>,
    volume: Retained<NSSlider>,
    play: Retained<NSButton>,
    previous: Retained<NSButton>,
    next: Retained<NSButton>,
    save: Retained<NSButton>,
    shuffle: Retained<NSButton>,
    repeat: Retained<NSButton>,
    mute: Retained<NSButton>,
    rendered: RefCell<Option<Snapshot>>,
}

fn enqueue(action: Action) {
    COMMANDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(action);
    if let Some(ctx) = WAKER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        ctx.request_repaint();
    }
}

pub fn drain_actions() -> Vec<Action> {
    std::mem::take(&mut *COMMANDS.lock().unwrap_or_else(|e| e.into_inner()))
}

pub fn update(snapshot: Snapshot) {
    SNAPSHOT.with(|slot| *slot.borrow_mut() = snapshot);
    // Switching activation policy temporarily unmaps the status item's view.
    // AppKit cannot anchor a popover until that view is visible again.
    if PENDING_SHOW.with(|pending| pending.get().is_some()) {
        try_show();
    }
    STATUS.with(|slot| {
        if let Some(player) = slot.get()
            && player.popover.isShown()
        {
            SNAPSHOT.with(|snapshot| player.render(&snapshot.borrow()));
        }
    });
}

pub fn show() {
    PENDING_SHOW.with(|pending| pending.set(Some(Instant::now() + Duration::from_secs(2))));
    try_show();
}

fn try_show() {
    STATUS.with(|slot| {
        if let Some(player) = slot.get() {
            let expired =
                PENDING_SHOW.with(|pending| pending.get().is_none_or(|due| Instant::now() > due));
            if expired || player.show() {
                PENDING_SHOW.with(|pending| pending.set(None));
            }
        } else {
            PENDING_SHOW.with(|pending| pending.set(None));
        }
    });
}

pub fn close() {
    PENDING_SHOW.with(|pending| pending.set(None));
    STATUS.with(|slot| {
        if let Some(player) = slot.get() {
            player.popover.close();
        }
    });
}

fn is_shown() -> bool {
    STATUS.with(|slot| slot.get().is_some_and(|player| player.popover.isShown()))
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "StreamArenaStatusPlayerHandler"]
    struct StatusPlayerHandler;

    unsafe impl NSObjectProtocol for StatusPlayerHandler {}

    impl StatusPlayerHandler {
        #[unsafe(method(togglePlayer:))]
        fn toggle_player(&self, _sender: &NSObject) {
            if is_shown() { close(); } else { show(); }
        }

        #[unsafe(method(selectPlayerAction:))]
        fn select_action(&self, control: &NSControl) {
            let snapshot = SNAPSHOT.with(|slot| slot.borrow().clone());
            let action = match control.tag() {
                1 => Action::TogglePlay,
                2 => Action::Previous,
                3 => Action::Next,
                4 => Action::ToggleShuffle,
                5 => Action::CycleRepeat,
                6 => Action::ToggleMute,
                7 => { close(); Action::ShowWindow },
                9 => { close(); Action::Quit },
                10 if !snapshot.uri.is_empty() => Action::ToggleSaved(snapshot.uri),
                _ => return,
            };
            enqueue(action);
        }

        #[unsafe(method(seekToPosition:))]
        fn seek(&self, slider: &NSSlider) {
            let duration = SNAPSHOT.with(|slot| slot.borrow().duration_ms);
            if let Some(position) = seek_position(slider.doubleValue(), duration) {
                enqueue(Action::Seek(position));
            }
        }

        #[unsafe(method(setPlayerVolume:))]
        fn set_volume(&self, slider: &NSSlider) {
            enqueue(Action::SetVolume(slider.doubleValue().round().clamp(0.0, 100.0) as u8));
        }
    }
);

fn seek_position(fraction: f64, duration: u32) -> Option<u32> {
    (duration > 0 && fraction.is_finite())
        .then(|| (fraction.clamp(0.0, 1.0) * f64::from(duration)).round() as u32)
}

// AppKit uses a bottom-left origin. Keep layout measurements top-down.
fn frame(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(x, HEIGHT - y - height),
        NSSize::new(width, height),
    )
}

fn color(r: f64, g: f64, b: f64) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0)
}

fn secondary() -> Retained<NSColor> {
    color(0.63, 0.66, 0.69)
}
fn accent() -> Retained<NSColor> {
    color(0.0, 0.84, 0.37)
}

fn state_color(active: bool) -> Retained<NSColor> {
    if active { accent() } else { secondary() }
}

fn rounded(view: &NSView, radius: f64, fill: Option<&NSColor>) {
    view.setWantsLayer(true);
    if let Some(layer) = view.layer() {
        layer.setCornerRadius(radius);
        layer.setMasksToBounds(true);
        if let Some(fill) = fill {
            layer.setBackgroundColor(Some(&fill.CGColor()));
        }
    }
}

fn symbol(name: &str, size: f64) -> Option<Retained<NSImage>> {
    let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        None,
    )?;
    image.setSize(NSSize::new(size, size));
    Some(image)
}

fn set_symbol(button: &NSButton, name: &str, label: &str, size: f64) {
    button.setImage(symbol(name, size).as_deref());
    button.setToolTip(Some(&NSString::from_str(label)));
    button.setAccessibilityLabel(Some(&NSString::from_str(label)));
}

fn icon_button(
    root: &NSView,
    handler: &StatusPlayerHandler,
    rect: NSRect,
    icon: &str,
    label: &str,
    tag: isize,
    size: f64,
) -> Retained<NSButton> {
    let button = NSButton::initWithFrame(handler.mtm().alloc(), rect);
    button.setBordered(false);
    button.setImagePosition(NSCellImagePosition::ImageOnly);
    button.setImageScaling(NSImageScaling::ScaleProportionallyDown);
    button.setContentTintColor(Some(&NSColor::whiteColor()));
    button.setTag(tag);
    unsafe {
        button.setTarget(Some(handler));
        button.setAction(Some(sel!(selectPlayerAction:)));
    }
    set_symbol(&button, icon, label, size);
    root.addSubview(&button);
    button
}

fn label(root: &NSView, rect: NSRect, size: f64, strong: bool) -> Retained<NSTextField> {
    let field = NSTextField::wrappingLabelWithString(ns_string!(""), root.mtm());
    field.setFrame(rect);
    field.setFont(Some(&NSFont::systemFontOfSize_weight(
        size,
        if strong {
            unsafe { NSFontWeightSemibold }
        } else {
            unsafe { NSFontWeightMedium }
        },
    )));
    let text_color = if strong {
        NSColor::whiteColor()
    } else {
        secondary()
    };
    field.setTextColor(Some(&text_color));
    field.setMaximumNumberOfLines(if strong { 2 } else { 1 });
    field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
    root.addSubview(&field);
    field
}

fn slider(
    root: &NSView,
    handler: &StatusPlayerHandler,
    rect: NSRect,
    max: f64,
    action: Sel,
    name: &str,
) -> Retained<NSSlider> {
    let slider = unsafe {
        NSSlider::sliderWithValue_minValue_maxValue_target_action(
            0.0,
            0.0,
            max,
            Some(handler),
            Some(action),
            handler.mtm(),
        )
    };
    slider.setFrame(rect);
    // Commit once per drag, avoiding a burst of network seeks/volume writes.
    slider.setContinuous(false);
    slider.setTrackFillColor(Some(&NSColor::whiteColor()));
    slider.setAccessibilityLabel(Some(&NSString::from_str(name)));
    root.addSubview(&slider);
    slider
}

impl StatusPlayer {
    fn new(
        mtm: MainThreadMarker,
        status: Retained<NSStatusItem>,
        handler: Retained<StatusPlayerHandler>,
    ) -> Self {
        let root = NSView::initWithFrame(
            mtm.alloc(),
            NSRect::new(NSPoint::ZERO, NSSize::new(WIDTH, HEIGHT)),
        );
        rounded(&root, 0.0, Some(&color(0.055, 0.063, 0.071)));
        let art = NSImageView::initWithFrame(mtm.alloc(), frame(40.0, 20.0, 248.0, 248.0));
        art.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
        art.setAccessibilityLabel(Some(ns_string!("Album artwork")));
        rounded(&art, 10.0, Some(&color(0.10, 0.12, 0.14)));
        root.addSubview(&art);
        let title = label(&root, frame(20.0, 286.0, 250.0, 42.0), 17.0, true);
        let artist = label(&root, frame(20.0, 332.0, 288.0, 18.0), 13.0, false);
        let save = icon_button(
            &root,
            &handler,
            frame(278.0, 288.0, 30.0, 30.0),
            "heart",
            "Add to Liked Songs",
            10,
            17.0,
        );
        let seek = slider(
            &root,
            &handler,
            frame(18.0, 366.0, 292.0, 16.0),
            1.0,
            sel!(seekToPosition:),
            "Playback position",
        );
        let elapsed = label(&root, frame(20.0, 387.0, 90.0, 15.0), 11.0, false);
        let remaining = label(&root, frame(218.0, 387.0, 90.0, 15.0), 11.0, false);
        remaining.setAlignment(NSTextAlignment::Right);
        let shuffle = icon_button(
            &root,
            &handler,
            frame(22.0, 420.0, 32.0, 32.0),
            "shuffle",
            "Shuffle",
            4,
            16.0,
        );
        let previous = icon_button(
            &root,
            &handler,
            frame(80.0, 416.0, 40.0, 40.0),
            "backward.end.fill",
            "Previous track",
            2,
            21.0,
        );
        let play = icon_button(
            &root,
            &handler,
            frame(140.0, 412.0, 48.0, 48.0),
            "play.fill",
            "Play",
            1,
            21.0,
        );
        rounded(&play, 24.0, Some(&NSColor::whiteColor()));
        play.setContentTintColor(Some(&NSColor::blackColor()));
        let next = icon_button(
            &root,
            &handler,
            frame(208.0, 416.0, 40.0, 40.0),
            "forward.end.fill",
            "Next track",
            3,
            21.0,
        );
        let repeat = icon_button(
            &root,
            &handler,
            frame(274.0, 420.0, 32.0, 32.0),
            "repeat",
            "Repeat off",
            5,
            16.0,
        );
        let mute = icon_button(
            &root,
            &handler,
            frame(18.0, 478.0, 28.0, 28.0),
            "speaker.wave.1.fill",
            "Mute",
            6,
            14.0,
        );
        mute.setContentTintColor(Some(&secondary()));
        let volume = slider(
            &root,
            &handler,
            frame(54.0, 484.0, 218.0, 16.0),
            100.0,
            sel!(setPlayerVolume:),
            "Volume",
        );
        let loud = NSImageView::initWithFrame(mtm.alloc(), frame(284.0, 484.0, 18.0, 16.0));
        loud.setImage(symbol("speaker.wave.3.fill", 14.0).as_deref());
        loud.setContentTintColor(Some(&secondary()));
        root.addSubview(&loud);
        let divider = NSView::initWithFrame(mtm.alloc(), frame(20.0, 519.0, 288.0, 1.0));
        rounded(&divider, 0.0, Some(&color(0.16, 0.18, 0.20)));
        root.addSubview(&divider);
        let desktop = icon_button(
            &root,
            &handler,
            frame(16.0, 528.0, 228.0, 28.0),
            "arrow.up.right.square",
            "Open desktop app",
            7,
            13.0,
        );
        desktop.setTitle(ns_string!("  Open desktop app"));
        desktop.setImagePosition(NSCellImagePosition::ImageLeft);
        desktop.setAlignment(NSTextAlignment::Left);
        desktop.setFont(Some(&NSFont::systemFontOfSize(12.0)));
        desktop.setContentTintColor(Some(&secondary()));
        let quit = icon_button(
            &root,
            &handler,
            frame(280.0, 528.0, 28.0, 28.0),
            "power",
            "Quit Spotify",
            9,
            13.0,
        );
        quit.setContentTintColor(Some(&secondary()));
        let controller = NSViewController::new(mtm);
        controller.setView(&root);
        let popover = NSPopover::new(mtm);
        popover.setContentViewController(Some(&controller));
        popover.setContentSize(NSSize::new(WIDTH, HEIGHT));
        popover.setBehavior(NSPopoverBehavior::Transient);
        popover.setAppearance(
            NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }).as_deref(),
        );
        Self {
            status,
            popover,
            _handler: handler,
            art,
            title,
            artist,
            elapsed,
            remaining,
            seek,
            volume,
            play,
            previous,
            next,
            save,
            shuffle,
            repeat,
            mute,
            rendered: RefCell::new(None),
        }
    }

    fn show(&self) -> bool {
        let mtm = self._handler.mtm();
        let Some(button) = self.status.button(mtm) else {
            return false;
        };
        if let Some(window) = button.window()
            && !window.isVisible()
        {
            // AppKit requires a visible anchor; its backing window can be
            // ordered out after the desktop closes.
            window.orderFrontRegardless();
        }
        self.render(&SNAPSHOT.with(|slot| slot.borrow().clone()));
        // A transient popover needs activation for keyboard and outside-click
        // dismissal. Accessory policy still keeps it out of the Dock.
        #[allow(deprecated, reason = "supports macOS before 14")]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        self.popover.showRelativeToRect_ofView_preferredEdge(
            button.bounds(),
            &button,
            NSRectEdge::MinY,
        );
        if let Some(window) = self
            .popover
            .contentViewController()
            .and_then(|controller| controller.view().window())
        {
            window.setTitle(ns_string!("Spotify Player"));
            window.setAccessibilityLabel(Some(ns_string!("Spotify menu bar player")));
            window.makeKeyWindow();
        }
        self.popover.isShown()
    }

    fn render(&self, now: &Snapshot) {
        let mut rendered = self.rendered.borrow_mut();
        let old = rendered.as_ref();
        if old.is_none_or(|old| old.title != now.title || old.artist != now.artist) {
            self.title
                .setStringValue(&NSString::from_str(if now.title.is_empty() {
                    "Ready when you are"
                } else {
                    &now.title
                }));
            self.title.setToolTip(Some(&NSString::from_str(&now.title)));
            self.artist
                .setStringValue(&NSString::from_str(if now.title.is_empty() {
                    "Choose a song in the desktop app"
                } else {
                    &now.artist
                }));
        }
        if old.is_none_or(|old| old.art_file != now.art_file || old.uri != now.uri) {
            let image = now.art_file.as_ref().and_then(|path| {
                NSImage::initWithContentsOfFile(
                    NSImage::alloc(),
                    &NSString::from_str(&path.to_string_lossy()),
                )
            });
            self.art.setImage(image.as_deref());
            if image.is_none() {
                self.art
                    .setImageScaling(NSImageScaling::ScaleProportionallyDown);
                self.art.setImage(symbol("music.note", 48.0).as_deref());
                self.art.setContentTintColor(Some(&secondary()));
            } else {
                self.art
                    .setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
                self.art.setContentTintColor(None);
            }
        }
        if old.is_none_or(|old| old.playing != now.playing || old.loading != now.loading) {
            set_symbol(
                &self.play,
                if now.playing {
                    "pause.fill"
                } else {
                    "play.fill"
                },
                if now.playing {
                    "Pause"
                } else if now.loading {
                    "Loading"
                } else {
                    "Play"
                },
                21.0,
            );
        }
        self.play.setEnabled(now.can_control);
        self.previous.setEnabled(now.can_control);
        self.next.setEnabled(now.can_control);
        self.shuffle.setEnabled(now.can_control);
        self.repeat.setEnabled(now.can_control);
        self.save.setEnabled(
            !now.uri.is_empty()
                && !now.uri.starts_with("spotify:track:radio:")
                && !now.uri.starts_with("spotify:episode:"),
        );
        if old.is_none_or(|old| old.saved != now.saved) {
            set_symbol(
                &self.save,
                if now.saved { "heart.fill" } else { "heart" },
                if now.saved {
                    "Remove from Liked Songs"
                } else {
                    "Add to Liked Songs"
                },
                17.0,
            );
            self.save.setContentTintColor(Some(&state_color(now.saved)));
        }
        if old.is_none_or(|old| old.shuffle != now.shuffle) {
            let label = if now.shuffle {
                "Shuffle on"
            } else {
                "Shuffle off"
            };
            self.shuffle.setToolTip(Some(&NSString::from_str(label)));
            self.shuffle
                .setAccessibilityLabel(Some(&NSString::from_str(label)));
            self.shuffle
                .setContentTintColor(Some(&state_color(now.shuffle)));
        }
        if old.is_none_or(|old| old.repeat != now.repeat) {
            set_symbol(
                &self.repeat,
                if now.repeat == RepeatMode::Track {
                    "repeat.1"
                } else {
                    "repeat"
                },
                match now.repeat {
                    RepeatMode::Off => "Repeat off",
                    RepeatMode::Context => "Repeat all",
                    RepeatMode::Track => "Repeat one",
                },
                16.0,
            );
            self.repeat
                .setContentTintColor(Some(&state_color(now.repeat != RepeatMode::Off)));
        }
        let progress = if now.duration_ms > 0 {
            f64::from(now.position_ms) / f64::from(now.duration_ms)
        } else {
            0.0
        };
        self.seek.setDoubleValue(progress.clamp(0.0, 1.0));
        self.seek
            .setEnabled(now.can_control && now.duration_ms > 0 && !now.loading);
        let live = now.uri.starts_with("spotify:track:radio:");
        let elapsed = if live && !now.loading {
            "Live radio".into()
        } else if now.loading {
            "Loading…".into()
        } else {
            crate::util::format_duration_ms(now.position_ms)
        };
        self.elapsed.setStringValue(&NSString::from_str(&elapsed));
        let remaining = if live {
            String::new()
        } else {
            format!(
                "−{}",
                crate::util::format_duration_ms(now.duration_ms.saturating_sub(now.position_ms))
            )
        };
        self.remaining
            .setStringValue(&NSString::from_str(&remaining));
        self.seek
            .setAccessibilityValueDescription(Some(&NSString::from_str(&format!(
                "{} of {}",
                elapsed,
                crate::util::format_duration_ms(now.duration_ms)
            ))));
        self.volume.setDoubleValue(f64::from(now.volume));
        self.volume.setEnabled(now.can_set_volume);
        self.volume
            .setAccessibilityValueDescription(Some(&NSString::from_str(&format!(
                "{} percent",
                now.volume
            ))));
        self.mute.setEnabled(now.can_set_volume);
        if old.is_none_or(|old| (old.volume == 0) != (now.volume == 0)) {
            set_symbol(
                &self.mute,
                if now.volume == 0 {
                    "speaker.slash.fill"
                } else {
                    "speaker.wave.1.fill"
                },
                if now.volume == 0 { "Unmute" } else { "Mute" },
                14.0,
            );
        }
        *rendered = Some(now.clone());
    }
}

/// The status item and popover survive desktop-window destruction/restoration.
pub fn attach(ctx: &egui::Context) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    *WAKER.lock().unwrap_or_else(|e| e.into_inner()) = Some(ctx.clone());
    STATUS.with(|slot| {
        if slot.get().is_some() {
            return true;
        }
        let rgba = crate::util::tray_template_rgba(36);
        let mut png = Vec::new();
        if image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rgba, 36, 36, image::ExtendedColorType::Rgba8)
            .is_err()
        {
            return false;
        }
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::from_vec(png)) else {
            return false;
        };
        image.setSize(NSSize::new(18.0, 18.0));
        image.setTemplate(true);
        let bar = NSStatusBar::systemStatusBar();
        let status = bar.statusItemWithLength(-1.0);
        let Some(button) = status.button(mtm) else {
            bar.removeStatusItem(&status);
            return false;
        };
        button.setImage(Some(&image));
        button.setToolTip(Some(ns_string!("Spotify")));
        button.setAccessibilityLabel(Some(ns_string!("Spotify menu bar player")));
        let handler: Retained<StatusPlayerHandler> =
            unsafe { msg_send![super(StatusPlayerHandler::alloc(mtm).set_ivars(())), init] };
        unsafe {
            button.setTarget(Some(&handler));
            button.setAction(Some(sel!(togglePlayer:)));
        }
        install_reopen_handler(&NSApplication::sharedApplication(mtm));
        slot.set(StatusPlayer::new(mtm, status, handler)).is_ok()
    })
}

/// Accessory mode removes the Dock and app-switcher entry; returning to
/// Regular restores both without changing the running player or credentials.
pub fn set_dock_visible(visible: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let policy = if visible {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Accessory
    };
    if app.activationPolicy() != policy {
        app.setActivationPolicy(policy);
        if app.activationPolicy() != policy {
            log::warn!("macOS could not change Spotify's Dock visibility to {visible}");
        } else {
            log::info!("Spotify Dock visibility: {visible}");
        }
    }
    if visible {
        #[allow(deprecated, reason = "supports macOS before 14")]
        app.activateIgnoringOtherApps(true);
    }
}

extern "C-unwind" fn reopen(
    _delegate: *mut AnyObject,
    _selector: Sel,
    _app: *mut NSApplication,
    _visible: Bool,
) -> Bool {
    // Re-activating the app while its player is open should focus that
    // popover. The explicit desktop action below it restores the big window.
    if is_shown() {
        return Bool::YES;
    }
    log::info!("Desktop restore requested by macOS");
    enqueue(Action::ShowWindow);
    Bool::YES
}

fn install_reopen_handler(app: &NSApplication) {
    let Some(delegate) = app.delegate() else {
        return;
    };
    let delegate: &AnyObject = AsRef::<AnyObject>::as_ref(&*delegate);
    let class = delegate.class();
    let selector = sel!(applicationShouldHandleReopen:hasVisibleWindows:);
    if class.responds_to(selector) {
        return;
    }
    let callback: extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSApplication, Bool) -> Bool =
        reopen;
    // AppKit's delegate lives for the process. The encoding matches BOOL,
    // self, selector, application, and BOOL on this Objective-C runtime.
    use objc2::Encode;
    let encoding =
        std::ffi::CString::new(format!("{}@:@{}", Bool::ENCODING, Bool::ENCODING)).unwrap();
    unsafe {
        objc2::ffi::class_addMethod(
            std::ptr::from_ref::<AnyClass>(class).cast_mut(),
            selector,
            callback.__imp(),
            encoding.as_ptr(),
        );
    }
}
