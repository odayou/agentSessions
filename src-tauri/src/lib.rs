// lib.rs —— Tauri 主进程：启动时拉起 Node 解析桥(server.js) 子进程，退出时收尾
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const BRIDGE_PORT: &str = "18778";

// 保存子进程句柄，便于退出时回收
struct BridgeState(Mutex<Option<Child>>);

// 后端三元组 (node 可执行, server.js, 工作目录)：
// dev 走仓库根 + 系统 node；prod 走打包进资源目录的自包含 backend/（自带 node.exe，
// 由根目录 scripts/pack-backend.js 生成，见 tauri.conf.json 的 resources/beforeBuildCommand）
fn resolve_backend(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    {
        // Cargo 编译目录在 src-tauri，仓库根为其上一级
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        Ok((PathBuf::from("node"), repo.join("server.js"), repo))
    }
    #[cfg(not(debug_assertions))]
    {
        let backend = app
            .path()
            .resource_dir()
            .map_err(|e| format!("资源目录定位失败：{e}"))?
            .join("backend");
        Ok((backend.join("node.exe"), backend.join("server.js"), backend))
    }
}

// 启动 Node 桥：node server.js（端口占用时子进程自然退出，前端回落到已在跑的桥）
fn spawn_bridge(app: &tauri::AppHandle) -> Result<Child, String> {
    let (node, script, cwd) = resolve_backend(app)?;
    let script_str = script
        .to_str()
        .ok_or_else(|| "无法解析 server.js 路径".to_string())?
        .to_string();
    let node_str = node
        .to_str()
        .ok_or_else(|| "无法解析 node 路径".to_string())?
        .to_string();
    if !script.exists() {
        return Err(format!("未找到桥脚本：{}", script.display()));
    }
    if !node.exists() {
        return Err(format!("未找到 node 可执行文件：{}", node.display()));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new(&node_str);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(&node_str);

    cmd.arg(&script_str)
        .current_dir(&cwd)
        .env("AGENTSESSIONS_PORT", BRIDGE_PORT)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 Node 桥失败：{e}"))
}

fn kill_bridge(state: &BridgeState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// 开发者工具开关（前端 F12 / Ctrl+Shift+I / 设置页按钮调用；release 需 devtools 特性）
#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![toggle_devtools])
        .setup(|app| {
            let child = spawn_bridge(app.handle());
            match child {
                Ok(c) => {
                    app.manage(BridgeState(Mutex::new(Some(c))));
                    println!("[agentsessions] Node 桥已启动 (port {BRIDGE_PORT})");
                }
                Err(e) => {
                    // 桥启动失败不阻塞 UI：前端会显示离线提示
                    app.manage(BridgeState(Mutex::new(None)));
                    eprintln!("[agentsessions] {e}（前端将提示后端离线）");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BridgeState>() {
                    kill_bridge(&state);
                }
            }
        });
}