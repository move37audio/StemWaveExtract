use serde::{Deserialize, Serialize};
use std::os::unix::process::CommandExt;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

mod waveform;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Progress {
    stage: String,
    progress: f64,
    elapsed_seconds: f64,
    eta_seconds: Option<f64>,
    message: String,
    output_path: Option<String>,
    status: String,
    /// Exported WAVs, set by the app (never the worker) once the folder is verified.
    #[serde(default)]
    files: Vec<String>,
}
impl Progress {
    fn starting() -> Self {
        Self {
            stage: "starting".into(),
            progress: 0.,
            elapsed_seconds: 0.,
            eta_seconds: None,
            message: "Preparing the extraction engine…".into(),
            output_path: None,
            status: "running".into(),
            files: Vec::new(),
        }
    }
    fn validate(&self) -> bool {
        self.progress.is_finite()
            && (0.0..=1.0).contains(&self.progress)
            && self.elapsed_seconds.is_finite()
            && self.elapsed_seconds >= 0.
            && self.eta_seconds.is_none_or(|n| n.is_finite() && n >= 0.)
            && matches!(
                self.status.as_str(),
                "running" | "complete" | "cancelled" | "error"
            )
            && self.stage.len() <= 100
            && self.message.len() <= 4096
    }
}
#[derive(Default)]
struct Job {
    id: u64,
    child: Option<Child>,
    status: Option<Progress>,
    working_dir: Option<PathBuf>,
    /// Files the UI may play or analyse: the chosen input and completed outputs.
    playable: HashSet<PathBuf>,
    /// Python, FFmpeg and models installed by first-run setup; `None` until then.
    runtime: Option<Runtime>,
    setting_up: bool,
}
#[derive(Clone, Default)]
struct AppState(Arc<Mutex<Job>>);

