//! Runs the pinned Python adapter for an explicitly launched project script.
mod dap;

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use rustix::process::{Pid, Signal, kill_process_group};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, State, ipc::Channel};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::extensions::python_adapter;
use super::files::{open_nested_directory, review_relative_path};
use super::review::{Project, ReviewState};
use crate::AppState;
use dap::{Adapter, bounded_text};

const INPUT: &str = "pythonDebugInput";
const OFFLINE: &str = "pythonDebugOffline";
const BUSY: &str = "pythonDebugBusy";
const PROTOCOL: &str = "pythonDebugProtocol";
const TIMEOUT: &str = "pythonDebugTimeout";
const MAX_BREAKPOINTS: usize = 256;
const MAX_FRAMES: usize = 50;
const MAX_VARIABLES: usize = 100;

#[derive(Default)]
pub(super) struct DebugSession(Mutex<SessionState>);

#[derive(Default)]
struct SessionState {
    closed: bool,
    active: Option<Active>,
}

struct Active {
    id: Uuid,
    commands: mpsc::Sender<Action>,
    cancel: CancellationToken,
    pid: Option<Pid>,
}

impl DebugSession {
    pub(super) fn close(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.closed = true;
            if let Some(active) = &state.active {
                active.cancel.cancel();
                if let Some(pid) = active.pid {
                    let _ = kill_process_group(pid, Signal::KILL);
                }
            }
        }
    }

    pub(super) fn stop(&self, id: Option<Uuid>) {
        if let Ok(state) = self.0.lock()
            && let Some(active) = &state.active
            && id.is_none_or(|id| active.id == id)
        {
            active.cancel.cancel();
        }
    }
}

#[derive(Serialize)]
pub(crate) struct LaunchOptions {
    root: PathBuf,
    program: PathBuf,
    interpreters: Vec<PathBuf>,
}

