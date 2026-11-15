use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

const PORT: &str = "3141";

/// The one thing this whole app manages: the Next.js server's own child process. Killing it is
/// how "Quit" ends the app's actual work -- there is no separate background service (no
/// launchd agent, no second process tree) for this to leak into once the window closes.
struct ServerProcess(Mutex<Option<Child>>);

/// Guards `start_bringup` against running twice: both `frontend_ready` (the normal path) and the
/// setup watchdog (in case the webview never loads) can call it, and only the first call should
/// actually do anything -- a second would race the first to install the code directory and spawn
/// a second server fighting the first one for the same port.
struct BringupStarted(Mutex<bool>);

/// The tray's status line, held so background asset downloads can keep it current. It is a
/// disabled menu item -- a label, not something to click.
struct TrayStatus(Mutex<Option<MenuItem<tauri::Wry>>>);

/// A running snapshot of what the setup screen would have shown. Tauri events are fire-and-forget
/// -- a window opened later never sees the ones already emitted -- so reopening "Setup Progress"
/// from the tray mid-download would otherwise show an empty, apparently-stuck screen. The page
/// asks for this on load and hydrates from it, then follows live events from there.
#[derive(Default, Clone, serde::Serialize)]
struct SetupState {
    install: String,
    server: String,
    assets: String,
    label: String,
    percent: u32,
    url: Option<String>,
}

struct SetupStateStore(Mutex<SetupState>);

/// `dist/index.html`'s own loading screen listens for these two events: `setup-log` appends a
/// line to what it shows while `prepare` and the server start up, `setup-ready` is the signal to
/// navigate the window to the real app once the server answers.
fn emit_log(app: &AppHandle, line: impl AsRef<str>) {
    let _ = app.emit("setup-log", line.as_ref());
    log::info!("{}", line.as_ref());
}

/// `scripts/brain.sh`'s `fetch_model` prints `SB_PROGRESS|<label>|<percent>` lines (real
/// newlines, unlike curl's own \r-based meter, which a line-by-line reader never sees) while a
/// model downloads. The loading screen renders these as an actual progress bar instead of just
/// another scrolling log line.
fn emit_progress(app: &AppHandle, label: &str, percent: u32) {
    {
        let store = app.state::<SetupStateStore>();
        let mut snapshot = store.0.lock().unwrap();
        snapshot.label = label.to_string();
        snapshot.percent = percent;
    }
    let _ = app.emit("setup-progress", serde_json::json!({ "label": label, "percent": percent }));
}

/// Drives the setup screen's step checklist. `id` is one of "install", "server", "assets";
/// `state` is "active", "done" or "error".
fn emit_step(app: &AppHandle, id: &str, state: &str) {
    {
        let store = app.state::<SetupStateStore>();
        let mut snapshot = store.0.lock().unwrap();
        match id {
            "install" => snapshot.install = state.to_string(),
            "server" => snapshot.server = state.to_string(),
            "assets" => snapshot.assets = state.to_string(),
            _ => {}
        }
    }
    let _ = app.emit("setup-step", serde_json::json!({ "id": id, "state": state }));
    log::info!("[step] {id}: {state}");
}

/// The one place asset progress is visible once the user has left the setup screen for the app
/// itself: a disabled tray menu item whose text is the current status. The tray is the only piece
/// of this app's own UI still on screen at that point -- the window is showing the Next.js app,
/// which is served over http and has no access to these events.
fn set_tray_status(app: &AppHandle, text: &str) {
    if let Some(item) = app.state::<TrayStatus>().0.lock().unwrap().as_ref() {
        let _ = item.set_text(text);
    }
}

/// `true` and routes the line to `emit_progress` if it matches brain.sh's `SB_PROGRESS|` protocol;
/// `false` (do nothing else) if the line didn't match, so the caller falls back to `emit_log`.
fn try_emit_progress(app: &AppHandle, line: &str) -> bool {
    let Some(rest) = line.strip_prefix("SB_PROGRESS|") else { return false };
    let mut parts = rest.splitn(2, '|');
    let (Some(label), Some(percent_str)) = (parts.next(), parts.next()) else { return false };
    let Ok(percent) = percent_str.parse::<u32>() else { return false };
    emit_progress(app, label, percent);
    set_tray_status(app, &format!("Downloading {label} — {percent}%"));
    true
}