/// What first-run setup installed (engine/setup.sh writes ready.json last).
#[derive(Clone, Debug, Deserialize)]
struct Runtime {
    python: PathBuf,
    ffmpeg: PathBuf,
    #[serde(skip)]
    dir: PathBuf,
    #[serde(skip)]
    engine: PathBuf,
}
/// Bundled resources in a built app; the source tree during development.
fn bundled(app: &tauri::AppHandle, relative: &str, dev: &str) -> PathBuf {
    app.path()
        .resource_dir()
        .map(|d| d.join(relative))
        .ok()
        .filter(|p| p.exists())
        .unwrap_or_else(|| {
            #[cfg(debug_assertions)]
            { Path::new(env!("CARGO_MANIFEST_DIR")).join(dev) }
            #[cfg(not(debug_assertions))]
            { let _ = dev; PathBuf::from(relative) }
        })
}
fn runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}
fn bundled_runtime(resources: &Path) -> Option<Runtime> {
    let dir = resources.join("runtime");
    let python = dir.join("python/bin/python3.10");
    let ffmpeg = dir.join("bin/ffmpeg");
    let engine = resources.join("engine");
    let files = [&python, &ffmpeg, &dir.join("models/BS-Rofo-SW-Fixed.ckpt"),
        &dir.join("models/BS-Rofo-SW-Fixed.yaml"), &dir.join("models/beat_this-final0.ckpt"),
        &engine.join("separate.py")];
    files.iter().all(|p| p.is_file()).then_some(Runtime { python, ffmpeg, dir, engine })
}
fn load_runtime(app: &tauri::AppHandle) -> Option<Runtime> {
    if let Some(runtime) = app.path().resource_dir().ok().and_then(|p| bundled_runtime(&p)) {
        return Some(runtime);
    }
    let dir = runtime_dir(app).ok()?;
    let mut runtime: Runtime = serde_json::from_slice(&fs::read(dir.join("ready.json")).ok()?).ok()?;
    (runtime.python.is_file() && runtime.ffmpeg.is_file()).then_some(())?;
    runtime.dir = dir;
    runtime.engine = bundled(app, "engine", "../engine");
    Some(runtime)
}
fn runtime(state: &AppState) -> Result<Runtime, String> {
    state.0.lock().unwrap().runtime.clone().ok_or_else(|| "Finish setup first.".into())
}
/// Engine commands get the runtime's locations through the environment.
fn engine_command(rt: &Runtime, script: &str) -> Command {
    let mut command = Command::new(&rt.python);
    command.args(["-I", "-B"]).arg(rt.engine.join(script)).env("STEMWAVE_RUNTIME", &rt.dir).env("STEMWAVE_FFMPEG", &rt.ffmpeg).env("PYTHONDONTWRITEBYTECODE", "1");
    command
}
#[tauri::command]
fn runtime_status(state: tauri::State<AppState>) -> bool {
    state.0.lock().unwrap().runtime.is_some()
}
/// Runs engine/setup.sh with the bundled uv, relaying its STEP lines as "setup-progress" events.
#[tauri::command]
async fn setup_runtime(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    {
        let mut job = state.0.lock().unwrap();
        if job.runtime.is_some() {
            return Ok(());
        }
        if job.setting_up {
            return Err("Setup is already running.".into());
        }
        job.setting_up = true;
    }
    let shared = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<(), String> {
            use std::io::BufRead;
            let dir = runtime_dir(&app)?;
            fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the app's support folder: {e}"))?;
            let mut child = Command::new("/bin/bash")
                .arg(bundled(&app, "engine/setup.sh", "../engine/setup.sh"))
                .env("STEMWAVE_RUNTIME", &dir)
                .env("UV", bundled(&app, "bin/uv", "../vendor/uv"))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Cannot start setup: {e}"))?;
            let mut error = None;
            for line in std::io::BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
                if let Some(message) = line.strip_prefix("ERROR ") {
                    error = Some(message.to_string());
                }
                let _ = app.emit("setup-progress", line);
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                let mut stderr = String::new();
                let _ = std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr);
                let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return Err(error.unwrap_or(if last.is_empty() { "Setup failed. Check the internet connection and try again.".into() } else { format!("Setup failed: {last}") }));
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut job = shared.0.lock().unwrap();
    job.setting_up = false;
    result?;
    job.runtime = Some(load_runtime(&app).ok_or("Setup finished but the runtime is incomplete. Try again.")?);
    Ok(())
}
fn valid_output(output: &str) -> bool {
    matches!(
        output,
        "acapella" | "instrumental" | "bass" | "drums" | "other" | "vocals" | "guitar" | "piano"
    )
}
fn completed_path(status: &Progress, parent: &Path) -> Option<PathBuf> {
    status
        .output_path
        .as_ref()
        .and_then(|p| fs::canonicalize(p).ok())
        // A fresh subfolder of the chosen folder, or the chosen folder itself (no-subfolder naming).
        .filter(|p| p.is_dir() && (p.parent() == Some(parent) || p == parent))
}
fn emit(app: &tauri::AppHandle, status: &Progress) {
    let _ = app.emit("extraction-progress", status);
}
fn read_progress(path: &Path) -> Option<Progress> {
    if fs::metadata(path).ok()?.len() > 65536 {
        return None;
    }
    let result: Progress = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    result.validate().then_some(result)
}

