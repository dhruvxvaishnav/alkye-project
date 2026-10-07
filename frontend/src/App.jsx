import { useCallback, useEffect, useRef, useState } from "react";
import { request, post } from "./api";
import Icon from "./components/Icon";
import Modal from "./components/Modal";
import AuthDialog from "./components/AuthDialog";
import TaskDialog from "./components/TaskDialog";
import Snackbar from "./components/Snackbar";
import TaskStatus from "./components/TaskStatus";
import UserDialog from "./components/UserDialog";
import "./App.css";

function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem("workspace-session"));
  } catch {
    return null;
  }
}
const dateLabel = (value) =>
  value
    ? new Date(`${value}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "No due date";
function Avatar({ name, small = false }) {
  return (
    <span
      className={`avatar ${small ? "small" : ""} ${name === "James Bond" ? "bond" : ""}`}
    >
      {name
        .split(" ")
        .map((w) => w[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}
function App() {
  const searchRef = useRef(null);
  const [session, setSession] = useState(getSession);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState("tasks");
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("all");
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [snackbar, setSnackbar] = useState(null);
  const [checkingRights, setCheckingRights] = useState(false);
  const dismissSnackbar = useCallback(() => setSnackbar(null), []);
  const [cache, setCache] = useState(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const isAdmin = session?.user.role === "admin";
  useEffect(() => {
    const handleKey = (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !modal
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modal]);
  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await request(isAdmin ? "/tasks" : "/tasks/view-my-tasks", {
        token: session.token,
      });
      setTasks(data.tasks);
      setCache(data.cache || null);
      if (isAdmin) {
        const result = await request("/users", { token: session.token });
        setUsers(result.users);
      }
    } catch (e) {
      setNotice({ type: "error", text: e.message });
      if (e.status === 401) {
        sessionStorage.removeItem("workspace-session");
        setSession(null);
        setTasks([]);
        setUsers([]);
        setCache(null);
      }
    } finally {
      setLoading(false);
    }
  }, [session, isAdmin]);
  // Synchronize tasks with the authenticated API session.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  function login(data) {
    sessionStorage.setItem("workspace-session", JSON.stringify(data));
    setSession(data);
    setModal(null);
    setSelected([]);
    setNotice({
      type: "success",
      text: `Welcome back, ${data.user.name}. Your workspace is ready.`,
    });
  }
  function logout() {
    sessionStorage.removeItem("workspace-session");
    setSession(null);
    setTasks([]);
    setUsers([]);
    setSelected([]);
    setCache(null);
    setNotice(null);
    setSnackbar(null);
    setPage("tasks");
  }
  async function setup() {
    setSetupBusy(true);
    try {
      await post("/seed/users", {});
      setNotice({
        type: "success",
        text: "Local accounts are ready: admin@example.com and jamesbond@example.com. New accounts use Workspace123!; existing passwords are preserved.",
      });
      setModal("auth");
    } catch (e) {
      setNotice({ type: "error", text: e.message });
    } finally {
      setSetupBusy(false);
    }
  }
  async function assign() {
    if (
      !assignmentTaskIds.length ||
      !availableAssignees.some((user) => user.id === Number(assignee))
    )
      return;
    setAssignBusy(true);
    try {
      await post(
        "/tasks/assign",
        { task_ids: assignmentTaskIds, user_id: Number(assignee) },
        session.token,
      );
      setModal(null);
      setSelected([]);
      setNotice({
        type: "success",
        text: `${assignmentTaskIds.length} tasks assigned successfully.`,
      });
      await load();
    } catch (e) {
      setNotice({ type: "error", text: e.message });
    } finally {
      setAssignBusy(false);
    }
  }
  async function newTask() {
    if (!session) setModal("auth");
    else if (isAdmin) setModal("task");
    else {
      setCheckingRights(true);
      try {
        // The API checks permissions before validating the empty title.
        // An empty title also prevents creation if the account's role changed.
        await post("/tasks", { title: "", priority: "medium" }, session.token);
      } catch (error) {
        setSnackbar({
          message:
            error.status === 403
              ? "The task creation rights are reserved for admins"
              : error.message,
          status: error.status,
        });
      } finally {
        setCheckingRights(false);
      }
    }
  }
  async function updateTaskStatus(taskId, status) {
    try {
      const result = await request(`/tasks/${taskId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
        token: session.token,
      });
      setTasks((current) =>
        current.map((task) =>
          task.id === result.task.id
            ? { ...task, status: result.task.status }
            : task,
        ),
      );
      setModal((current) =>
        current?.detail?.id === result.task.id
          ? {
              ...current,
              detail: { ...current.detail, status: result.task.status },
            }
          : current,
      );
      setCache(null);
      setSnackbar({ message: result.message });
    } catch (error) {
      setSnackbar({ message: error.message, status: error.status });
    }
  }
  const mine = tasks.filter((t) => t.assignee_id === session?.user.id);
  const unassigned = tasks.filter((t) => !t.assignee_id);
  const visible = tasks.filter(
    (t) =>
      (tab === "all" ||
        (tab === "mine" && t.assignee_id === session?.user.id) ||
        (tab === "unassigned" && !t.assignee_id)) &&
      (priority === "all" || t.priority === priority) &&
      `${t.title} ${t.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const completed = tasks.filter((t) => t.status === "completed").length;
  const staff = users.filter((u) => u.role === "staff");
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  const availableAssignees = staff.filter((user) =>
    selectedTasks.some((task) => task.assignee_id !== user.id),
  );
  const assignmentTaskIds = selectedTasks
    .filter((task) => task.assignee_id !== Number(assignee))
    .map((task) => task.id);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("tasks");
          }}
        >
          <span className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </span>
          workly<span className="brand-dot">.</span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-logo">W</span>
          <div>
            <strong>My workspace</strong>
            <span>Personal workspace</span>
          </div>
          <Icon name="down" size={15} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          <button
            className={page === "overview" ? "active" : ""}
            onClick={() => setPage("overview")}
          >
            <Icon name="grid" />
            Overview
          </button>
          <button
            className={page === "tasks" ? "active" : ""}
            onClick={() => setPage("tasks")}
          >
            <Icon name="tasks" />
            Tasks<span className="nav-count">{tasks.length}</span>
          </button>
          <button
            className={page === "team" ? "active" : ""}
            onClick={() => {
              if (!session) setModal("auth");
              else setPage("team");
            }}
          >
            <Icon name="users" />
            Team members
          </button>
          <button
            className={page === "security" ? "active" : ""}
            onClick={() => setPage("security")}
          >
            <Icon name="shield" />
            Access & security
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Icon name="folder" size={21} />
            </span>
            <strong>A little more organized.</strong>
            <p>
              A lot more accomplished.
              <br />
              Make room for your best work.
            </p>
            <span className="tip-decoration">✦</span>
          </div>

          <div className="profile">
            <Avatar name={session?.user.name || "Workspace"} />
            <div>
              <strong>{session?.user.name || "Your workspace"}</strong>
              <span>
                {session
                  ? `${isAdmin ? "Admin" : "Staff"} account`
                  : "Sign in to get started"}
              </span>
            </div>
            <button
              className="icon-button"
              onClick={session ? logout : () => setModal("auth")}
              aria-label={session ? "Sign out" : "Sign in"}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace
            <Icon name="chevron" size={13} />
            <span>
              {
                {
                  tasks: "Tasks",
                  overview: "Overview",
                  team: "Team members",
                  security: "Access & security",
                }[page]
              }
            </span>
          </div>
          <div className="topbar-right">
            <span className="connection">
              <i /> Local workspace
            </span>
            <span className="top-divider" />
            {session ? (
              <>
                <span className="role-tag">{isAdmin ? "Admin" : "Staff"}</span>
                <Avatar name={session.user.name} small />
              </>
            ) : (
              <button
                className="secondary small-button"
                onClick={() => setModal("auth")}
              >
                Sign in
                <Icon name="arrow" size={15} />
              </button>
            )}
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">A CLEAR SPACE. A FOCUSED TEAM.</div>
              <h1>
                {
                  {
                    tasks: "Tasks",
                    overview: "Workspace overview",
                    team: "Your people",
                    security: "Access & security",
                  }[page]
                }
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === "tasks"
                  ? "Big ideas start with small steps. Keep every task moving forward."
                  : page === "team"
                    ? "Good work happens together. Meet your workspace members."
                    : page === "security"
                      ? "The right access for the right people. Secure at every step."
                      : "A little perspective on everything you’re working on."}
              </p>
            </div>
            {page === "tasks" && (
              <div className="heading-actions">
                {session && (
                  <button
                    className="secondary"
                    onClick={load}
                    disabled={loading}
                  >
                    <Icon name="refresh" size={16} />
                    {loading ? "Refreshing…" : "Refresh"}
                  </button>
                )}
                <button
                  className="primary"
                  onClick={newTask}
                  disabled={checkingRights}
                >
                  <Icon name="plus" size={18} />
                  {checkingRights ? "Checking access…" : "Create task"}
                </button>
              </div>
            )}
            {page === "team" && isAdmin && (
              <div className="heading-actions">
                <button className="primary" onClick={() => setModal("user")}>
                  <Icon name="plus" size={18} />
                  Create user
                </button>
              </div>
            )}
          </div>
          {notice && (
            <div
              className={`notice ${notice.type}`}
              role={notice.type === "error" ? "alert" : "status"}
            >
              <Icon
                name={notice.type === "error" ? "shield" : "check"}
                size={18}
              />
              <span>{notice.text}</span>
              <button
                className="icon-button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notification"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {!session && (
            <div className="welcome-banner">
              <div className="welcome-icon">
                <Icon name="shield" size={23} />
              </div>
              <div>
                <strong>Your next great work starts here</strong>
                <p>
                  Sign in to create, assign, and keep track of your team’s
                  tasks.
                </p>
              </div>
              <button
                className="text-button"
                onClick={setup}
                disabled={setupBusy}
              >
                {setupBusy ? "Setting up…" : "Set up local accounts"}
                <Icon name="arrow" size={16} />
              </button>
            </div>
          )}
          {(page === "tasks" || page === "overview") && (
            <>
              <div className="stats-grid">
                {[
                  {
                    label: isAdmin ? "Total tasks" : "Workspace tasks",
                    value: tasks.length,
                    icon: "tasks",
                    color: "purple",
                    detail: "Everything in one place",
                  },
                  {
                    label: "Assigned tasks",
                    value: tasks.filter((t) => t.assignee_id).length,
                    icon: "users",
                    color: "blue",
                    detail: "A clear owner, a clear next step",
                  },
                  {
                    label: "Unassigned",
                    value: unassigned.length,
                    icon: "clock",
                    color: "orange",
                    detail: "Ready for a team member",
                  },
                  {
                    label: "Completed",
                    value: completed,
                    icon: "check",
                    color: "green",
                    detail: "Small wins. Real progress.",
                  },
                ].map((stat) => (
                  <div className="stat-card" key={stat.label}>
                    <div className="stat-top">
                      <span>{stat.label}</span>
                      <span className={`stat-icon ${stat.color}`}>
                        <Icon name={stat.icon} size={18} />
                      </span>
                    </div>
                    <div className="stat-value">
                      {stat.value.toString().padStart(2, "0")}
                      <span className="stat-dash">—</span>
                    </div>
                    <p>{stat.detail}</p>
                  </div>
                ))}
              </div>
              <section className="task-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      {isAdmin
                        ? "Task workspace"
                        : session
                          ? "My task workspace"
                          : "Task workspace"}
                      <span className="count-badge">{tasks.length}</span>
                    </h2>
                    <p>
                      {isAdmin
                        ? "Plan it. Assign it. Make it happen."
                        : session
                          ? "Your assigned work, all in one place."
                          : "A home for everything your team is working on."}
                    </p>
                  </div>
                  <span className="view-indicator">
                    <Icon name="tasks" size={16} />
                    List view
                  </span>
                </div>
                <div className="table-toolbar">
                  <div className="tabs">
                    <button
                      className={tab === "all" ? "selected" : ""}
                      onClick={() => setTab("all")}
                    >
                      {isAdmin || !session ? "All tasks" : "Assigned to me"}
                      <span>{tasks.length}</span>
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          className={tab === "mine" ? "selected" : ""}
                          onClick={() => setTab("mine")}
                        >
                          Assigned to me<span>{mine.length}</span>
                        </button>
                        <button
                          className={tab === "unassigned" ? "selected" : ""}
                          onClick={() => setTab("unassigned")}
                        >
                          Unassigned<span>{unassigned.length}</span>
                        </button>
                      </>
                    )}
                  </div>
                  <div className="filters">
                    <div className="search-input">
                      <Icon name="search" size={16} />
                      <input
                        ref={searchRef}
                        aria-label="Search tasks"
                        placeholder="Search tasks…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <kbd>⌘ K</kbd>
                    </div>
                    <select
                      aria-label="Filter priority"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value)}
                    >
                      <option value="all">All priorities</option>
                      <option value="high">High priority</option>
                      <option value="medium">Medium priority</option>
                      <option value="low">Low priority</option>
                    </select>
                  </div>
                </div>
                {selected.length > 0 && (
                  <div className="selection-bar">
                    <span>
                      <strong>{selected.length}</strong> tasks selected
                    </span>
                    <button
                      className="primary small-button"
                      onClick={() => {
                        setAssignee(String(availableAssignees[0]?.id || ""));
                        setModal("assign");
                      }}
                    >
                      <Icon name="users" size={15} />
                      Assign tasks
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setSelected([])}
                    >
                      Clear selection
                    </button>
                  </div>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="check-cell">
                          {isAdmin && (
                            <input
                              type="checkbox"
                              aria-label="Select all visible tasks"
                              checked={
                                visible.length > 0 &&
                                visible.every((t) => selected.includes(t.id))
                              }
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? visible.map((t) => t.id)
                                    : [],
                                )
                              }
                            />
                          )}
                        </th>
                        <th>Task name</th>
                        <th>Status</th>
                        <th>Priority</th>
                        <th>Assignee</th>
                        <th>Due date</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((task) => (
                        <tr key={task.id}>
                          <td className="check-cell">
                            {isAdmin && (
                              <input
                                type="checkbox"
                                aria-label={`Select ${task.title}`}
                                checked={selected.includes(task.id)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, task.id]
                                      : selected.filter((id) => id !== task.id),
                                  )
                                }
                              />
                            )}
                          </td>
                          <td className="task-name">
                            <button onClick={() => setModal({ detail: task })}>
                              <span className="task-reference">
                                WL-{String(task.id).padStart(3, "0")}
                              </span>
                              <strong>{task.title}</strong>
                              {task.description && (
                                <span className="task-desc">
                                  {task.description}
                                </span>
                              )}
                            </button>
                          </td>
                          <td>
                            <TaskStatus
                              task={task}
                              editable={
                                !isAdmin &&
                                task.assignee_id === session?.user.id
                              }
                              onUpdate={updateTaskStatus}
                            />
                          </td>
                          <td>
                            <span className={`priority ${task.priority}`}>
                              <span className="priority-bars">
                                <i />
                                <i />
                                <i />
                              </span>
                              {task.priority}
                            </span>
                          </td>
                          <td>
                            {task.assignee_name ? (
                              <span className="assignee">
                                <Avatar name={task.assignee_name} small />
                                {task.assignee_name}
                              </span>
                            ) : (
                              <span className="unassigned">
                                <span className="unassigned-avatar">
                                  <Icon name="users" size={13} />
                                </span>
                                Unassigned
                              </span>
                            )}
                          </td>
                          <td className="due-date">
                            <Icon name="calendar" size={14} />
                            {dateLabel(task.due_date)}
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`View ${task.title}`}
                              onClick={() => setModal({ detail: task })}
                            >
                              <Icon name="dots" size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!visible.length && (
                  <div className="empty-state">
                    <div className="empty-illustration">
                      <div className="paper">
                        <span />
                        <span />
                        <span />
                        <i>
                          <Icon name="check" size={15} />
                        </i>
                      </div>
                      <span className="spark one">✦</span>
                      <span className="spark two">✦</span>
                    </div>
                    <h3>
                      {loading
                        ? "Getting your tasks…"
                        : search || priority !== "all"
                          ? "No matching tasks"
                          : !session
                            ? "A fresh start for great work"
                            : isAdmin
                              ? "Your next big thing starts here"
                              : "You’re all caught up"}
                    </h3>
                    <p>
                      {!session
                        ? "Sign in to bring your tasks and your team together."
                        : isAdmin
                          ? "Create your first task and give your ideas a place to grow."
                          : "Tasks assigned to you will appear right here."}
                    </p>
                    <button
                      className="primary"
                      onClick={
                        !session
                          ? () => setModal("auth")
                          : isAdmin
                            ? newTask
                            : load
                      }
                    >
                      <Icon
                        name={!session ? "arrow" : isAdmin ? "plus" : "refresh"}
                        size={16}
                      />
                      {!session
                        ? "Sign in to workspace"
                        : isAdmin
                          ? "Create your first task"
                          : "Check for tasks"}
                    </button>
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    {visible.length} of {tasks.length} tasks
                  </span>
                  <span>
                    {cache ? (
                      <>
                        <i className="live-dot" />
                        {cache.hit
                          ? "Loaded from cache"
                          : "Synced from database"}{" "}
                        · 60s cache
                      </>
                    ) : (
                      <>
                        <Icon name="shield" size={13} />
                        Only the right people. Only the right tasks.
                      </>
                    )}
                  </span>
                </div>
              </section>
              <div className="bottom-cards">
                <div className="info-card">
                  <div className="info-card-icon purple">
                    <Icon name="users" size={23} />
                  </div>
                  <div>
                    <h3>Better work, together</h3>
                    <p>Give every task an owner. Give your team clarity.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() =>
                      session ? setPage("team") : setModal("auth")
                    }
                  >
                    View team
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
                <div className="info-card">
                  <div className="info-card-icon green">
                    <Icon name="shield" size={23} />
                  </div>
                  <div>
                    <h3>Built on trust</h3>
                    <p>Role-based access. Two-step sign in. Peace of mind.</p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setPage("security")}
                    aria-label="View security"
                  >
                    <Icon name="arrow" size={19} />
                  </button>
                </div>
              </div>
            </>
          )}
          {page === "team" && (
            <section className="content-panel">
              <h2>
                Workspace members{" "}
                <span className="count-badge">
                  {isAdmin ? users.length : "1"}
                </span>
              </h2>
              <p className="muted">
                Admins organize the work. Staff focus on their assigned tasks.
              </p>
              <div className="member-grid">
                {(isAdmin ? users : session ? [session.user] : []).map(
                  (user) => (
                    <div className="member-card" key={user.id}>
                      <Avatar name={user.name} />
                      <h3>{user.name}</h3>
                      <p>{user.email}</p>
                      <span className="role-tag">{user.role}</span>
                      <span className="muted">
                        {tasks.filter((t) => t.assignee_id === user.id).length}{" "}
                        assigned tasks
                      </span>
                    </div>
                  ),
                )}
              </div>
            </section>
          )}
          {page === "security" && (
            <section className="content-panel">
              <div className="security-heading">
                <div className="info-card-icon green">
                  <Icon name="shield" size={26} />
                </div>
                <div>
                  <h2>A secure space to do your best work</h2>
                  <p className="muted">
                    Every account uses email verification before a session
                    starts.
                  </p>
                </div>
              </div>
              <div className="security-grid">
                <div>
                  <Icon name="lock" />
                  <h3>Two-step verification</h3>
                  <p>
                    Email and password begin sign in. A six-digit email code
                    unlocks your workspace.
                  </p>
                </div>
                <div>
                  <Icon name="users" />
                  <h3>Clear permissions</h3>
                  <p>
                    Admins create and assign tasks. Staff see only the tasks
                    assigned to their account.
                  </p>
                </div>
                <div>
                  <Icon name="clock" />
                  <h3>Fresh, protected sessions</h3>
                  <p>
                    JWT sessions expire after one hour. Verification codes
                    expire after five minutes.
                  </p>
                </div>
              </div>
              <button className="secondary" onClick={() => setModal("help")}>
                Read the local setup guide
                <Icon name="arrow" size={16} />
              </button>
            </section>
          )}
          <footer className="page-footer">
            <span>Less busywork. More meaningful work.</span>
            <span>
              Made for a little more focus.
              <span className="footer-logo">workly.</span>
            </span>
          </footer>
        </main>
      </div>
      {snackbar && (
        <Snackbar notification={snackbar} onClose={dismissSnackbar} />
      )}
      {modal === "auth" && (
        <AuthDialog onClose={() => setModal(null)} onLogin={login} />
      )}
      {modal === "task" && (
        <TaskDialog
          token={session?.token}
          onClose={() => setModal(null)}
          onCreated={() => {
            setModal(null);
            setNotice({
              type: "success",
              text: "Task created. One step closer to the big picture.",
            });
            load();
          }}
        />
      )}
      {modal === "user" && isAdmin && (
        <UserDialog
          token={session.token}
          onClose={() => setModal(null)}
          onCreated={(user) => {
            setUsers((current) => [...current, user]);
            setModal(null);
            setSnackbar({
              message: `${user.name} created successfully. They can now sign in.`,
            });
          }}
        />
      )}
      {modal === "assign" && (
        <Modal
          title={`Assign ${selected.length} tasks`}
          subtitle="Choose the team member who will take it from here."
          onClose={() => setModal(null)}
        >
          <div className="stack">
            <label>
              Team member
              <select
                value={
                  availableAssignees.some(
                    (user) => user.id === Number(assignee),
                  )
                    ? assignee
                    : ""
                }
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Select a staff member</option>
                {availableAssignees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </option>
                ))}
              </select>
            </label>
            {!staff.length && (
              <p className="form-note">
                No staff accounts yet. Create James Bond using the local setup
                guide.
              </p>
            )}
            {staff.length > 0 && !availableAssignees.length && (
              <p className="form-note">
                The selected tasks are already assigned. No other staff members
                are available.
              </p>
            )}
            {assignee &&
              assignmentTaskIds.length > 0 &&
              assignmentTaskIds.length < selectedTasks.length && (
                <p className="form-note">
                  Tasks already assigned to this team member will be skipped.
                </p>
              )}
            <button
              className="primary wide"
              disabled={
                !assignee ||
                !assignmentTaskIds.length ||
                !availableAssignees.some(
                  (user) => user.id === Number(assignee),
                ) ||
                assignBusy
              }
              onClick={assign}
            >
              {assignBusy ? "Assigning…" : "Assign selected tasks"}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </Modal>
      )}
      {modal?.detail && (
        <Modal
          title={modal.detail.title}
          subtitle={`WL-${String(modal.detail.id).padStart(3, "0")} · Task details`}
          onClose={() => setModal(null)}
        >
          <div className="stack">
            <p>{modal.detail.description || "No description added."}</p>
            <div className="detail-row">
              <span>Status</span>
              <TaskStatus
                task={modal.detail}
                editable={
                  !isAdmin && modal.detail.assignee_id === session?.user.id
                }
                onUpdate={updateTaskStatus}
              />
            </div>
            <div className="detail-row">
              <span>Assignee</span>
              <strong>{modal.detail.assignee_name || "Unassigned"}</strong>
            </div>
            <div className="detail-row">
              <span>Priority</span>
              <strong>{modal.detail.priority}</strong>
            </div>
            <div className="detail-row">
              <span>Due date</span>
              <strong>{dateLabel(modal.detail.due_date)}</strong>
            </div>
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title="Your workspace, ready to go"
          subtitle="A quick guide to the local validation flow."
          onClose={() => setModal(null)}
        >
          <div className="stack help-content">
            <p>
              1. Set up local Admin and James Bond accounts. Both use{" "}
              <code>Workspace123!</code>.
            </p>
            <p>
              2. Sign in as <code>admin@example.com</code>. Retrieve the
              code from the API console or use Get local verification code, then verify.
            </p>
            <p>
              3. Create exactly five tasks. Select three and assign them to
              James Bond.
            </p>
            <p>
              4. Sign out, then sign in as <code>jamesbond@example.com</code>{" "}
              and verify his code.
            </p>
            <p>
              5. James will see his three tasks. Try Create task to confirm the
              API blocks staff, then Refresh to see the cache hit.
            </p>
            <button
              className="primary wide"
              disabled={setupBusy}
              onClick={setup}
            >
              {setupBusy ? "Setting up…" : "Set up local accounts"}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export default App;