/// Where the *code* (the standalone server build, brain.sh, the migrations it needs) lives --
/// deliberately not the data directory (`~/Library/Application Support/second-brain/`, brain.sh's
/// own default): code and data are two different things this app should never conflate, the same
/// rule `set-data-dir` exists to enforce for the CLI-managed install.
fn code_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("current")
}

/// Copies the bundled resources (the standalone server build and brain.sh) into `code_dir` the
/// first time this app runs, or whenever the bundled version is newer than what is already
/// there. Nothing here touches the data directory or any model -- that is `brain.sh`'s job, run
/// after this returns.
///
/// The `bool` is "this copy was already in place", i.e. not a first run or an update. The setup
/// screen uses it to decide whether to linger (first run: models are about to download, there is
/// something worth watching) or continue straight into the app (everything already cached).
fn ensure_code_installed(app: &AppHandle) -> std::io::Result<(PathBuf, bool)> {
    let dest = code_dir(app);
    let marker = dest.join(".version");
    let bundled_version = app.package_info().version.to_string();
    let already_current = std::fs::read_to_string(&marker)
        .map(|v| v.trim() == bundled_version)
        .unwrap_or(false);
    if already_current && dest.join("server.js").exists() {
        return Ok((dest, true));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("resource dir")
        .join("server");
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    copy_dir_recursive(&resource_dir, &dest)?;
    std::fs::write(&marker, &bundled_version)?;
    Ok((dest, false))
}

/// The adaptor folder's path, without touching the disk -- what the server is told about.
fn adaptor_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("extension")
}

/// Where the bundled Chrome adaptor is unpacked, and kept.
///
/// A *sibling* of `code_dir`, never inside it: `ensure_code_installed` deletes `current/`
/// wholesale on every update, and an unpacked extension whose folder disappears out from under
/// Chrome gets disabled -- the person would have to re-add it after each app update, which is
/// exactly the friction bundling it is supposed to remove. Here the folder is only ever copied
/// over, so the path Chrome was given stays valid and simply contains newer code.
///
/// That is the real reason to ship it with the app rather than tell someone to clone a repo:
/// when Slack moves its DOM, the fixed selectors arrive with the next app update.
fn ensure_adaptor_installed(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dest = adaptor_dir(app);
    let marker = dest.join(".version");
    let bundled_version = app.package_info().version.to_string();
    let already_current = std::fs::read_to_string(&marker)
        .map(|v| v.trim() == bundled_version)
        .unwrap_or(false);
    if already_current && dest.join("manifest.json").exists() {
        return Ok(dest);
    }
    let src = app.path().resource_dir().expect("resource dir").join("extension");
    // Not fatal if it is missing: a build without the sibling adaptors repo checked out still
    // produces a working app, it just has no extension to offer.
    if !src.join("manifest.json").exists() {
        return Ok(dest);
    }
    copy_dir_recursive(&src, &dest)?;
    std::fs::write(&marker, &bundled_version)?;
    Ok(dest)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_symlink() {
            // Resolve the link and copy what it points at, rather than recreating a link whose
            // relative target may not exist at the destination.
            //
            // The directory branch matters: this used to be a bare `fs::copy`, which cannot copy
            // a directory, and the error was discarded. Next's Turbopack build puts symlinked
            // *directories* in .next/node_modules (its hashed aliases for serverExternalPackages),
            // so every one of them was silently dropped at install time and the server then failed
            // to start with "Cannot find module 'better-sqlite3-<hash>'". The build now
            // materializes those particular links before bundling, but silently losing data on a
            // symlink is wrong regardless of who else is guarding against it.
            if let Ok(real) = std::fs::read_link(entry.path()) {
                let resolved = if real.is_absolute() { real } else { src.join(&real) };
                if resolved.is_dir() {
                    copy_dir_recursive(&resolved, &target)?;
                } else if resolved.exists() {
                    std::fs::copy(&resolved, &target)?;
                }
            }
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Runs one `scripts/brain.sh` subcommand from the installed code directory, streaming each line
/// out as it happens rather than waiting silently for the whole thing to finish.
///
/// Two subcommands matter here, and the split is the whole point: `bootstrap` is the sub-second,
/// no-network half the server needs before it can boot, and `fetch-assets` is the multi-GB half
/// (models, llama.cpp, the Swift binaries) that runs *after* the server is already up and the
/// user is already in the app.
fn run_script(app: &AppHandle, dir: &Path, subcommand: &str) -> std::io::Result<bool> {
    let mut child = Command::new("bash")
        .arg("scripts/brain.sh")
        .arg(subcommand)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !try_emit_progress(&app, &line) {
                    emit_log(&app, line);
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                emit_log(&app, line);
            }
        });
    }
    let status = child.wait()?;
    Ok(status.success())
}