#[derive(Deserialize)]
pub(crate) struct LaunchInput {
    path: String,
    cwd: String,
    interpreter: PathBuf,
    args: Vec<String>,
    breakpoints: BTreeMap<String, Vec<u32>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Action {
    Breakpoints { path: String, lines: Vec<u32> },
    Continue,
    StepOver,
    StepIn,
    StepOut,
    Frame { id: u64 },
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Event {
    Running,
    Paused {
        frames: Vec<Frame>,
        selected: Option<u64>,
        scopes: Vec<Scope>,
    },
    Breakpoints {
        path: String,
        lines: Vec<u32>,
    },
    Output {
        text: String,
    },
    Finished {
        error: Option<String>,
    },
}

#[derive(Serialize)]
pub(crate) struct Frame {
    id: u64,
    name: String,
    path: Option<String>,
    source: String,
    line: u32,
}

#[derive(Serialize)]
pub(crate) struct Scope {
    name: String,
    variables: Vec<Variable>,
}

#[derive(Deserialize, Serialize)]
struct Variable {
    name: String,
    value: String,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn executable(path: &Path) -> bool {
    path.is_absolute()
        && fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn file_path(project: &Project, path: &str) -> Result<PathBuf, String> {
    let relative = review_relative_path(path, false).map_err(|_| INPUT)?;
    if relative.extension().is_none_or(|ext| ext != "py") {
        return Err(INPUT.into());
    }
    let repository = project.directory()?;
    let parent = open_nested_directory(&repository.dir, relative.parent().ok_or(INPUT)?)
        .map_err(|_| INPUT)?;
    if !parent
        .symlink_metadata(relative.file_name().ok_or(INPUT)?)
        .is_ok_and(|meta| meta.is_file())
    {
        return Err(INPUT.into());
    }
    Ok(project.root.join(relative))
}

fn working_dir(project: &Project, cwd: &str) -> Result<PathBuf, String> {
    let cwd = if cwd == "." { "" } else { cwd };
    let relative = review_relative_path(cwd, true).map_err(|_| INPUT)?;
    open_nested_directory(&project.directory()?.dir, &relative).map_err(|_| INPUT)?;
    Ok(project.root.join(relative))
}

fn check_lines(lines: &[u32]) -> Result<(), String> {
    if lines.len() > MAX_BREAKPOINTS || lines.contains(&0) {
        return Err(INPUT.into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn prepare_python_debug(
    project_id: Uuid,
    path: String,
    state: State<'_, ReviewState>,
) -> Result<LaunchOptions, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || {
        let program = file_path(&project, &path)?;
        let interpreters = [
            project.root.join(".venv/bin/python"),
            project.root.join("venv/bin/python"),
            "/opt/homebrew/bin/python3".into(),
            "/usr/local/bin/python3".into(),
            "/usr/bin/python3".into(),
        ]
        .into_iter()
        .filter(|path| executable(path))
        .collect();
        Ok(LaunchOptions {
            root: project.root.clone(),
            program,
            interpreters,
        })
    })
    .await
    .map_err(|_| INPUT)?
}

#[tauri::command]
pub(crate) async fn start_python_debug(
    handle: AppHandle,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
    project_id: Uuid,
    id: Uuid,
    input: LaunchInput,
    events: Channel<Event>,
) -> Result<(), String> {
    let project = state.project(project_id)?;
    let offline = app.subscribe_offline();
    if *offline.borrow() {
        return Err(OFFLINE.into());
    }
    if !executable(&input.interpreter)
        || input.args.len() > 64
        || input
            .args
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
        || input.breakpoints.len() > MAX_BREAKPOINTS
        || input.breakpoints.values().map(Vec::len).sum::<usize>() > MAX_BREAKPOINTS
    {
        return Err(INPUT.into());
    }

    let (commands, actions) = mpsc::channel(16);
    let cancel = CancellationToken::new();
    {
        let mut session = project.debugger.0.lock().map_err(|_| BUSY)?;
        if session.closed || session.active.is_some() {
            return Err(BUSY.into());
        }
        session.active = Some(Active {
            id,
            commands,
            cancel: cancel.clone(),
            pid: None,
        });
    }
    tokio::spawn(async move {
        let result = run(
            handle,
            Arc::clone(&project),
            id,
            input,
            actions,
            events.clone(),
            cancel,
            offline,
        )
        .await;
        if let Ok(mut session) = project.debugger.0.lock()
            && session
                .active
                .as_ref()
                .is_some_and(|active| active.id == id)
        {
            session.active = None;
        }
        let _ = events.send(Event::Finished {
            error: result.err(),
        });
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn control_python_debug(
    state: State<'_, ReviewState>,
    project_id: Uuid,
    id: Uuid,
    action: Action,
) -> Result<(), String> {
    let project = state.project(project_id)?;
    let session = project.debugger.0.lock().map_err(|_| BUSY)?;
    let active = session
        .active
        .as_ref()
        .filter(|active| active.id == id)
        .ok_or(BUSY)?;
    active.commands.try_send(action).map_err(|_| BUSY.into())
}

#[tauri::command]
pub(crate) async fn stop_python_debug(
    state: State<'_, ReviewState>,
    project_id: Uuid,
    id: Uuid,
) -> Result<(), String> {
    state.project(project_id)?.debugger.stop(Some(id));
    Ok(())
}

async fn wait_offline(offline: &mut watch::Receiver<bool>) {
    let _ = offline.wait_for(|value| *value).await;
}

#[allow(clippy::too_many_arguments)]
async fn run(
    handle: AppHandle,
    project: Arc<Project>,
    id: Uuid,
    input: LaunchInput,
    actions: mpsc::Receiver<Action>,
    events: Channel<Event>,
    cancel: CancellationToken,
    mut offline: watch::Receiver<bool>,
) -> Result<(), String> {
    let work = Arc::clone(&project);
    let prepare = tokio::task::spawn_blocking(move || {
        let program = file_path(&work, &input.path)?;
        let cwd = working_dir(&work, &input.cwd)?;
        for (path, lines) in &input.breakpoints {
            check_lines(lines)?;
            file_path(&work, path)?;
        }
        let temp = tempfile::tempdir().map_err(|_| PROTOCOL)?;
        let entry = python_adapter(&handle, work.key(), temp.path())?;
        Ok::<_, String>((temp, entry, input, program, cwd))
    });
    let (temp, entry, input, program, cwd) = tokio::select! {
        () = cancel.cancelled() => return Ok(()),
        () = wait_offline(&mut offline) => return Err(OFFLINE.into()),
        result = prepare => result.map_err(|_| PROTOCOL)??,
    };
    let mut child = {
        let mut session = project.debugger.0.lock().map_err(|_| BUSY)?;
        let active = session
            .active
            .as_mut()
            .filter(|active| active.id == id && !cancel.is_cancelled())
            .ok_or(BUSY)?;
        project.directory()?;
        let child = Command::new(&input.interpreter)
            .args(["-I", "-B"])
            .arg(entry)
            .current_dir(temp.path())
            .env_clear()
            .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
            .env("HOME", temp.path())
            .env("LC_CTYPE", "UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| INPUT)?;
        active.pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(Pid::from_raw);
        child
    };
    let mut adapter = Adapter::new(
        child.stdin.take().ok_or(PROTOCOL)?,
        child.stdout.take().ok_or(PROTOCOL)?,
        events,
    );
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Ok(()),
        () = wait_offline(&mut offline) => Err(OFFLINE.into()),
        result = debug(&mut adapter, &project, &input, &program, &cwd, actions) => result,
    };
    if let Ok(mut session) = project.debugger.0.lock()
        && let Some(active) = session.active.as_mut().filter(|active| active.id == id)
        && let Some(pid) = active.pid.take()
    {
        let _ = kill_process_group(pid, Signal::KILL);
    }
    drop(adapter);
    let _ = child.wait().await;
    result
}

async fn debug(
    adapter: &mut Adapter,
    project: &Project,
    input: &LaunchInput,
    program: &Path,
    cwd: &Path,
    mut actions: mpsc::Receiver<Action>,
) -> Result<(), String> {
    adapter.call("initialize", json!({
        "clientID": "nodalstudio", "adapterID": "debugpy", "pathFormat": "path",
        "linesStartAt1": true, "columnsStartAt1": true, "supportsRunInTerminalRequest": false
    })).await?;
    let launch = adapter.send("launch", json!({
        "name": "Python", "type": "debugpy", "request": "launch",
        "python": [input.interpreter, "-B"], "program": program, "cwd": cwd, "args": input.args,
        "console": "internalConsole", "redirectOutput": true, "subProcess": false,
        "justMyCode": true
    })).await?;
    adapter.initialized(launch).await?;
    let mut breakpoints = input.breakpoints.clone();
    for (path, lines) in &breakpoints {
        set_breakpoints(adapter, project, path, lines).await?;
    }
    adapter.call("configurationDone", json!({})).await?;
    adapter.response(launch).await?;
    adapter.emit(Event::Running)?;

    let mut thread = None;
    let mut frames = Vec::new();
    loop {
        if let Some(event) = adapter.event() {
            match event["event"].as_str() {
                Some("stopped") => {
                    let id = event["body"]["threadId"].as_u64().ok_or(PROTOCOL)?;
                    thread = Some(id);
                    let stack = adapter
                        .call(
                            "stackTrace",
                            json!({"threadId": id, "startFrame": 0, "levels": MAX_FRAMES}),
                        )
                        .await?;
                    frames = stack["stackFrames"]
                        .as_array()
                        .ok_or(PROTOCOL)?
                        .iter()
                        .take(MAX_FRAMES)
                        .filter_map(|frame| stack_frame(project, frame))
                        .collect();
                    show_frame(adapter, &frames, frames.first().map(|frame| frame.id)).await?;
                }
                Some("terminated") => return Ok(()),
                _ => {}
            }
            continue;
        }
        tokio::select! {
            message = adapter.receive() => adapter.ingest(message?).await?,
            action = actions.recv() => match action {
                Some(Action::Breakpoints { path, lines }) => {
                    let others = breakpoints.iter().filter(|(key, _)| **key != path).map(|(_, lines)| lines.len()).sum::<usize>();
                    check_lines(&lines)?;
                    if others + lines.len() > MAX_BREAKPOINTS {
                        return Err(INPUT.into());
                    }
                    set_breakpoints(adapter, project, &path, &lines).await?;
                    if lines.is_empty() { breakpoints.remove(&path); } else { breakpoints.insert(path, lines); }
                }
                Some(Action::Frame { id }) if thread.is_some() && frames.iter().any(|frame| frame.id == id) => {
                    show_frame(adapter, &frames, Some(id)).await?;
                }
                Some(action) => {
                    let command = match action {
                        Action::Continue => "continue",
                        Action::StepOver => "next",
                        Action::StepIn => "stepIn",
                        Action::StepOut => "stepOut",
                        _ => continue,
                    };
                    if let Some(id) = thread.take() {
                        adapter.call(command, json!({"threadId": id})).await?;
                        adapter.emit(Event::Running)?;
                    }
                }
                None => return Ok(()),
            }
        }
    }
}

async fn set_breakpoints(
    adapter: &mut Adapter,
    project: &Project,
    path: &str,
    lines: &[u32],
) -> Result<(), String> {
    let source = file_path(project, path)?;
    let body = adapter.call("setBreakpoints", json!({
        "source": {"path": source}, "breakpoints": lines.iter().map(|line| json!({"line": line})).collect::<Vec<_>>()
    })).await?;
    let lines = body["breakpoints"]
        .as_array()
        .ok_or(PROTOCOL)?
        .iter()
        .zip(lines)
        .filter(|(item, _)| item["verified"] == true)
        .map(|(_, line)| *line)
        .collect();
    adapter.emit(Event::Breakpoints {
        path: path.into(),
        lines,
    })
}

fn stack_frame(project: &Project, frame: &Value) -> Option<Frame> {
    let source = frame["source"]["path"].as_str().unwrap_or_default();
    let relative = Path::new(source)
        .strip_prefix(&project.root)
        .ok()
        .and_then(Path::to_str)
        .filter(|path| file_path(project, path).is_ok());
    Some(Frame {
        id: frame["id"].as_u64()?,
        name: bounded_text(frame["name"].as_str().unwrap_or_default(), 256),
        source: bounded_text(frame["source"]["name"].as_str().unwrap_or(source), 256),
        path: relative.map(str::to_owned),
        line: u32::try_from(frame["line"].as_u64()?).ok()?,
    })
}

async fn show_frame(
    adapter: &mut Adapter,
    frames: &[Frame],
    selected: Option<u64>,
) -> Result<(), String> {
    let mut scopes = Vec::new();
    if let Some(id) = selected {
        let body = adapter.call("scopes", json!({"frameId": id})).await?;
        for scope in body["scopes"].as_array().ok_or(PROTOCOL)?.iter().take(4) {
            if scope["expensive"] == true {
                continue;
            }
            let reference = scope["variablesReference"].as_u64().ok_or(PROTOCOL)?;
            let result = adapter
                .call(
                    "variables",
                    json!({"variablesReference": reference, "count": MAX_VARIABLES}),
                )
                .await?;
            let variables = result["variables"]
                .as_array()
                .ok_or(PROTOCOL)?
                .iter()
                .take(MAX_VARIABLES)
                .filter_map(|item| {
                    Some(Variable {
                        name: bounded_text(item["name"].as_str()?, 256),
                        value: bounded_text(item["value"].as_str()?, 1024),
                        kind: item["type"].as_str().map(|kind| bounded_text(kind, 80)),
                    })
                })
                .collect();
            scopes.push(Scope {
                name: bounded_text(scope["name"].as_str().unwrap_or_default(), 128),
                variables,
            });
        }
    }
    let frames = frames
        .iter()
        .map(|frame| Frame {
            id: frame.id,
            name: frame.name.clone(),
            source: frame.source.clone(),
            path: frame.path.clone(),
            line: frame.line,
        })
        .collect();
    adapter.emit(Event::Paused {
        frames,
        selected,
        scopes,
    })
}
