// main.rs —— 各平台入口统一调用 run()
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentsessions_lib::run()
}