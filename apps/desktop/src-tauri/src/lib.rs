//! Desktop shell: starts (or reuses) the local soul server, shows its web UI in a native window and adds a
//! global push-to-talk shortcut. All the actual logic stays in the server and the web app.

mod control;

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PORT: u16 = 8787;

/// Server process we started (if the port was free). Killed when the app exits.
struct ServerProc(Mutex<Option<Child>>);

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Finds the repository root: $WAIFU_ROOT, or the nearest ancestor of the executable / cwd containing the server,
/// or else the folder the app was built from (so an installed .exe in Program Files still finds the project).
fn find_root() -> Option<PathBuf> {
    if let Ok(r) = std::env::var("WAIFU_ROOT") {
        return Some(PathBuf::from(r));
    }
    let marker = ["packages", "server", "src", "index.ts"];
    let built_from = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let starts = [std::env::current_exe().ok(), std::env::current_dir().ok(), built_from];
    for start in starts.into_iter().flatten() {
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            if marker.iter().fold(d.to_path_buf(), |p, s| p.join(s)).exists() {
                return Some(d.to_path_buf());
            }
            dir = d.parent();
        }
    }
    None
}

/// Where the server comes from: inside the installed app (its own Node.js + bundled server), or the project
/// folder during development (system Node.js + TypeScript sources).
enum Source {
    Bundled { app: PathBuf, home: PathBuf },
    Repo(PathBuf),
}

/// Windows resource paths can come back as `\\?\C:\...`; give Node a plain path.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// The installed app ships everything in `<resources>/app` (see scripts/bundle-app.mjs). Its data (your .env,
/// memory, logs, backups) goes to the per-user app data folder, because Program Files is read-only.
fn bundled(handle: &tauri::AppHandle) -> Option<Source> {
    let app = plain(handle.path().resource_dir().ok()?.join("app"));
    if !app.join("server").join("index.mjs").exists() {
        return None;
    }
    let home = plain(handle.path().app_data_dir().ok()?);
    Some(Source::Bundled { app, home })
}

fn spawn_server(source: &Source, control: Option<&control::ControlInfo>) -> std::io::Result<Child> {
    let mut cmd = match source {
        Source::Bundled { app, home } => {
            let node = app.join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut c = Command::new(node);
            c.arg(app.join("server").join("index.mjs"))
                .current_dir(app)
                .env("WAIFU_APP_DIR", app)
                .env("WAIFU_HOME", home);
            c
        }
        Source::Repo(root) => {
            // `node --import tsx` runs the TypeScript server directly (the same thing `npm run start` does),
            // and lets us kill the actual server process on exit instead of an npm wrapper.
            let mut c = Command::new(std::env::var("WAIFU_NODE").unwrap_or_else(|_| "node".into()));
            c.args(["--import", "tsx", "src/index.ts"]).current_dir(root.join("packages").join("server"));
            c
        }
    };
    // The server exits by itself if this process disappears (crash, force quit), so it is never orphaned.
    cmd.env("WAIFU_PARENT_PID", std::process::id().to_string()).stdin(Stdio::null());
    // Screen/mouse/keyboard endpoint for her "desktop" tools (every action still needs the user's approval).
    if let Some(c) = control {
        cmd.env("WAIFU_DESKTOP_URL", &c.url).env("WAIFU_DESKTOP_TOKEN", &c.token);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
}

/// First run of the installed app: show the settings file (.env) so the user can choose brain, voice and tools.
fn open_in_text_editor(path: &PathBuf) {
    #[cfg(windows)]
    let r = Command::new("notepad.exe").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-t").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(path).spawn();
    if let Err(e) = r {
        eprintln!("could not open {}: {e}", path.display());
    }
}

fn show_error(app: &tauri::AppHandle, message: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "document.getElementById('msg').textContent = {}; document.getElementById('msg').className = 'err';",
            serde_json_string(message)
        );
        let _ = w.eval(&js);
    }
}

/// Minimal JS string literal escaping (avoids pulling in serde_json just for this).
fn serde_json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn run() {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    // Takes the screen back from her ("Darle el control") from any program, even when her window is hidden.
    let revoke = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle && event.state() == ShortcutState::Pressed {
                        // Push-to-talk toggle: the web app listens for this event.
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("window.dispatchEvent(new CustomEvent('waifu:toggle-mic'))");
                        }
                    }
                    if shortcut == &revoke && event.state() == ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("window.dispatchEvent(new CustomEvent('waifu:revoke-control'))");
                        }
                    }
                })
                .build(),
        )
        .manage(ServerProc(Mutex::new(None)))
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(toggle) {
                eprintln!("could not register Ctrl+Shift+Space: {e}"); // e.g. already taken by another app
            }
            if let Err(e) = app.global_shortcut().register(revoke) {
                eprintln!("could not register Ctrl+Shift+X: {e}");
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut first_run_env: Option<PathBuf> = None;
                if !port_open(PORT) {
                    let source = match bundled(&handle) {
                        Some(b) => b,
                        None => match find_root() {
                            None => return show_error(&handle, "No encuentro el proyecto (carpeta con packages/server). Define WAIFU_ROOT."),
                            Some(root) => {
                                if !root.join("apps").join("web").join("dist").join("index.html").exists() {
                                    return show_error(&handle, "Falta compilar la web: ejecuta 'npm run build' en la carpeta del proyecto.");
                                }
                                Source::Repo(root)
                            }
                        },
                    };
                    if let Source::Bundled { home, .. } = &source {
                        let env = home.join(".env");
                        if !env.exists() {
                            first_run_env = Some(env); // the server creates it from env.example
                        }
                    }
                    let control = match control::start() {
                        Ok(c) => Some(c),
                        Err(e) => {
                            eprintln!("desktop control unavailable: {e}");
                            None
                        }
                    };
                    match spawn_server(&source, control.as_ref()) {
                        Ok(child) => *handle.state::<ServerProc>().0.lock().unwrap() = Some(child),
                        Err(e) => {
                            let hint = if matches!(source, Source::Repo(_)) { " (esta Node.js instalado?)" } else { "" };
                            return show_error(&handle, &format!("No pude iniciar el servidor{hint}: {e}"));
                        }
                    }
                }
                let start = Instant::now();
                while !port_open(PORT) {
                    if start.elapsed() > Duration::from_secs(60) {
                        return show_error(&handle, "El servidor no respondio en 60 s. Revisa la configuracion (.env, puerto 8787).");
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.eval(&format!("window.location.replace('http://127.0.0.1:{PORT}/')"));
                }
                if let Some(env) = first_run_env.filter(|e| e.exists()) {
                    open_in_text_editor(&env);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<ServerProc>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