/// A GUI-launched app (double-clicked from Finder / opened at login) inherits `launchd`'s minimal
/// `PATH`, not the user's shell `PATH` -- so a `node` installed via nvm, Homebrew, or similar (all
/// of which only extend `PATH` from shell startup files like `.zshrc`) is invisible to us even
/// though it works fine from Terminal. Both `brain.sh`'s own `command -v node` check and our own
/// `node server.js` spawn below would fail identically without this. Resolve the user's real PATH
/// once, by asking their actual login shell for it (`-ilc`, not just `-lc`: nvm's installer adds
/// its `PATH` line to `.zshrc`, which only an *interactive* shell sources), and adopt it for the
/// rest of this process so every child process we spawn inherits it.
fn adopt_user_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    const START: &str = "__SB_PATH_START__";
    const END: &str = "__SB_PATH_END__";
    let output = Command::new(&shell)
        .arg("-ilc")
        .arg(format!("echo {START}$PATH{END}"))
        .stdin(Stdio::null())
        .output();
    let mut path = std::env::var("PATH").unwrap_or_default();
    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(start) = stdout.find(START) {
            let rest = &stdout[start + START.len()..];
            if let Some(end) = rest.find(END) {
                let resolved = rest[..end].trim();
                if !resolved.is_empty() {
                    path = resolved.to_string();
                }
            }
        }
    }
    // Belt and suspenders: a broken shell startup file (a bad plugin, a failing update check
    // that `exit`s early) can make the resolution above come back empty or short. Directly check
    // the handful of places Node actually lives on a Mac and append any that exist and aren't
    // already covered, rather than depending entirely on shell startup succeeding cleanly.
    for extra in common_node_dirs() {
        if !path.split(':').any(|p| p == extra) {
            path = format!("{path}:{extra}");
        }
    }
    std::env::set_var("PATH", path);
}

fn common_node_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if !home.is_empty() {
        // nvm doesn't symlink a stable "current" path -- each version gets its own directory, so
        // pick the newest installed one rather than needing to parse its alias/default file.
        let nvm_versions = Path::new(&home).join(".nvm/versions/node");
        if let Ok(mut versions) = std::fs::read_dir(&nvm_versions).map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect::<Vec<_>>()
        }) {
            versions.sort();
            if let Some(latest) = versions.last() {
                candidates.push(latest.join("bin").to_string_lossy().to_string());
            }
        }
        candidates.push(format!("{home}/.volta/bin"));
        candidates.push(format!("{home}/.fnm"));
    }
    candidates
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

fn port_is_open(port: &str) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("valid addr"),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Spawns the standalone server as this app's own child process -- not through launchd, not
/// detached: `ServerProcess` holds the handle for as long as the app runs, and Quit kills it by
/// that handle rather than leaving it to keep running on its own.
///
/// Draining stdout/stderr isn't optional here: piped output nobody reads eventually fills the
/// pipe buffer and blocks the child's writes, and without this a server-side error (a stack
/// trace, an uncaught exception) was simply invisible -- neither we nor whoever's debugging a
/// report of "internal server error" had anywhere to look. Both streams go through `emit_log`,
/// same as `run_prepare`'s, so they land in the app's own log file even after the loading screen
/// has already navigated away and stopped listening for `setup-log` events.
fn spawn_server(app: &AppHandle, dir: &Path) -> std::io::Result<Child> {
    emit_log(app, "Starting the server...");
    let mut child = Command::new("node")
        .arg("server.js")
        .current_dir(dir)
        .env("PORT", PORT)
        .env("HOSTNAME", "127.0.0.1")
        // So Settings can show where the bundled extension landed and open the folder. The
        // server has no other way to know: it is the Tauri shell that unpacked it.
        .env("SB_ADAPTORS_DIR", adaptor_dir(app))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                emit_log(&app, format!("[server] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                emit_log(&app, format!("[server] {line}"));
            }
        });
    }
    Ok(child)
}

