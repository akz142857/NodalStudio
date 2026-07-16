import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { LocalProject, ProjectScan, NodalStudioPlatform } from "../platform";

interface ProjectPanelProps {
  platform: NodalStudioPlatform;
  sourceId?: string;
  autoScan?: boolean;
}

const activeStatuses = new Set<ProjectScan["status"]>([
  "queued",
  "discovering",
  "parsing",
  "matching",
  "aiAnalysis",
]);

async function loadProjectState(platform: NodalStudioPlatform) {
  const projects = await platform.listLocalProjects();
  const scans = await Promise.all(
    projects.map(async (project) => ({
      projectId: project.id,
      scans: await platform.listProjectScans(project.id),
    })),
  );
  return {
    projects,
    latestScans: Object.fromEntries(
      scans.map((entry) => [entry.projectId, entry.scans[0]]),
    ) as Record<string, ProjectScan | undefined>,
  };
}

export function ProjectPanel({ platform, sourceId, autoScan = false }: ProjectPanelProps) {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [latestScans, setLatestScans] = useState<Record<string, ProjectScan | undefined>>({});
  const [rootPath, setRootPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("loading");
  const autoScanAttempted = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadProjectState(platform);
      setProjects(loaded.projects);
      setLatestScans(loaded.latestScans);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }, [platform]);

  useEffect(() => {
    let disposed = false;
    void loadProjectState(platform).then(
      (loaded) => {
        if (disposed) return;
        setProjects(loaded.projects);
        setLatestScans(loaded.latestScans);
        setStatus("idle");
      },
      () => {
        if (!disposed) setStatus("error");
      },
    );
    return () => {
      disposed = true;
    };
  }, [platform]);

  useEffect(() => {
    const active = Object.values(latestScans).filter(
      (scan): scan is ProjectScan => Boolean(scan && activeStatuses.has(scan.status)),
    );
    if (!active.length) return;
    const interval = window.setInterval(() => {
      void Promise.all(active.map((scan) => platform.getProjectScanStatus(scan.id))).then(
        (updates) => {
          setLatestScans((current) => {
            const next = { ...current };
            for (const update of updates) {
              if (update) next[update.projectId] = update;
            }
            return next;
          });
        },
      );
    }, 750);
    return () => window.clearInterval(interval);
  }, [latestScans, platform]);

  useEffect(() => {
    if (!autoScan || !sourceId) return;
    for (const project of projects.filter((item) => item.databaseSourceIds.includes(sourceId))) {
      const scan = latestScans[project.id];
      if (Boolean(scan && activeStatuses.has(scan.status)) || autoScanAttempted.current.has(project.id)) continue;
      autoScanAttempted.current.add(project.id);
      void platform.startProjectScan(project.id).then((started) => setLatestScans((current) => ({ ...current, [project.id]: started })), () => setStatus("error"));
    }
  }, [autoScan, latestScans, platform, projects, sourceId]);

  async function addProject(event: FormEvent) {
    event.preventDefault();
    if (!rootPath.trim()) return;
    setStatus("loading");
    try {
      await platform.addLocalProject({
        rootPath: rootPath.trim(),
        databaseSourceIds: sourceId ? [sourceId] : [],
      });
      setRootPath("");
      await refresh();
    } catch {
      setStatus("error");
    }
  }

  async function scanProject(projectId: string) {
    setStatus("loading");
    try {
      const scan = await platform.startProjectScan(projectId);
      setLatestScans((current) => ({ ...current, [projectId]: scan }));
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  async function cloneRemoteProject(event: FormEvent) {
    event.preventDefault();
    if (!remoteUrl.trim()) return;
    setStatus("loading");
    try { await platform.cloneRemoteProject({ remoteUrl: remoteUrl.trim(), databaseSourceIds: sourceId ? [sourceId] : [] }); setRemoteUrl(""); await refresh(); } catch { setStatus("error"); }
  }

  async function removeProject(project: LocalProject) {
    if (!window.confirm(`Remove ${project.name} and its local analysis cache? Source files will not be changed.`)) return;
    const deleteManagedCache = project.managedCache && window.confirm("Also delete Nodal Studio’s managed clone from the local cache?");
    await platform.removeLocalProject(project.id, deleteManagedCache);
    await refresh();
  }

  async function toggleBinding(project: LocalProject) {
    if (!sourceId) return;
    const bound = project.databaseSourceIds.includes(sourceId);
    const databaseSourceIds = bound ? project.databaseSourceIds.filter((id) => id !== sourceId) : [...project.databaseSourceIds, sourceId];
    await platform.setProjectBindings(project.id, databaseSourceIds); await refresh();
  }

  return (
    <section className="project-panel">
      <div className="section-heading">
        <h3>Projects</h3>
        <span>{projects.length}</span>
      </div>
      <p>Local source stays on this device. Scanning never runs project code.</p>
      <form onSubmit={(event) => void addProject(event)}>
        <input
          aria-label="Local project directory"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="/absolute/path/to/project"
        />
        <button type="button" onClick={() => void platform.selectProjectDirectory().then((path) => { if (path) setRootPath(path); })}>Choose folder…</button>
        <button type="submit" disabled={!rootPath.trim() || status === "loading"}>
          Add local project
        </button>
      </form>
      <form onSubmit={(event) => void cloneRemoteProject(event)}>
        <input aria-label="Remote Git URL" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://host/organization/repository.git" />
        <button type="submit" disabled={!remoteUrl.trim() || status === "loading"}>{status === "loading" ? "Cloning…" : "Clone remote…"}</button>
      </form>
      <div className="project-list">
        {projects.map((project) => {
          const scan = latestScans[project.id];
          const active = Boolean(scan && activeStatuses.has(scan.status));
          return (
            <article key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <small title={project.rootPath}>{project.managedCache ? "Managed clone" : project.repositoryKind === "git" ? "Git" : "Folder"}{scan?.branch ? ` · ${scan.branch}` : ""}{scan?.dirty ? " · modified" : ""}</small>
              </div>
              <small data-status={scan?.status ?? "not-scanned"}>
                {scan ? scan.status : "Not scanned"}
              </small>
              <div className="project-actions">
                {sourceId ? <button type="button" onClick={() => void toggleBinding(project)}>{project.databaseSourceIds.includes(sourceId) ? "Unbind database" : "Bind database"}</button> : null}
                {active ? (
                  <button type="button" onClick={() => void platform.cancelProjectScan(scan!.id)}>Cancel</button>
                ) : (
                  <button type="button" onClick={() => void scanProject(project.id)}>Scan</button>
                )}
                <button type="button" onClick={() => void removeProject(project)}>Remove</button>
              </div>
            </article>
          );
        })}
      </div>
      {status === "error" ? <small data-status="error">Choose a readable local project directory.</small> : null}
    </section>
  );
}
