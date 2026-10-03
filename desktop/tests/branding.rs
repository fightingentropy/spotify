use std::path::PathBuf;
use std::process::Command;

const COMMANDS: [(&str, &str); 1] =
    [("streamarena-music", env!("CARGO_BIN_EXE_streamarena-music"))];

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "streamarena-branding-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn desktop_command_reports_its_own_name_and_music_service_description() {
    for (name, binary) in COMMANDS {
        let output = Command::new(binary).arg("--version").output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            format!("{name} {}", env!("CARGO_PKG_VERSION"))
        );
        let help = Command::new(binary).arg("--help").output().unwrap();
        assert!(help.status.success());
        let help = String::from_utf8(help.stdout).unwrap();
        assert!(help.contains(&format!("Usage: {name}")));
        assert!(help.contains("Local Spotify desktop client for the StreamArena music API"));
        assert!(help.contains("desktop client"));
    }
}

#[test]
fn removed_upstream_update_helpers_cannot_modify_the_profile() {
    let scratch = Scratch::new();
    for flag in ["--apply-update", "--update-receipt", "--update-error"] {
        let output = Command::new(env!("CARGO_BIN_EXE_streamarena-music"))
            .args([flag, "unused-upstream-handoff"])
            .env("STREAMARENA_PROFILE_DIR", &scratch.0)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{flag} must be rejected before startup"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("unexpected argument"));
    }
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0);
}

#[test]
fn preferences_and_custom_device_names_survive_a_round_trip() {
    use spotifast::settings::{Settings, ThemeChoice};

    let scratch = Scratch::new();
    let path = scratch.0.join("settings.json");
    for name in [
        "Spotify",
        "StreamArena Music",
        "Living room",
        "Erlin's laptop",
    ] {
        let saved = Settings {
            device_name: name.into(),
            theme: ThemeChoice::Light,
            volume: 37,
            pinned_contexts: vec![
                "spotify:playlist:123".into(),
                spotifast::settings::LIKED_SONGS_KEY.into(),
            ],
            ..Settings::default()
        };
        saved.save(&path);
        assert_eq!(Settings::load(&path), saved);
    }
    assert_eq!(Settings::default().device_name, "Spotify");
}

#[cfg(target_os = "linux")]
#[test]
fn desktop_command_forwards_links_to_its_existing_instance_on_a_private_bus() {
    use spotifast::single_instance::{ControlCommand, Outcome};

    const CHILD: &str = "STREAMARENA_BRANDING_PRIVATE_BUS";
    if std::env::var_os(CHILD).is_none() {
        // A clean build (including Nix) need not have /etc/dbus-1/session.conf.
        // Own the bus configuration too, without loading desktop services.
        let scratch = Scratch::new();
        let config = scratch.0.join("session.conf");
        std::fs::write(
            &config,
            r#"<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>"#,
        )
        .unwrap();
        let result = Command::new("dbus-run-session")
            .arg("--config-file")
            .arg(config)
            .args(["--"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "desktop_command_forwards_links_to_its_existing_instance_on_a_private_bus",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .expect("the Linux test environment needs dbus-run-session");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }

    let scratch = Scratch::new();
    for (_, binary) in COMMANDS {
        let result = Command::new(binary).arg("reload-themes").output().unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&result.stderr).contains("not running"));
        let result = Command::new(binary).arg("like").output().unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("not running"),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let Outcome::Only(guard) = spotifast::single_instance::acquire(&Default::default(), None)
    else {
        panic!("the private bus must start without another instance");
    };
    let commands = guard.commands();
    for (_, binary) in COMMANDS {
        for (link, uri) in [
            (
                "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
                "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
            ),
            (
                "https://open.spotify.com/search/here%20comes%20the%20sun",
                "spotify:search:here%20comes%20the%20sun",
            ),
            (
                "spotify://search/%E6%9D%B1%E4%BA%AC",
                "spotify:search:%E6%9D%B1%E4%BA%AC",
            ),
        ] {
            let mut child = Command::new(binary)
                .arg(link)
                .env("XDG_CONFIG_HOME", scratch.0.join("config"))
                .env("XDG_STATE_HOME", scratch.0.join("state"))
                .env("XDG_CACHE_HOME", scratch.0.join("cache"))
                .spawn()
                .unwrap();
            let started = std::time::Instant::now();
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if started.elapsed() > std::time::Duration::from_secs(10) {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("a second command did not forward its link and exit");
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            assert!(status.success());
            assert_eq!(
                std::mem::take(&mut *commands.lock().unwrap()),
                vec![ControlCommand::OpenLink(uri.into())]
            );
        }
        let result = Command::new(binary).arg("reload-themes").output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            std::mem::take(&mut *commands.lock().unwrap()),
            vec![ControlCommand::ReloadThemes],
            "a reload only asks for themes, never OpenLink or Show"
        );
        let result = Command::new(binary).arg("like").output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            std::mem::take(&mut *commands.lock().unwrap()),
            vec![ControlCommand::ToggleSaved],
            "like only toggles the saved state, never OpenLink or Show"
        );
    }
}
