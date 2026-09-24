// Prevents an extra console window from appearing alongside the app on
// Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lunar_pad_lib::run()
}