/// Bring the app back from every state it can be put into without quitting.
///
/// `window.show()` alone is not enough, and the gap is easy to miss: Tauri's generated macOS menu
/// includes Hide (Cmd+H), which hides the whole *application*. Showing and focusing a window does
/// not undo that -- `makeKeyAndOrderFront` has no effect while the app itself is hidden -- so
/// without `app.show()` the tray's own "Open Second Brain" appears to do nothing at all.
/// `unminimize` covers the other half: a minimised window is not a hidden one.
fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Reopens the setup screen from the tray, as its own window rather than navigating the main one
/// away from the app the user is presumably using. It hydrates from `setup_state` on load, so it
/// shows current progress rather than the empty screen a fresh page would otherwise start from.
fn show_setup_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "setup",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Second Brain Setup")
    .inner_size(620.0, 560.0)
    .resizable(true)
    .build();
}

/// Everything from "get the code onto disk" to "the server answers" -- run only once the
/// frontend has confirmed it is actually listening (see `frontend_ready` below), never from
/// `setup()` directly: that races the webview's own page load, and a `setup-log`/`setup-ready`
/// event emitted before `dist/index.html`'s `listen()` calls have registered is simply gone --
/// Tauri does not buffer events for a listener that shows up late. Found this the hard way: the
/// very first end-to-end run sat on "Starting." forever despite the Rust side finishing cleanly.
fn start_bringup(handle: AppHandle) {
    {
        let state = handle.state::<BringupStarted>();
        let mut started = state.0.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
    }
    std::thread::spawn(move || {
        emit_step(&handle, "install", "active");
        let (dir, already_installed) = match ensure_code_installed(&handle) {
            Ok(result) => result,
            Err(e) => {
                emit_step(&handle, "install", "error");
                emit_log(&handle, format!("Could not install the app's files: {e}"));
                return;
            }
        };
        // Never fatal: a missing or unreadable adaptor costs the Slack reader, not the app.
        if let Err(e) = ensure_adaptor_installed(&handle) {
            emit_log(&handle, format!("Could not unpack the Chrome adaptor: {e}"));
        }
        emit_step(&handle, "install", "done");

        if !port_is_open(PORT) {
            emit_step(&handle, "server", "active");
            emit_log(&handle, "Preparing the data directory...");
            match run_script(&handle, &dir, "bootstrap") {
                Ok(true) => {}
                Ok(false) => emit_log(&handle, "Bootstrap reported a problem -- check the details. Starting the server anyway."),
                Err(e) => emit_log(&handle, format!("Could not run bootstrap: {e}")),
            }

            match spawn_server(&handle, &dir) {
                Ok(child) => {
                    handle.state::<ServerProcess>().0.lock().unwrap().replace(child);
                }
                Err(e) => {
                    emit_step(&handle, "server", "error");
                    emit_log(&handle, format!("Could not start the server: {e}"));
                    return;
                }
            }
        } else {
            // Something else already holds the port -- almost always the CLI-managed launchd
            // agent. Adopting it keeps two servers from fighting over 3141, but it quietly
            // changes what this app can do: the recorder and helpers are then spawned by that
            // other process tree, which has no GUI app for macOS to attribute a permission
            // request to, so the microphone and calendar prompts can never appear and this
            // app's Info.plist usage descriptions never come into play. Looking healthy while
            // recording is structurally impossible is worse than saying so.
            emit_step(&handle, "server", "active");
            emit_log(
                &handle,
                format!(
                    "A server was already running on port {PORT}, so this app is showing that one rather than starting its own.                      Permission prompts (microphone, calendar) belong to whichever process started it -- if that is the                      command-line install, run `scripts/brain.sh stop` and reopen this app so it owns the server and can ask."
                ),
            );
        }

        emit_log(&handle, "Waiting for the server to answer...");
        let mut answered = false;
        for _ in 0..600 {
            if port_is_open(PORT) {
                answered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if !answered {
            emit_step(&handle, "server", "error");
            emit_log(&handle, "The server did not answer within 5 minutes. Check the details.");
            return;
        }
        emit_step(&handle, "server", "done");

        // The app is usable from here on. `already_installed` decides whether the setup screen
        // continues straight through (nothing to watch -- assets were fetched on an earlier run)
        // or waits for the user, since a first run is about to pull several GB and that progress
        // is worth showing rather than hiding behind an app that half-works.
        let url = format!("http://127.0.0.1:{PORT}");
        handle.state::<SetupStateStore>().0.lock().unwrap().url = Some(url.clone());
        let _ = handle.emit(
            "setup-ready",
            serde_json::json!({ "url": url, "autoContinue": already_installed }),
        );

        // Models, llama.cpp and the Swift binaries -- the multi-GB half. Deliberately after the
        // server is up and the user has a working app, not before it. Every step degrades to
        // "that feature stays off" on failure, so nothing here can keep the app from running.
        emit_step(&handle, "assets", "active");
        set_tray_status(&handle, "Downloading models…");
        match run_script(&handle, &dir, "fetch-assets") {
            Ok(true) => {
                emit_step(&handle, "assets", "done");
                set_tray_status(&handle, "All models ready");
            }
            Ok(false) => {
                emit_step(&handle, "assets", "error");
                set_tray_status(&handle, "Some models missing");
                emit_log(&handle, "Some assets did not finish. Those features stay off until they do -- reopen Setup from the tray to retry.");
            }
            Err(e) => {
                emit_step(&handle, "assets", "error");
                set_tray_status(&handle, "Some models missing");
                emit_log(&handle, format!("Could not fetch assets: {e}"));
            }
        }
    });
}

/// Called by `dist/index.html` the instant its `listen()` calls are registered -- the handshake
/// that makes the ordering above safe instead of hopeful.
#[tauri::command]
fn frontend_ready(app: AppHandle) {
    start_bringup(app);
}

/// What the setup screen hydrates from on load -- see `SetupState` for why a fresh page can't
/// just wait for events.
#[tauri::command]
fn setup_state(app: AppHandle) -> SetupState {
    app.state::<SetupStateStore>().0.lock().unwrap().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    adopt_user_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (double-clicking the app again, or a login-item relaunch racing
            // one already running) means "bring the existing window forward", never a second
            // server process fighting the first one for the same port.
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(ServerProcess(Mutex::new(None)))
        .manage(BringupStarted(Mutex::new(false)))
        .manage(TrayStatus(Mutex::new(None)))
        .manage(SetupStateStore(Mutex::new(SetupState::default())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Disabled on purpose: a status line, not a button. `set_tray_status` keeps its text
            // current while assets download in the background, which is the only place that
            // progress is visible once the window has moved on to the app itself.
            let status_item =
                MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Second Brain", true, None::<&str>)?;
            let setup_item = MenuItem::with_id(app, "setup", "Setup Progress", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu =
                Menu::with_items(app, &[&status_item, &open_item, &setup_item, &quit_item])?;
            app.state::<TrayStatus>().0.lock().unwrap().replace(status_item);
            // This is the only tray, and it has to stay that way. A `trayIcon` block in
            // tauri.conf.json makes Tauri build its own status item during `build()`
            // (tauri/src/app.rs, "initialize default tray icon if defined") with no menu and no
            // handlers -- so the menu bar showed the same glyph twice, one of them completely
            // inert, and clicking the wrong one looked exactly like a dead tray. That block is
            // gone from the config; `icon_as_template` was the one setting worth keeping from it,
            // so it lives here now. Do not reintroduce it there.
            TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "setup" => show_setup_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The autostart plugin manages its own login-item registration; enabling it here
            // (rather than leaving it off until asked) matches the always-on behaviour the
            // CLI-managed launchd install already has -- the whole point of owning the process
            // directly instead of quitting when the window closes.
            use tauri_plugin_autostart::ManagerExt;
            let _ = app.autolaunch().enable();

            // A watchdog, not the primary trigger: `frontend_ready` (called from dist/index.html)
            // is what normally starts bringup, right after the page's listeners are registered.
            // This just guards against a webview that never finishes loading for some reason,
            // so the app doesn't sit doing nothing forever with no log line to explain why.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                start_bringup(handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![frontend_ready, setup_state])
        .on_window_event(|window, event| {
            // Closing the window is not quitting the app: the server (and, once minimised,
            // activity tracking and auto-recording) keeps running from the tray, exactly the
            // always-on behaviour the CLI-managed launchd install already has -- just owned by
            // this one process instead of a second, independent one.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Clicking the Dock icon of a running app whose windows are all hidden, and
            // double-clicking the app in Finder, both arrive here rather than starting a second
            // process -- macOS sends `applicationShouldHandleReopen`, which Tauri surfaces as
            // this. Unhandled, the app activates (the menu bar changes) and no window ever
            // appears, which is indistinguishable from the app being broken. It also means the
            // single-instance plugin's "bring the existing window forward" callback never fires
            // for the gesture a Mac user actually makes.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(app_handle),
            RunEvent::Exit => {
                if let Some(mut child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
