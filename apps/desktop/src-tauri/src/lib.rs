//! Desktop shell: starts (or reuses) the local soul server, shows its web UI in a native window and adds a
//! global push-to-talk shortcut. All the actual logic stays in the server and the web app.

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

/// Finds the repository root: $WAIFU_ROOT, or the nearest ancestor of the executable / cwd containing the server.
fn find_root() -> Option<PathBuf> {
    if let Ok(r) = std::env::var("WAIFU_ROOT") {
        return Some(PathBuf::from(r));
    }
    let marker = ["packages", "server", "src", "index.ts"];
    let starts = [std::env::current_exe().ok(), std::env::current_dir().ok()];
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

fn spawn_server(root: &PathBuf) -> std::io::Result<Child> {
    // `node --import tsx` runs the TypeScript server directly (the same thing `npm run start` does),
    // and lets us kill the actual server process on exit instead of an npm wrapper.
    let mut cmd = Command::new(std::env::var("WAIFU_NODE").unwrap_or_else(|_| "node".into()));
    cmd.args(["--import", "tsx", "src/index.ts"])
        .current_dir(root.join("packages").join("server"))
        // The server exits by itself if this process disappears (crash, force quit), so it is never orphaned.
        .env("WAIFU_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
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
                })
                .build(),
        )
        .manage(ServerProc(Mutex::new(None)))
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(toggle) {
                eprintln!("could not register Ctrl+Shift+Space: {e}"); // e.g. already taken by another app
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if !port_open(PORT) {
                    match find_root() {
                        None => return show_error(&handle, "No encuentro el proyecto (carpeta con packages/server). Define WAIFU_ROOT."),
                        Some(root) => {
                            if !root.join("apps").join("web").join("dist").join("index.html").exists() {
                                return show_error(&handle, "Falta compilar la web: ejecuta 'npm run build' en la carpeta del proyecto.");
                            }
                            match spawn_server(&root) {
                                Ok(child) => *handle.state::<ServerProc>().0.lock().unwrap() = Some(child),
                                Err(e) => return show_error(&handle, &format!("No pude iniciar el servidor (esta Node.js instalado?): {e}")),
                            }
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
