//! Local screen-and-input endpoint for the soul server (general "computer use").
//!
//! Listens ONLY on 127.0.0.1 and requires a random bearer token that is handed to the server process we spawn,
//! so websites and other programs cannot drive the mouse. The server asks the user to approve every click,
//! keystroke and typed text before calling it.
//!
//!   GET  /screen?max=1280&monitor=0&mx=x&my=y  JPEG of a monitor, downscaled; optional red crosshair at (x,y)
//!                                               (in the downscaled image's coordinates). Headers X-Image-Size,
//!                                               X-Capture-Size, X-Origin describe the mapping.
//!   POST /input   {"action":"click","x":..,"y":..,"button":"left","double":false}   physical screen pixels
//!                 {"action":"move","x":..,"y":..} | {"action":"type","text":".."}
//!                 {"action":"key","keys":["ctrl","s"]} | {"action":"scroll","x":..,"y":..,"amount":3}

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Cursor, Read};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, Rgba, RgbaImage};
use tiny_http::{Header, Method, Request, Response, Server};
use xcap::Monitor;

pub struct ControlInfo {
    pub url: String,
    pub token: String,
}

/// 256-bit token from the OS-seeded hasher keys (no extra crate needed).
fn random_token() -> String {
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0));
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Starts the endpoint on a background thread. Port/token can be fixed with WAIFU_DESKTOP_PORT/TOKEN (tests).
pub fn start() -> std::io::Result<ControlInfo> {
    #[cfg(windows)]
    {
        // Physical pixels everywhere, so screenshot coordinates and cursor coordinates agree on scaled displays.
        let _ = enigo::set_dpi_awareness();
    }
    let port: u16 = std::env::var("WAIFU_DESKTOP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let token = std::env::var("WAIFU_DESKTOP_TOKEN").ok().filter(|t| t.len() >= 16).unwrap_or_else(random_token);
    let server = Server::http(("127.0.0.1", port)).map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    let expected = format!("Bearer {token}");
    std::thread::spawn(move || {
        // One input connection for the whole session: on X11 a dropped connection discards key events that are
        // still scheduled and un-maps the keys it had mapped, which lost characters when it was per request.
        let mut enigo: Option<Enigo> = None;
        for req in server.incoming_requests() {
            handle(req, &expected, &mut enigo);
        }
    });
    Ok(ControlInfo { url: format!("http://127.0.0.1:{port}"), token })
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn reply(req: Request, status: u16, body: &str) {
    let _ = req.respond(Response::from_string(body).with_status_code(status).with_header(header("Content-Type", "application/json")));
}

/// Constant-time comparison so the token cannot be guessed byte by byte through timing.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(mut req: Request, expected: &str, enigo: &mut Option<Enigo>) {
    let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str().to_string()).unwrap_or_default();
    // Browsers always send Origin on cross-site requests; this endpoint is for the local server only.
    let from_browser = req.headers().iter().any(|h| h.field.equiv("Origin"));
    if from_browser || !same(auth.as_bytes(), expected.as_bytes()) {
        return reply(req, 403, r#"{"error":"forbidden"}"#);
    }
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let result = match (req.method(), path) {
        (Method::Get, "/screen") => match screen(query) {
            Ok((jpeg, img_w, img_h, cap_w, cap_h, ox, oy)) => {
                let resp = Response::from_data(jpeg)
                    .with_header(header("Content-Type", "image/jpeg"))
                    .with_header(header("X-Image-Size", &format!("{img_w}x{img_h}")))
                    .with_header(header("X-Capture-Size", &format!("{cap_w}x{cap_h}")))
                    .with_header(header("X-Origin", &format!("{ox},{oy}")));
                let _ = req.respond(resp);
                return;
            }
            Err(e) => Err(e),
        },
        (Method::Get, "/monitors") => monitors(),
        (Method::Post, "/input") => {
            let mut body = String::new();
            if req.as_reader().take(64 * 1024).read_to_string(&mut body).is_err() {
                Err("unreadable body".to_string())
            } else {
                input(&body, enigo)
            }
        }
        _ => Err("not found".to_string()),
    };
    match result {
        Ok(json) => reply(req, 200, &json),
        Err(e) => reply(req, 400, &serde_json::json!({ "error": e }).to_string()),
    }
}

fn param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
}

fn pick_monitor(index: Option<usize>) -> Result<Monitor, String> {
    let all = Monitor::all().map_err(|e| format!("cannot list monitors: {e}"))?;
    match index {
        Some(i) => all.into_iter().nth(i).ok_or_else(|| format!("monitor {i} does not exist")),
        None => {
            let primary = all.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0);
            all.into_iter().nth(primary).ok_or_else(|| "no monitor found".to_string())
        }
    }
}

type Shot = (Vec<u8>, u32, u32, u32, u32, i32, i32);

fn screen(query: &str) -> Result<Shot, String> {
    let max: u32 = param(query, "max").and_then(|v| v.parse().ok()).unwrap_or(1280).clamp(320, 3840);
    let monitor = pick_monitor(param(query, "monitor").and_then(|v| v.parse().ok()))?;
    let captured: RgbaImage = monitor.capture_image().map_err(|e| format!("capture failed: {e}"))?;
    let (cw, ch) = captured.dimensions();
    let scale = (max as f32 / cw.max(ch) as f32).min(1.0);
    let (w, h) = (((cw as f32) * scale).round().max(1.0) as u32, ((ch as f32) * scale).round().max(1.0) as u32);
    let mut img = if scale < 1.0 { image::imageops::resize(&captured, w, h, FilterType::Triangle) } else { captured };
    let coord = |k: &str| param(query, k).and_then(|v| v.parse::<f64>().ok()).map(|f| f.round() as i64);
    if let (Some(mx), Some(my)) = (coord("mx"), coord("my")) {
        draw_mark(&mut img, mx, my);
    }
    let rgb = DynamicImage::ImageRgba8(img).to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut Cursor::new(&mut jpeg), 70).encode_image(&rgb).map_err(|e| e.to_string())?;
    Ok((jpeg, w, h, cw, ch, monitor.x().unwrap_or(0), monitor.y().unwrap_or(0)))
}