fn allow_playback(app: &tauri::AppHandle, job: &mut Job, path: &Path) {
    let _ = app.asset_protocol_scope().allow_file(path);
    job.playable.insert(path.to_path_buf());
}
/// The worker's reported file names, accepted only as existing WAVs directly inside `folder`.
fn exported_files(folder: &Path, names: &[String]) -> Option<Vec<PathBuf>> {
    names
        .iter()
        .map(|name| {
            let single = !name.is_empty() && Path::new(name).file_name().is_some_and(|n| n == name.as_str());
            let path = fs::canonicalize(folder.join(name)).ok()?;
            (single && path.is_file() && path.parent() == Some(folder) && path.extension().is_some_and(|e| e == "wav")).then_some(path)
        })
        .collect::<Option<Vec<_>>>()
        .filter(|files| !files.is_empty())
}
#[tauri::command]
fn choose_input(app: tauri::AppHandle, state: tauri::State<AppState>) -> Option<String> {
    let path = rfd::FileDialog::new()
        .set_title("Choose audio")
        .add_filter(
            "Audio",
            &AUDIO_EXTENSIONS,
        )
        .pick_file()?;
    let path = fs::canonicalize(path).ok()?;
    allow_playback(&app, &mut state.0.lock().unwrap(), &path);
    Some(path.to_string_lossy().into_owned())
}
/// Decodes with FFmpeg and runs the six-band spectral analysis off the UI thread.
#[tauri::command]
async fn analyze_waveform(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !state.0.lock().unwrap().playable.contains(&path) {
        return Err("Only the chosen track and its extracted stems can be shown.".into());
    }
    let ffmpeg = runtime(&state)?.ffmpeg;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&ffmpeg)
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(&path)
            .args([
                "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "44100", "-f", "f32le", "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start the audio decoder: {e}"))?;
        let result = waveform::analyze(child.stdout.as_mut().unwrap(), 44100 * 600);
        if result.is_err() {
            let _ = child.kill();
        }
        let decoded = child.wait().is_ok_and(|s| s.success());
        match result {
            Ok(data) if decoded && !data.is_empty() => Ok(tauri::ipc::Response::new(data)),
            Err(error) => Err(error.to_string()),
            _ => Err("This file could not be decoded for the waveform.".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "aif", "aiff", "flac", "mp3", "m4a", "ogg"];
/// A file dropped on the window: accepted like a picked file when it is local audio.
#[tauri::command]
fn open_audio(app: tauri::AppHandle, state: tauri::State<AppState>, path: String) -> Result<String, String> {
    let path = fs::canonicalize(path).map_err(|_| "That file is unavailable.")?;
    let audio = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if !path.is_file() || !audio {
        return Err("Drop a WAV, AIFF, FLAC, MP3, M4A or Ogg file.".into());
    }
    allow_playback(&app, &mut state.0.lock().unwrap(), &path);
    Ok(path.to_string_lossy().into_owned())
}
/// A loop region in seconds, validated.
fn region(start: Option<f64>, end: Option<f64>) -> Result<Option<(f64, f64)>, String> {
    match (start, end) {
        (None, None) => Ok(None),
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() && a >= 0. && b > a && b - a <= 600. => Ok(Some((a, b))),
        _ => Err("That loop region isn't valid.".into()),
    }
}
/// Writes `source` (or just `range` of it, as float32 WAV) to `target`.
fn write_export(ffmpeg: &Path, source: &Path, target: &Path, range: Option<(f64, f64)>, replace: bool) -> Result<(), String> {
    // FFmpeg's -n still exits 0 when the file exists, so refuse here.
    if !replace && (target.exists() || target.is_symlink()) {
        return Err(format!("{} already exists.", target.file_name().unwrap_or_default().to_string_lossy()));
    }
    let Some((start, end)) = range else {
        return fs::copy(source, target).map(|_| ()).map_err(|e| format!("Couldn't save the stem: {e}"));
    };
    let status = Command::new(ffmpeg)
        .args(["-nostdin", "-v", "error", if replace { "-y" } else { "-n" }, "-i"])
        .arg(source)
        // Output-side seek decodes from the start, so the cut is sample-accurate.
        .args(["-ss", &format!("{start:.6}"), "-to", &format!("{end:.6}"), "-map", "0:a:0", "-c:a", "pcm_f32le"])
        .arg(target)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("Cannot start the exporter: {e}"))?;
    if status.success() { Ok(()) } else { Err("Couldn't write the exported audio.".into()) }
}
fn exportable(state: &AppState, path: &str) -> bool {
    state.0.lock().unwrap().playable.contains(&PathBuf::from(path))
}
/// Saves one lane (whole, or only the loop region) where the user chooses.
#[tauri::command]
fn export_stem(state: tauri::State<AppState>, path: String, start: Option<f64>, end: Option<f64>, label: Option<String>) -> Result<Option<String>, String> {
    let range = region(start, end)?;
    if !exportable(&state, &path) {
        return Err("Only the track and its stems can be exported.".into());
    }
    let source = PathBuf::from(&path);
    let stem = source.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match (&range, label) {
        (Some(_), Some(label)) => format!("{stem} ({}).wav", safe_label(&label)),
        _ => format!("{stem}.wav"),
    };
    let Some(target) = rfd::FileDialog::new().set_title("Export").set_file_name(&name).add_filter("WAV audio", &["wav"]).save_file() else {
        return Ok(None);
    };
    if target == source {
        return Ok(Some(path));
    }
    // The save panel already confirmed any replacement.
    write_export(&runtime(&state)?.ffmpeg, &source, &target, range, true)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}
/// Saves the loop region of several lanes into one chosen folder, never overwriting.
#[derive(Deserialize)]
struct LoopPart {
    path: String,
    start: f64,
    end: f64,
}
#[tauri::command]
fn export_loop(state: tauri::State<AppState>, parts: Vec<LoopPart>, label: String) -> Result<Option<String>, String> {
    // Each lane has its own range: stems extracted from a loop start at the loop, not at 0.
    let ranges = parts.iter().map(|p| region(Some(p.start), Some(p.end))).collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() || !parts.iter().all(|p| exportable(&state, &p.path)) {
        return Err("Only the track and its stems can be exported.".into());
    }
    let Some(folder) = rfd::FileDialog::new().set_title("Export loop to…").pick_folder() else {
        return Ok(None);
    };
    let label = safe_label(&label);
    let targets: Vec<(PathBuf, PathBuf)> = parts
        .iter()
        .map(|p| {
            let source = PathBuf::from(&p.path);
            let stem = source.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let target = folder.join(format!("{stem} ({label}).wav"));
            (source, target)
        })
        .collect();
    if let Some((_, existing)) = targets.iter().find(|(_, t)| t.exists()) {
        return Err(format!("{} already exists there.", existing.file_name().unwrap_or_default().to_string_lossy()));
    }
    let ffmpeg = runtime(&state)?.ffmpeg;
    for ((source, target), range) in targets.iter().zip(ranges) {
        write_export(&ffmpeg, source, target, range, false)?;
    }
    Ok(Some(folder.to_string_lossy().into_owned()))
}
/// A loop label for file names: letters, digits, spaces and - only.
fn safe_label(label: &str) -> String {
    let clean: String = label.chars().filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-')).take(40).collect();
    if clean.trim().is_empty() { "loop".into() } else { clean.trim().into() }
}
/// The file's embedded cover art (ID3 APIC, MP4 covr, FLAC picture) as raw image bytes; empty if none.
#[tauri::command]
async fn cover_art(state: tauri::State<'_, AppState>, path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !state.0.lock().unwrap().playable.contains(&path) {
        return Err("Only the chosen track can be read.".into());
    }
    let ffmpeg = runtime(&state)?.ffmpeg;
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(&ffmpeg)
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(&path)
            .args(["-an", "-map", "0:v:0", "-frames:v", "1", "-c", "copy", "-f", "image2pipe", "pipe:1"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("Cannot read cover art: {e}"))?;
        // No picture stream (or an oversized one) simply means no cover.
        let ok = output.status.success() && output.stdout.len() <= 16 << 20;
        Ok(tauri::ipc::Response::new(if ok { output.stdout } else { Vec::new() }))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Tempo and first downbeat from beats.py (beat_this), off the UI thread. `None` if no steady beat.
#[tauri::command]
async fn analyze_beats(state: tauri::State<'_, AppState>, path: String) -> Result<Option<serde_json::Value>, String> {
    let path = PathBuf::from(path);
    if !state.0.lock().unwrap().playable.contains(&path) {
        return Err("Only the chosen track can be analysed.".into());
    }
    let rt = runtime(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = engine_command(&rt, "beats.py")
            .arg(&path)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("Cannot start beat analysis: {e}"))?;
        if !output.status.success() {
            return Err("Beat analysis failed for this file.".into());
        }
        serde_json::from_slice::<Option<serde_json::Value>>(&output.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn choose_output() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Save extracted stems in…")
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Option<Progress> {
    state.0.lock().unwrap().status.clone()
}

#[tauri::command]
fn start_extraction(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    input: String,
    output: String,
    outputs: Vec<String>,
    mode: Option<String>,
    remainder: Option<bool>,
    naming: Option<String>,
    subfolder: Option<bool>,
    start: Option<f64>,
    end: Option<f64>,
    tag: Option<String>,
) -> Result<(), String> {
    let range = region(start, end)?;
    let tag = tag.filter(|_| range.is_some()).map(|t| safe_label(&t));
    let naming = naming.unwrap_or_else(|| "paren".into());
    if !matches!(naming.as_str(), "paren" | "dash" | "stem") {
        return Err("Choose a file naming style.".into());
    }
    let mode = mode.unwrap_or_else(|| "standard".into());
    if !matches!(mode.as_str(), "fast" | "standard" | "hq") {
        return Err("Choose Fast, Standard or HQ processing.".into());
    }
    let outputs: BTreeSet<String> = outputs.into_iter().collect();
    if outputs.is_empty() || !outputs.iter().all(|o| valid_output(o)) {
        return Err("Choose at least one output to extract.".into());
    }
    let outputs = outputs.into_iter().collect::<Vec<_>>().join(",");
    let input = fs::canonicalize(input).map_err(|_| "The input file is unavailable.")?;
    let output = fs::canonicalize(output).map_err(|_| "The output folder is unavailable.")?;
    if !input.is_file() || !output.is_dir() {
        return Err("Choose an audio file and an output folder.".into());
    }
    let mut job = state.0.lock().unwrap();
    if job.child.is_some() {
        return Err("An extraction is already running.".into());
    }
    let rt = job.runtime.clone().ok_or("Finish setup first.")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp =
        std::env::temp_dir().join(format!("stemwave-extract-{}-{stamp}", std::process::id()));
    fs::create_dir(&temp).map_err(|e| format!("Cannot create a working folder: {e}"))?;
    let progress_file = temp.join("progress.json");
    let diagnostics = runtime_dir(&app)?.join("diagnostics");
    fs::create_dir_all(&diagnostics).map_err(|e| e.to_string())?;
    let diagnostics = diagnostics.join("latest.json");
    fs::write(&diagnostics, b"{\"schema\":1,\"status\":\"starting\"}").map_err(|e| e.to_string())?;
    let launched = (|| -> std::io::Result<Child> {
        let log = fs::File::create(temp.join("worker.log"))?;
        engine_command(&rt, "separate.py")
            .env("STEMWAVE_DIAGNOSTICS", &diagnostics)
            .env("STEMWAVE_APP_VERSION", app.package_info().version.to_string())
            .arg(input)
            .arg(&output)
            .arg(outputs)
            .arg("--progress-file")
            .arg(&progress_file)
            .arg("--mode")
            .arg(&mode)
            .args(remainder.unwrap_or(false).then_some("--remainder"))
            .args(["--naming", naming.as_str()])
            .args((!subfolder.unwrap_or(true)).then_some("--no-subfolder"))
            .args(range.map(|(a, b)| ["--start".to_string(), format!("{a:.6}"), "--end".to_string(), format!("{b:.6}")]).into_iter().flatten())
            .args(tag.iter().flat_map(|t| ["--tag", t.as_str()]))
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .process_group(0)
            .spawn()
    })();
    let child = match launched {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp);
            return Err(format!("Cannot start extraction: {e}"));
        }
    };
    job.id += 1;
    let id = job.id;
    job.child = Some(child);
    job.working_dir = Some(temp.clone());
    let initial = Progress::starting();
    job.status = Some(initial.clone());
    emit(&app, &initial);
    let shared = state.inner().clone();
    drop(job);
    thread::spawn(move || {
        let started = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(250));
            let update = read_progress(&progress_file);
            let mut job = shared.0.lock().unwrap();
            if job.id != id || job.child.is_none() {
                break;
            }
            let exit = job.child.as_mut().unwrap().try_wait();
            match exit {
                Ok(Some(code)) => {
                    job.child = None;
                    job.working_dir = None;
                    let mut final_status = update
                        .unwrap_or_else(|| job.status.clone().unwrap_or_else(Progress::starting));
                    let completed_folder = completed_path(&final_status, &output);
                    if !(code.success()
                        && final_status.status == "complete"
                        && completed_folder.is_some())
                    {
                        if final_status.status != "error" {
                            final_status.message = "Extraction did not finish. Check the audio file and available memory, then try again.".into();
                        }
                        final_status.status = "error".into();
                        final_status.output_path = None;
                        final_status.files.clear();
                        final_status.stage = "error".into();
                    }
                    let reported = std::mem::take(&mut final_status.files);
                    if final_status.status == "complete" {
                        for file in exported_files(completed_folder.as_ref().unwrap(), &reported).unwrap_or_default() {
                            allow_playback(&app, &mut job, &file);
                            final_status.files.push(file.to_string_lossy().into_owned());
                        }
                        if final_status.files.is_empty() {
                            final_status.status = "error".into();
                            final_status.stage = "error".into();
                            final_status.message =
                                "The exported files are unavailable. Check the output drive."
                                    .into();
                            final_status.output_path = None;
                        }
                    }
                    final_status.elapsed_seconds = started.elapsed().as_secs_f64();
                    final_status.eta_seconds = None;
                    job.status = Some(final_status.clone());
                    emit(&app, &final_status);
                    break;
                }
                Err(error) => {
                    if let Some(mut child) = job.child.take() {
                        stop_child(&mut child);
                    }
                    let mut failed = job.status.clone().unwrap_or_else(Progress::starting);
                    failed.status = "error".into();
                    failed.stage = "error".into();
                    failed.message = format!("Cannot read extraction status: {error}");
                    failed.eta_seconds = None;
                    job.status = Some(failed.clone());
                    emit(&app, &failed);
                    break;
                }
                Ok(None) => {
                    if let Some(mut update) = update.or_else(|| job.status.clone()) {
                        // A completed file is authoritative only after its worker exits successfully.
                        if update.status != "running" {
                            continue;
                        }
                        if let Some(eta) = update.eta_seconds {
                            update.eta_seconds = Some(
                                (eta - (started.elapsed().as_secs_f64() - update.elapsed_seconds)
                                    .max(0.))
                                .max(0.),
                            );
                        }
                        update.elapsed_seconds = started.elapsed().as_secs_f64();
                        update.output_path = None;
                        update.files.clear();
                        if job.status.as_ref() != Some(&update) {
                            job.status = Some(update.clone());
                            emit(&app, &update);
                        }
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(temp);
    });
    Ok(())
}

fn stop_child(child: &mut Child) {
    let group = -(child.id() as i32);
    unsafe {
        libc::kill(group, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Kill any decoder descendants even if the parent has already exited.
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
    let _ = child.wait();
}
fn cancel(state: &AppState, app: &tauri::AppHandle) {
    let mut job = state.0.lock().unwrap();
    if let Some(mut child) = job.child.take() {
        stop_child(&mut child);
        if let Some(temp) = job.working_dir.take() {
            let _ = fs::remove_dir_all(temp);
        }
        let mut status = job.status.clone().unwrap_or_else(Progress::starting);
        status.status = "cancelled".into();
        status.stage = "cancelled".into();
        status.message = "Extraction cancelled.".into();
        status.eta_seconds = None;
        status.output_path = None;
        status.files.clear();
        job.status = Some(status.clone());
        emit(app, &status);
    }
}
#[tauri::command]
async fn cancel_extraction(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || cancel(&state, &app))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn reveal_output(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let job = state.0.lock().unwrap();
    let allowed = job
        .status
        .as_ref()
        .is_some_and(|s| s.status == "complete" && s.output_path.as_deref() == Some(path.as_str()));
    if !allowed {
        return Err("Only the completed extraction folder can be opened.".into());
    }
    let result = Command::new("/usr/bin/open")
        .arg("--")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if result.success() {
        Ok(())
    } else {
        Err("Finder could not open the output folder.".into())
    }
}
#[tauri::command]
fn export_diagnostics(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<bool, String> {
    let path = runtime_dir(&app)?.join("diagnostics/latest.json");
    let bytes = fs::read(path).map_err(|_| "Run an extraction first to create a diagnostic report.")?;
    let mut report: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "The diagnostic report is unavailable.")?;
    if let Some(status) = &state.0.lock().unwrap().status {
        report["app_status"] = serde_json::json!(status.status);
        report["app_elapsed_seconds"] = serde_json::json!(status.elapsed_seconds);
    }
    let Some(target) = rfd::FileDialog::new().set_title("Save diagnostic report")
        .set_file_name("StemWave-Extract-diagnostics.json").add_filter("Diagnostic report", &["json"]).save_file() else {
        return Ok(false);
    };
    let data = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(target, data).map_err(|e| e.to_string())?;
    Ok(true)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let runtime = load_runtime(app.handle());
            app.state::<AppState>().0.lock().unwrap().runtime = runtime;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            export_diagnostics,
            runtime_status,
            setup_runtime,
            choose_input,
            choose_output,
            start_extraction,
            cancel_extraction,
            reveal_output,
            get_status,
            analyze_waveform,
            analyze_beats,
            cover_art,
            open_audio,
            export_stem,
            export_loop
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize StemWave Extract")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                cancel(app.state::<AppState>().inner(), app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_runtime_is_relocatable_and_requires_all_resources() {
        let root = std::env::temp_dir().join(format!("stemwave-runtime-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(bundled_runtime(&root).is_none());
        for file in ["runtime/python/bin/python3.10", "runtime/bin/ffmpeg", "runtime/models/BS-Rofo-SW-Fixed.ckpt",
            "runtime/models/BS-Rofo-SW-Fixed.yaml", "runtime/models/beat_this-final0.ckpt", "engine/separate.py"] {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"fixture").unwrap();
        }
        assert_eq!(bundled_runtime(&root).unwrap().dir, root.join("runtime"));
        let moved = root.with_extension("moved");
        fs::rename(&root, &moved).unwrap();
        assert_eq!(bundled_runtime(&moved).unwrap().python, moved.join("runtime/python/bin/python3.10"));
        fs::remove_file(moved.join("runtime/models/beat_this-final0.ckpt")).unwrap();
        assert!(bundled_runtime(&moved).is_none());
        fs::remove_dir_all(moved).unwrap();
    }
    #[test]
    fn validates_worker_progress() {
        let mut p = Progress::starting();
        assert!(p.validate());
        p.progress = 1.1;
        assert!(!p.validate());
        p.progress = 0.5;
        p.eta_seconds = Some(-1.);
        assert!(!p.validate());
        p.eta_seconds = None;
        p.status = "invented".into();
        assert!(!p.validate());
    }
    #[test]
    fn only_known_outputs() {
        for output in [
            "acapella",
            "instrumental",
            "bass",
            "drums",
            "other",
            "vocals",
            "guitar",
            "piano",
        ] {
            assert!(valid_output(output));
        }
        assert!(!valid_output("all"));
        assert!(!valid_output("../bad"));
    }
    #[test]
    fn completion_accepts_only_reported_wavs_in_the_folder() {
        let dir = std::env::temp_dir().join(format!("stemwave-files-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(&dir).unwrap();
        fs::write(dir.join("Song (Drums).wav"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(exported_files(&dir, &names(&["Song (Drums).wav"])).unwrap(), vec![dir.join("Song (Drums).wav")]);
        assert!(exported_files(&dir, &names(&["notes.txt"])).is_none(), "not a wav");
        assert!(exported_files(&dir, &names(&["missing.wav"])).is_none(), "must exist");
        assert!(exported_files(&dir, &names(&["../Song (Drums).wav"])).is_none(), "no path components");
        assert!(exported_files(&dir, &[]).is_none(), "something must be reported");
        let mut status = Progress::starting();
        status.output_path = Some(dir.to_string_lossy().into_owned());
        assert_eq!(completed_path(&status, &dir), Some(dir.clone()), "direct-to-folder output");
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn loop_regions_and_labels() {
        assert_eq!(region(None, None).unwrap(), None);
        assert_eq!(region(Some(1.5), Some(3.)).unwrap(), Some((1.5, 3.)));
        for (a, b) in [(Some(3.), Some(1.)), (Some(-1.), Some(1.)), (Some(0.), Some(f64::NAN)), (Some(0.), None), (Some(0.), Some(601.))] {
            assert!(region(a, b).is_err());
        }
        assert_eq!(safe_label("bars 5-8"), "bars 5-8");
        assert_eq!(safe_label("../x/../y"), "xy");
        assert_eq!(safe_label("///"), "loop");
    }
    #[test]
    fn range_export_cuts_exactly() {
        let dir = std::env::temp_dir().join(format!("stemwave-range-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("tone.wav");
        // FFmpeg from STEMWAVE_FFMPEG or PATH; skip where none is installed.
        let ffmpeg = PathBuf::from(std::env::var("STEMWAVE_FFMPEG").unwrap_or_else(|_| "ffmpeg".into()));
        let made = Command::new(&ffmpeg)
            .args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-ac", "2", "-c:a", "pcm_f32le"])
            .arg(&source)
            .status();
        if !made.is_ok_and(|s| s.success()) {
            return; // FFmpeg unavailable here; exercised in the app.
        }
        let target = dir.join("cut.wav");
        write_export(&ffmpeg, &source, &target, Some((0.5, 1.5)), false).unwrap();
        // 1.0 s of stereo float32 at 44.1 kHz plus a small WAV header.
        let bytes = fs::metadata(&target).unwrap().len();
        assert!((44100 * 8..44100 * 8 + 200).contains(&bytes), "{bytes}");
        assert!(write_export(&ffmpeg, &source, &target, Some((0.5, 1.5)), false).is_err(), "never overwrites");
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn cancellation_reaps_owned_worker() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        stop_child(&mut child);
        assert!(child.try_wait().unwrap().is_some());
    }
}