/// Red crosshair with a ring, so the user sees exactly where she wants to click.
fn draw_mark(img: &mut RgbaImage, x: i64, y: i64) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let red = Rgba([255, 30, 70, 255]);
    let mut put = |px: i64, py: i64| {
        if px >= 0 && py >= 0 && px < w && py < h {
            img.put_pixel(px as u32, py as u32, red);
        }
    };
    for d in -22..=22i64 {
        for t in -1..=1i64 {
            if d.abs() > 6 {
                put(x + d, y + t);
                put(x + t, y + d);
            }
        }
    }
    for a in 0..360 {
        let r = (a as f64).to_radians();
        for rad in [12.0f64, 13.0] {
            put(x + (rad * r.cos()).round() as i64, y + (rad * r.sin()).round() as i64);
        }
    }
}

fn monitors() -> Result<String, String> {
    let all = Monitor::all().map_err(|e| e.to_string())?;
    let list: Vec<_> = all
        .iter()
        .enumerate()
        .map(|(i, m)| serde_json::json!({ "index": i, "name": m.name().unwrap_or_default(), "primary": m.is_primary().unwrap_or(false),
            "x": m.x().unwrap_or(0), "y": m.y().unwrap_or(0), "width": m.width().unwrap_or(0), "height": m.height().unwrap_or(0) }))
        .collect();
    Ok(serde_json::Value::Array(list).to_string())
}

fn key_from(name: &str) -> Result<Key, String> {
    let n = name.trim().to_lowercase();
    Ok(match n.as_str() {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
        "win" | "meta" | "cmd" | "super" | "windows" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4, "f5" => Key::F5, "f6" => Key::F6,
        "f7" => Key::F7, "f8" => Key::F8, "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        _ => {
            let mut chars = n.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c),
                _ => return Err(format!("unknown key \"{name}\"")),
            }
        }
    })
}

fn num(v: &serde_json::Value, k: &str) -> Result<i32, String> {
    v.get(k).and_then(|x| x.as_f64()).map(|f| f.round() as i32).ok_or_else(|| format!("missing number \"{k}\""))
}

fn input(body: &str, slot: &mut Option<Enigo>) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("bad JSON: {e}"))?;
    if slot.is_none() {
        *slot = Some(Enigo::new(&Settings::default()).map_err(|e| format!("input unavailable: {e}"))?);
    }
    let enigo = slot.as_mut().expect("just created");
    let result = run_input(&v, enigo);
    if result.is_err() {
        *slot = None; // reconnect next time (e.g. display or session changed)
    }
    result
}

fn run_input(v: &serde_json::Value, enigo: &mut Enigo) -> Result<String, String> {
    let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
    let err = |e: enigo::InputError| e.to_string();
    match action {
        "move" | "click" => {
            enigo.move_mouse(num(v, "x")?, num(v, "y")?, Coordinate::Abs).map_err(err)?;
            if action == "click" {
                let button = match v.get("button").and_then(|b| b.as_str()).unwrap_or("left") {
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    _ => Button::Left,
                };
                let times = if v.get("double").and_then(|d| d.as_bool()).unwrap_or(false) { 2 } else { 1 };
                for _ in 0..times {
                    enigo.button(button, Direction::Click).map_err(err)?;
                }
            }
        }
        "type" => {
            let text = v.get("text").and_then(|t| t.as_str()).ok_or("missing \"text\"")?;
            if text.chars().count() > 5000 {
                return Err("text too long".into());
            }
            enigo.text(text).map_err(err)?;
        }
        "key" => {
            let keys: Vec<Key> = v.get("keys").and_then(|k| k.as_array()).ok_or("missing \"keys\"")?.iter().map(|k| key_from(k.as_str().unwrap_or(""))).collect::<Result<_, _>>()?;
            let (last, mods) = keys.split_last().ok_or("no keys")?;
            for m in mods {
                enigo.key(*m, Direction::Press).map_err(err)?;
            }
            let r = enigo.key(*last, Direction::Click).map_err(err);
            for m in mods.iter().rev() {
                let _ = enigo.key(*m, Direction::Release); // always release modifiers, even after an error
            }
            r?;
        }
        "scroll" => {
            if v.get("x").is_some() {
                enigo.move_mouse(num(v, "x")?, num(v, "y")?, Coordinate::Abs).map_err(err)?;
            }
            enigo.scroll(num(v, "amount")?.clamp(-50, 50), Axis::Vertical).map_err(err)?;
        }
        "location" => {}
        _ => return Err(format!("unknown action \"{action}\"")),
    }
    // Let scheduled events reach the focused app before answering (the next screenshot should show the result).
    // After a click, also give the target time to take keyboard focus before the next action types into it.
    let typed = v.get("text").and_then(|t| t.as_str()).map(|t| t.chars().count()).unwrap_or(0) as u64;
    let settle = if action == "click" { 250 } else { 60 };
    std::thread::sleep(Duration::from_millis((settle + typed * 15).min(4000)));
    let (x, y) = enigo.location().unwrap_or((0, 0));
    Ok(serde_json::json!({ "ok": true, "cursor": [x, y] }).to_string())
}
