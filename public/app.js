// Server data stays in memory. Every untrusted field is rendered as text, never markup.
const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  inspectedUser: null,
  users: [],
  usersReady: false,
  assignableRoles: [],
  inboxes: [],
  inbox: null,
  messages: [],
  message: null,
  messageId: null,
  nextCursor: null,
  inboxStatus: "idle",
  inboxError: "",
  messagesStatus: "idle",
  messagesError: "",
  pageCount: 1,
  messageRetry: {},
  query: "",
};
let epoch = 0;
let mutation = null;
let favoriteMutation = null;
let authBusy = false;
let authOperation = null;
let loginRequired = false;
let logoutUserId;
let logoutFailed = false;
let confirmation = null;
let pollTimer = null;
let noticeTimer = null;
let searchTimer = null;
let statusTimer = null;
let cooldownTimer = null;
let passwordBusy = false;
let userCreateBusy = null;
let userResetBusy = null;
let resetUser = null;
let roleUser = null;
let roleBusy = null;
let notificationBusy = false;
let notificationFailure = "";
let readRevision = 0;
let readerRevision = 0;
const cooldowns = { login: 0, password: 0 };
const refresh = new Map();
const pendingReads = new Set();
const readChanges = new Map();
const notificationWatermarks = new Map();
const unreadWatermarks = new Map();
const openNotifications = new Set();
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
let theme = preference("theme") || "light";
let notificationsEnabled = preference("notifications") === "true";
let soundEnabled = preference("sound") !== "false";
// Notification tone: a built-in name or "kustom" with an operator-supplied file.
let soundTone = preference("sound-tone") || "chime";
let soundVolume = Math.max(0, Math.min(1, Number(preference("sound-volume") ?? "70") / 100));
if (!Number.isFinite(soundVolume)) soundVolume = 0.7;
let customSoundBuffer = null;
let audioContext = null;
const requests = new Map();
const authSignalKey = "plato.auth-change";
const seenAuthSignals = new Set();
let authChannel = null;
const reserved = new Set([
  "admin",
  "postmaster",
  "abuse",
  "security",
  "mailer-daemon",
  "noreply",
  "no-reply",
]);
const dateFormat = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });
const shortDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" });

function text(id, value) {
  $(id).textContent = value ?? "";
}
function show(id, visible = true) {
  $(id).hidden = !visible;
}
function formatDate(seconds, short = false) {
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime())
    ? (short ? shortDate : dateFormat).format(date)
    : "Waktu tidak tersedia";
}
// The list shows the From display name when the sender supplied one, and the
// local part otherwise; the full address stays reachable as the row's title.
function senderName(message) {
  const name = typeof message.fromName === "string" ? message.fromName.trim() : "";
  if (name) return name;
  const address = typeof message.from === "string" ? message.from : "";
  const local = address.split("@")[0];
  return local || "Pengirim tidak diketahui";
}
function senderNode(message) {
  const node = element("span", "message-sender", senderName(message));
  if (message.fromName && message.from) node.title = message.from;
  return node;
}
function senderFull(message) {
  const address = typeof message.from === "string" ? message.from : "";
  const name = typeof message.fromName === "string" ? message.fromName.trim() : "";
  if (name && address) return `${name} <${address}>`;
  return address || "Pengirim tidak diketahui";
}
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
// The one figure only this product has: where a message sits inside its retention
// window. A track as long as the window, the elapsed share filled, the time left
// printed beside it. Both ends are labelled, so the bar cannot be misread.
function renderExpiry(message) {
  const start = Number(message.receivedAt);
  const end = Number(message.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    show("expiry-strip", false);
    return;
  }
  // receivedAt and expiresAt are epoch seconds, the same unit formatDate() converts.
  const now = Date.now() / 1000;
  const span = end - start;
  const ratio = Math.min(Math.max((now - start) / span, 0), 1);
  const leftSeconds = Math.max(end - now, 0);
  const hours = Math.floor(leftSeconds / 3600);
  const left =
    leftSeconds <= 0
      ? "kedaluwarsa"
      : hours >= 48
        ? `${Math.floor(hours / 24)} hari lagi`
        : hours >= 1
          ? `${hours} jam lagi`
          : `${Math.max(1, Math.floor(leftSeconds / 60))} menit lagi`;
  $("expiry-fill").style.width = `${Math.round(ratio * 100)}%`;
  text("expiry-label", `Retensi ${Math.round(span / 86400)} hari`);
  text("expiry-value", left);
  show("expiry-strip", true);
}
function errorText(error) {
  return error instanceof Error ? error.message : "Terjadi kesalahan. Silakan coba lagi.";
}
function isCanceled(error) {
  return error?.name === "AbortError";
}
function setError(id, message) {
  text(id, message);
  show(id, Boolean(message));
}
function announce(message) {
  clearTimeout(noticeTimer);
  text("notice", message);
  show("notice");
  noticeTimer = setTimeout(() => show("notice", false), 4500);
}
function abortRequest(slot) {
  requests.get(slot)?.abort();
  requests.delete(slot);
}
function invalidate() {
  epoch += 1;
  for (const controller of requests.values()) controller.abort();
  requests.clear();
}

async function api(
  path,
  {
    method = "GET",
    body,
    slot = path,
    expireSession = true,
    expectedUserId = state.session?.user?.id,
  } = {},
) {
  abortRequest(slot);
  const controller = new AbortController();
  requests.set(slot, controller);
  const version = epoch;
  // Bind private requests to the displayed principal, never the inspected inbox
  // owner. A shared cookie can change before a cross-tab signal arrives.
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (expectedUserId && path !== "/auth/login" && path !== "/auth/session")
    headers["X-Plato-User"] = expectedUserId;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  const stale = () => version !== epoch || requests.get(slot) !== controller;
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (stale()) throw new DOMException("Stale response", "AbortError");
    let data = null;
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch {
        throw new Error("Respons server tidak valid. Silakan coba lagi.");
      }
    }
    if (stale()) throw new DOMException("Stale response", "AbortError");
    if (!response.ok) {
      const error = new Error(
        data?.error?.message || `Permintaan gagal (${response.status}). Silakan coba lagi.`,
      );
      error.status = response.status;
      error.code = data?.error?.code;
      error.retryAfter = response.headers.get("Retry-After");
      if (
        (error.status === 409 && error.code === "CREDENTIALS_CHANGED") ||
        (error.status === 401 && error.code === "SESSION_CHANGED")
      ) {
        // This principal can no longer retry logout. Release its retry lock,
        // but keep the operation ticket so only its own finally clears authBusy.
        logoutFailed = false;
        logoutUserId = undefined;
        show("retry-logout", false);
        resetPrivate();
        loginRequired = true;
        setError("login-error", error.message);
        // Terminal session errors must never fall through to a form's retry UI,
        // including auth/password, whose ordinary 401 is handled separately.
        error.name = "AbortError";
        throw error;
      }
      if (response.status === 401 && state.session && expireSession) {
        resetPrivate();
        loginRequired = true;
        setError("login-error", "Sesi berakhir. Silakan masuk kembali.");
        error.name = "AbortError";
        throw error;
      }
      throw error;
    }
    return data;
  } catch (error) {
    if (stale()) throw isCanceled(error) ? error : new DOMException("Stale response", "AbortError");
    if (timedOut) throw new Error("Koneksi terlalu lama. Silakan coba lagi.");
    if (error instanceof TypeError)
      throw new Error("Tidak dapat terhubung. Periksa koneksi dan coba lagi.");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (requests.get(slot) === controller) requests.delete(slot);
  }
}

function view(name, focusId) {
  $("workspace").dataset.view = name;
  if (focusId && matchMedia("(max-width: 1023px)").matches) $(focusId).focus();
}
function clearReader() {
  readerRevision += 1;
  abortRequest("detail");
  state.message = null;
  state.messageId = null;
  $("otp-candidates").replaceChildren();
  show("otp-section", false);
  setError("read-error", "");
  if ($("copy-dialog").open) $("copy-dialog").close();
  $("copy-value").value = "";
  for (const id of [
    "message-subject",
    "message-from",
    "message-to",
    "message-received",
    "message-expires",
    "message-body",
  ])
    text(id, "");
  show("message-detail", false);
  show("delete-message", false);
  show("copy-link", false);
  show("attachments-section", false);
  $("attachments-list").replaceChildren();
  $("message-html").srcdoc = "";
  show("message-html", false);
  show("view-text", false);
  show("view-html", false);
  show("reader-state", false);
  show("retry-reader", false);
  show("reader-empty");
}
function clearInbox() {
  abortRequest("messages");
  clearReader();
  state.inbox = null;
  state.messages = [];
  state.nextCursor = null;
  state.messagesStatus = "idle";
  state.messagesError = "";
  state.pageCount = 1;
  state.messageRetry = {};
  clearTimeout(searchTimer);
  searchTimer = null;
  state.query = "";
  $("message-search").value = "";
  show("message-search-form", false);
  refresh.delete("messages");
  text("selected-address", "Pilih kotak masuk");
  show("inbox-actions", false);
  renderMessages();
  updateControls();
}
function resetPrivate() {
  invalidate();
  clearUsers();
  clearDiagnostics();
  stopPolling();
  clearInterval(statusTimer);
  statusTimer = null;
  clearCooldowns();
  clearPasswords();
  passwordBusy = false;
  pendingReads.clear();
  readChanges.clear();
  refresh.clear();
  notificationBusy = false;
  notificationFailure = "";
  notificationWatermarks.clear();
  unreadWatermarks.clear();
  for (const notification of openNotifications) {
    try {
      notification.close();
    } catch {
      /* Browser may already have disposed it. */
    }
  }
  openNotifications.clear();
  clearTimeout(noticeTimer);
  show("notice", false);
  text("notice", "");
  for (const dialog of document.querySelectorAll("dialog[open]")) {
    // A pending password-reset prompt belongs to the visitor, not to the
    // session being torn down; keep it open across a failed session restore.
    if (dialog.id === "reset-dialog" && resetToken) continue;
    dialog.close();
  }
  mutation = null;
  favoriteMutation = null;
  confirmation = null;
  state.session = null;
  state.inspectedUser = null;
  updateTitle();
  show("manage-users", false);
  show("open-diagnostics", false);
  show("open-audit", false);
  $("account-roles").replaceChildren();
  show("inspection-banner", false);
  show("admin-disclosure", false);
  text("inspection-label", "");
  state.inboxes = [];
  state.inboxStatus = "idle";
  state.inboxError = "";
  clearInbox();
  $("inbox-list").replaceChildren();
  text("inbox-count", "0");
  text("inboxes-state", "");
  text("reader-state", "");
  text("account-name", "");
  text("retention-note", "");
  text("create-domain", "");
  $("copy-value").value = "";
  $("local-part").value = "";
  $("inbox-search").value = "";
  $("password").value = "";
  show("login-success", false);
  text("login-success", "");
  text("confirm-description", "");
  setError("create-error", "");
  setError("delete-error", "");
  show("workspace", false);
  show("boot", false);
  show("login");
  view("inboxes");
  updateControls();
}
function updateControls() {
  const busy = Boolean(mutation);
  const messagesBusy = busy && mutation !== favoriteMutation;
  const readOnly = Boolean(state.inspectedUser);
  const peasant = isPeasant();
  const quotaReached = inboxQuotaReached();
  show("new-inbox", !readOnly && !peasant);
  show("delete-inbox", !readOnly && canDeleteInbox());
  show("delete-message", !readOnly && Boolean(state.message));
  show("toggle-read", !readOnly);
  const messageLink = firstHttpLink(state.message?.body);
  show("copy-link", !readOnly && Boolean(messageLink));
  $("copy-link").disabled = busy || readOnly || !messageLink;
  $("new-inbox").disabled = busy || readOnly || peasant || quotaReached;
  $("new-inbox").title = quotaReached ? "Kuota inbox akun ini sudah habis." : "";
  $("create-submit").disabled = busy;
  $("cancel-create").disabled = busy;
  $("confirm-delete").disabled = busy;
  $("cancel-delete").disabled = busy;
  $("delete-inbox").disabled = busy || readOnly || !canDeleteInbox() || !state.inbox;
  $("delete-message").disabled = busy || readOnly || !state.message;
  $("refresh-messages").disabled = !state.inbox || requests.has("messages") || messagesBusy;
  $("refresh-inboxes").disabled = requests.has("inboxes") || busy;
  $("load-more").disabled = requests.has("messages") || messagesBusy;
  $("login-submit").disabled = authBusy || logoutFailed || cooldowns.login > Date.now();
  $("retry-session").disabled = authBusy;
  $("retry-logout").disabled = authBusy;
  $("logout").disabled = authBusy;
  $("account-settings").disabled = busy;
  $("password-submit").disabled = passwordBusy || cooldowns.password > Date.now();
  $("cancel-password").disabled = passwordBusy;
  $("toggle-read").disabled =
    readOnly || !state.message || pendingReads.has(state.messageId) || messagesBusy;
  text("toggle-read", state.message?.isRead ? "Tandai belum dibaca" : "Tandai dibaca");
  $("filter-unread").disabled = !state.inbox;
  $("mark-all-read").disabled = busy || !state.messages.length;
  $("delete-all-messages").disabled = busy || !state.messages.length;
  $("forward-inbox").disabled = busy || !state.inbox;
  for (const button of document.querySelectorAll(".favorite")) button.disabled = busy;
}
function startSession(data, inspectedUser = null) {
  if (!data?.user?.username || typeof data.mailDomain !== "string")
    throw new Error("Respons sesi tidak valid.");
  // Clear all private DOM, dialogs and notification baselines before exposing a new scope.
  resetPrivate();
  state.session = data;
  state.inspectedUser = isOwner() && inspectedUser?.id !== data.user.id ? inspectedUser : null;
  authBusy = false;
  loginRequired = false;
  logoutUserId = undefined;
  logoutFailed = false;
  clearCooldowns();
  show("login-success", false);
  $("password").value = "";
  setError("login-error", "");
  show("retry-session", false);
  show("retry-logout", false);
  text("account-name", data.user.username);
  renderRoleBadges($("account-roles"), rolesOf(data.user));
  show("manage-users", canManageUsers() || canDeleteUsers());
  show("open-diagnostics", canDiagnose());
  show("open-audit", isOwner());
  // Voyager (member) and Quark (peasant) have no API access; the server enforces it too.
  show("open-api", rolesOf(data.user).some((role) => role !== "member" && role !== "peasant"));
  show("admin-disclosure", !isOwner());
  show("inspection-banner", Boolean(state.inspectedUser));
  text(
    "inspection-label",
    state.inspectedUser ? `Inbox ${state.inspectedUser.username} · Hanya baca` : "",
  );
  text("address-caption", state.inspectedUser ? "ALAMAT ANGGOTA" : "ALAMAT ANDA");
  text("create-domain", `@${data.mailDomain}`);
  text("retention-note", `Pesan disimpan selama ${data.retentionDays} hari.`);
  show("boot", false);
  show("login", false);
  show("workspace");
  view("inboxes");
  updateControls();
  startPolling();
  clearInterval(statusTimer);
  statusTimer = null;
  renderNotifications();
  void loadInboxes();
}
async function restoreSession() {
  if (authBusy) return;
  const ticket = Symbol("restore");
  authOperation = ticket;
  authBusy = true;
  updateControls();
  try {
    startSession(await api("/auth/session", { slot: "auth" }));
  } catch (error) {
    if (isCanceled(error)) return;
    resetPrivate();
    if (error.status !== 401) {
      setError("login-error", errorText(error));
      show("retry-session");
    }
  } finally {
    if (authOperation === ticket) {
      authBusy = false;
      updateControls();
    }
  }
}
function reconcileSession(data) {
  const before = state.session?.user;
  const after = data?.user;
  if (!after?.username || typeof data.mailDomain !== "string")
    throw new Error("Respons sesi tidak valid.");
  if (before?.id === after.id && rolesOf(before).join() !== rolesOf(after).join()) {
    requireRoleLogin();
    return;
  }
  if (
    !before ||
    before.id !== after.id ||
    before.username !== after.username ||
    state.session.mailDomain !== data.mailDomain
  )
    startSession(data);
}
async function revalidateSession() {
  if (authBusy || passwordBusy || loginRequired || logoutFailed || requests.has("session-check"))
    return;
  try {
    reconcileSession(await api("/auth/session", { slot: "session-check" }));
  } catch (error) {
    if (!isCanceled(error)) {
      resetPrivate();
      if (error.status !== 401) {
        setError("login-error", errorText(error));
        show("retry-session");
      }
    }
  }
}
function rememberAuthSignal(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce) || seenAuthSignals.has(nonce))
    return false;
  seenAuthSignals.add(nonce);
  if (seenAuthSignals.size > 32) seenAuthSignals.delete(seenAuthSignals.values().next().value);
  return true;
}
function receiveAuthChange(nonce) {
  if (!rememberAuthSignal(nonce)) return;
  // Clearing is synchronous and precedes session resync. Even an auth request
  // already in flight must not restore the previous tab identity afterward.
  resetPrivate();
  authOperation = null;
  authBusy = false;
  logoutFailed = false;
  logoutUserId = undefined;
  loginRequired = false;
  setError("login-error", "");
  text("login-submit", "Masuk");
  void restoreSession();
}
function broadcastAuthChange() {
  const nonce = crypto.randomUUID();
  rememberAuthSignal(nonce);
  try {
    authChannel?.postMessage(nonce);
  } catch {
    // Storage provides a fallback for unavailable/disposed channels.
  }
  try {
    // Only a transient, non-sensitive nonce is written, never an identity or
    // credential. Sending on both transports also supports mixed-capability tabs.
    localStorage.setItem(authSignalKey, nonce);
    localStorage.removeItem(authSignalKey);
  } catch {
    // If both transports are blocked, focus/visibility probes still resync and
    // the expected-principal request header prevents cross-account actions.
  }
}
async function login(event) {
  event.preventDefault();
  unlockAudio();
  if (authBusy || logoutFailed || cooldowns.login > Date.now()) return;
  const ticket = Symbol("login");
  authOperation = ticket;
  abortRequest("session-check");
  authBusy = true;
  updateControls();
  setError("login-error", "");
  show("login-success", false);
  text("login-submit", "Memproses…");
  try {
    startSession(
      await api("/auth/login", {
        method: "POST",
        body: { username: $("username").value.trim(), password: $("password").value },
        slot: "auth",
      }),
    );
    broadcastAuthChange();
  } catch (error) {
    if (!isCanceled(error)) {
      setError("login-error", errorText(error));
      if (error.status === 429) setCooldown("login", error.retryAfter);
    }
  } finally {
    if (authOperation === ticket) {
      $("password").value = "";
      authBusy = false;
      text("login-submit", "Masuk");
      updateControls();
    }
  }
}
async function logout() {
  if (authBusy) return;
  const ticket = Symbol("logout");
  authOperation = ticket;
  // resetPrivate clears session before the network call. Keep the original
  // principal for this request and any deliberate retry, rather than using B.
  logoutUserId = state.session?.user?.id ?? logoutUserId;
  authBusy = true;
  resetPrivate();
  loginRequired = true;
  setError("login-error", "");
  // Focus when login is revealed, before the user can start entering credentials.
  // A delayed response must not redirect password typing into the visible username.
  $("username").focus();
  try {
    await api("/auth/logout", {
      method: "POST",
      body: {},
      slot: "auth",
      expectedUserId: logoutUserId,
    });
    logoutFailed = false;
    show("retry-logout", false);
  } catch (error) {
    if (error.status === 401 && !isCanceled(error)) {
      // Expiry/revocation, including a lost successful logout response, is already signed out.
      logoutFailed = false;
      show("retry-logout", false);
      setError("login-error", "");
    } else if (!isCanceled(error)) {
      logoutFailed = true;
      setError("login-error", `Belum berhasil keluar dari server. ${errorText(error)}`);
      show("retry-logout");
    }
  } finally {
    if (authOperation === ticket) {
      authBusy = false;
      updateControls();
      broadcastAuthChange();
    }
  }
}

function renderInboxes() {
  const filter = $("inbox-search").value.trim().toLowerCase();
  const visible = state.inboxes
    .filter((item) => item.address.toLowerCase().includes(filter))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
  const fragment = document.createDocumentFragment();
  for (const inbox of visible) {
    const li = element("li", "inbox-row");
    const button = element("button", "inbox-item");
    button.type = "button";
    button.setAttribute("aria-label", `Buka kotak masuk ${inbox.address}`);
    button.setAttribute("aria-current", String(inbox.id === state.inbox?.id));
    const label = element("span", "inbox-address", inbox.address);
    label.append(element("span", "inbox-date", `Dibuat ${formatDate(inbox.createdAt, true)}`));
    const unread = Number(inbox.unreadCount) || 0;
    if (unread > 0) {
      label.prepend(element("span", "unread-dot", ""));
      label.append(element("span", "unread-count", `${unread} belum dibaca`));
      button.classList.add("has-unread");
    }
    const badge = element(
      "span",
      unread > 0 ? "badge badge-unread" : "badge",
      String(unread > 0 ? unread : inbox.messageCount),
    );
    badge.setAttribute(
      "aria-label",
      unread > 0 ? `${unread} belum dibaca` : `${inbox.messageCount} pesan`,
    );
    button.append(label, badge);
    button.addEventListener("click", () => selectInbox(inbox));
    const favorite = element("button", "quiet favorite", "");
    favorite.type = "button";
    favorite.setAttribute("aria-label", `Favorit ${inbox.address}`);
    favorite.setAttribute("aria-pressed", String(Boolean(inbox.favorite)));
    favorite.addEventListener("click", () => void toggleFavorite(inbox.id));
    li.append(button);
    if (!state.inspectedUser) li.append(favorite);
    fragment.append(li);
  }
  $("inbox-list").replaceChildren(fragment);
  text("inbox-count", state.inboxes.length);
  updateTitle();
  const status =
    state.inboxStatus === "loading"
      ? "Memuat kotak masuk…"
      : state.inboxStatus === "error"
        ? state.inboxError
        : !state.inboxes.length
          ? state.inspectedUser
            ? "Pengguna ini belum memiliki kotak masuk."
            : "Belum ada kotak masuk. Buat alamat pertama Anda."
          : !visible.length
            ? "Tidak ada hasil. Coba alamat lain."
            : "";
  text("inboxes-state", status);
  show("inboxes-state", Boolean(status));
  $("inboxes-state").classList.toggle("is-error", state.inboxStatus === "error");
  show("retry-inboxes", state.inboxStatus === "error");
  updateControls();
}
async function loadInboxes(quiet = false) {
  if (!state.session || requests.has("inboxes") || mutation || pendingReads.size) return;
  const refreshTicket = beginRefresh("inboxes");
  state.inboxStatus = quiet ? "ready" : "loading";
  renderInboxes();
  try {
    const query = state.inspectedUser
      ? `?${new URLSearchParams({ userId: state.inspectedUser.id })}`
      : "";
    const promise = api(`/inboxes${query}`, { slot: "inboxes" });
    updateControls();
    const data = await promise;
    if (!Array.isArray(data?.inboxes)) throw new Error("Daftar kotak masuk tidak valid.");
    state.inboxes = data.inboxes;
    checkNotifications(data.inboxes, quiet);
    state.inboxStatus = "ready";
    if (state.inbox) {
      const current = state.inboxes.find((item) => item.id === state.inbox.id);
      if (current) state.inbox = current;
      else {
        clearInbox();
        view("inboxes");
      }
    }
    renderInboxes();
    endRefresh("inboxes", refreshTicket, true);
  } catch (error) {
    if (!isCanceled(error)) {
      state.inboxStatus = "error";
      state.inboxError = errorText(error);
      renderInboxes();
      endRefresh("inboxes", refreshTicket, false);
    }
  } finally {
    updateControls();
    cancelRefresh("inboxes", refreshTicket);
  }
}
function selectInbox(inbox) {
  if (!state.session) return;
  if (state.inbox?.id !== inbox.id) {
    clearInbox();
    state.inbox = inbox;
    text("selected-address", inbox.address);
    show("inbox-actions");
    show("message-search-form");
    void loadMessages();
  }
  renderInboxes();
  view("messages", "messages-title");
  updateControls();
}
function renderMessages() {
  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const li = element("li");
    const button = element("button", "message-item");
    button.classList.toggle("is-unread", message.isRead === false);
    button.type = "button";
    button.setAttribute("aria-label", `Baca ${message.subject || "(Tanpa subjek)"}`);
    button.setAttribute("aria-current", String(message.id === state.messageId));
    const top = element("span", "message-top");
    top.append(
      senderNode(message),
      element("span", "message-date", formatDate(message.receivedAt, true)),
    );
    button.append(
      top,
      element("span", "message-summary", message.subject || "(Tanpa subjek)"),
      element("span", "message-preview", message.preview || "Tidak ada pratinjau."),
    );
    if (message.isRead === false)
      button.append(element("span", "badge unread-badge", "Belum dibaca"));
    button.addEventListener("click", () => readMessage(message.id));
    li.append(button);
    fragment.append(li);
  }
  $("message-list").replaceChildren(fragment);
  updateReaderNav();
  const status = !state.inbox
    ? "Pilih kotak masuk untuk melihat pesan."
    : state.messagesStatus === "loading"
      ? "Memuat pesan…"
      : state.messagesStatus === "error"
        ? state.messagesError
        : !state.messages.length
          ? state.query
            ? "Tidak ada hasil untuk pencarian ini."
            : "Belum ada pesan. Pesan baru akan muncul otomatis di sini."
          : "";
  text("messages-state", status);
  show("messages-state", Boolean(status));
  $("messages-state").classList.toggle("is-error", state.messagesStatus === "error");
  show("retry-messages", state.messagesStatus === "error");
  show("load-more", Boolean(state.nextCursor));
  updateControls();
}
async function loadMessages({ more = false, quiet = false } = {}) {
  if (
    !state.session ||
    !state.inbox ||
    requests.has("messages") ||
    (mutation && mutation !== favoriteMutation)
  )
    return;
  if (quiet && state.messagesStatus === "error") return;
  const id = state.inbox.id;
  const cursor = more ? state.nextCursor : null;
  const version = epoch;
  const queryValue = state.query;
  const revision = readRevision;
  if (more && !cursor) return;
  const refreshTicket = beginRefresh("messages");
  state.messageRetry = { more, quiet };
  state.messagesStatus = quiet ? "ready" : "loading";
  renderMessages();
  try {
    // Revalidate the loaded page window atomically so polling cannot resurrect deleted
    // messages, overwrite fresh previews, or discard pages the user already loaded.
    const pageLimit = quiet ? state.pageCount : 1;
    let nextCursor = cursor;
    let loaded = 0;
    const messages = [];
    const seenCursors = new Set();
    do {
      if (seenCursors.has(nextCursor))
        throw new Error("Kursor pesan berulang. Segarkan pesan untuk mencoba lagi.");
      seenCursors.add(nextCursor);
      const params = new URLSearchParams();
      if (queryValue) params.set("q", queryValue);
      if (state.unreadOnly) params.set("filter", "unread");
      if (nextCursor) params.set("cursor", nextCursor);
      const query = params.size ? `?${params}` : "";
      const promise = api(`/inboxes/${encodeURIComponent(id)}/messages${query}`, {
        slot: "messages",
      });
      updateControls();
      const data = await promise;
      if (version !== epoch || state.inbox?.id !== id || state.query !== queryValue) return;
      if (!Array.isArray(data?.messages)) throw new Error("Daftar pesan tidak valid.");
      messages.push(...data.messages);
      nextCursor = data.nextCursor || null;
      loaded += 1;
    } while (nextCursor && loaded < pageLimit);
    const merged = more ? [...state.messages, ...messages] : messages;
    // A read PATCH can finish during this fetch. Merge only newer local changes;
    // later fetches remain authoritative so other sessions can update read state.
    for (const message of merged) {
      const change = readChanges.get(message.id);
      if (change && change.revision > revision) message.isRead = change.isRead;
    }
    state.messages = [...new Map(merged.map((item) => [item.id, item])).values()];
    state.pageCount = more ? state.pageCount + 1 : loaded;
    state.nextCursor = nextCursor;
    state.messageRetry = {};
    if (
      !more &&
      !nextCursor &&
      state.messageId &&
      !state.messages.some((item) => item.id === state.messageId)
    ) {
      clearReader();
      if ($("workspace").dataset.view === "reader") view("messages", "messages-title");
    }
    state.messagesStatus = "ready";
    if (state.message) {
      const current = state.messages.find((item) => item.id === state.messageId);
      if (current && !pendingReads.has(current.id)) state.message.isRead = current.isRead;
    }
    renderMessages();
    endRefresh("messages", refreshTicket, true);
  } catch (error) {
    if (!isCanceled(error) && state.inbox?.id === id && state.query === queryValue) {
      state.messagesStatus = "error";
      state.messagesError = errorText(error);
      state.messageRetry = { more, quiet };
      renderMessages();
      endRefresh("messages", refreshTicket, false);
    }
  } finally {
    updateControls();
    cancelRefresh("messages", refreshTicket);
  }
}
async function readMessage(id) {
  if (!state.session || !state.inbox) return;
  const inboxId = state.inbox.id;
  const revision = readRevision;
  const readPending = pendingReads.has(id);
  clearReader();
  state.messageId = id;
  renderMessages();
  view("reader");
  show("reader-empty", false);
  text("reader-state", "Memuat isi pesan…");
  show("reader-state");
  try {
    const data = await api(`/messages/${encodeURIComponent(id)}`, { slot: "detail" });
    if (state.inbox?.id !== inboxId || state.messageId !== id) return;
    if (!data?.message || data.message.inboxId !== inboxId || data.message.id !== id)
      throw new Error("Pesan tidak sesuai dengan kotak masuk ini.");
    // As with list snapshots, a detail GET cannot undo a newer committed PATCH.
    const change = readChanges.get(id);
    const newerRead = change && change.revision > revision;
    if (newerRead) data.message.isRead = change.isRead;
    state.message = data.message;
    text("message-subject", data.message.subject || "(Tanpa subjek)");
    text("message-from", senderFull(data.message));
    text("message-to", state.inbox.address);
    text("message-received", formatDate(data.message.receivedAt));
    text("message-expires", formatDate(data.message.expiresAt));
    renderExpiry(data.message);
    renderBody(data.message);
    renderAttachments(data.message);
    setupHtmlToggle(data.message);
    renderOtp(data.message);
    show("reader-state", false);
    show("message-detail");
    show("delete-message");
    updateControls();
    view("reader", "message-subject");
    // Reopening during an explicit unread action must not turn that action into
    // an automatic read when its PATCH finishes before this detail response.
    if (!state.inspectedUser && !readPending && !newerRead && data.message.isRead === false)
      void setRead(id, inboxId, true);
  } catch (error) {
    if (!isCanceled(error)) {
      text("reader-state", errorText(error));
      show("retry-reader");
    }
  }
}

function openCreate() {
  if (mutation || !state.session || state.inspectedUser || isPeasant() || inboxQuotaReached())
    return;
  $("create-form").reset();
  $("local-part").removeAttribute("aria-invalid");
  setError("create-error", "");
  $("create-dialog").showModal();
  $("local-part").focus();
}
async function createInbox(event) {
  event.preventDefault();
  if (mutation || !state.session || state.inspectedUser || isPeasant()) return;
  const localPart = $("local-part").value.trim().toLowerCase();
  if (
    localPart &&
    (!/^[a-z0-9](?:[a-z0-9_-]|\.(?=[a-z0-9])){0,31}$/.test(localPart) || reserved.has(localPart))
  ) {
    $("local-part").setAttribute("aria-invalid", "true");
    setError(
      "create-error",
      reserved.has(localPart)
        ? "Nama ini dicadangkan. Pilih nama lain."
        : "Gunakan 1–32 karakter: huruf, angka, titik, - atau _. Titik tidak boleh di awal, akhir, atau berurutan.",
    );
    $("local-part").focus();
    return;
  }
  $("local-part").removeAttribute("aria-invalid");
  setError("create-error", "");
  const ticket = Symbol("create");
  mutation = ticket;
  // An old list fetch must not undo a successfully created or deleted item.
  abortRequest("inboxes");
  updateControls();
  text("create-submit", "Membuat…");
  try {
    const data = await api("/inboxes", {
      method: "POST",
      body: localPart ? { localPart } : {},
      slot: "mutation",
    });
    if (!data?.inbox?.id) throw new Error("Respons alamat baru tidak valid.");
    state.inboxes = [data.inbox, ...state.inboxes.filter((item) => item.id !== data.inbox.id)];
    state.inboxStatus = "ready";
    mutation = null;
    $("inbox-search").value = "";
    $("create-dialog").close();
    selectInbox(data.inbox);
    announce("Alamat baru berhasil dibuat.");
  } catch (error) {
    if (!isCanceled(error)) setError("create-error", errorText(error));
  } finally {
    if (mutation === ticket) mutation = null;
    text("create-submit", "Buat alamat");
    updateControls();
  }
}
async function copyAddress() {
  if (!state.inbox || !state.session) return;
  const inboxId = state.inbox.id;
  await copyValue(state.inbox.address, "Alamat", () => state.inbox?.id === inboxId);
}
async function copyValue(value, label, current) {
  const version = epoch;
  try {
    await navigator.clipboard.writeText(value);
    if (version === epoch && current()) announce(`${label} berhasil disalin.`);
  } catch {
    if (version !== epoch || !current()) return;
    text(
      "copy-title",
      label === "Alamat" ? "Salin alamat" : label === "Link" ? "Salin link" : "Salin kode OTP",
    );
    text("copy-label", `${label} untuk disalin`);
    $("copy-value").value = value;
    $("copy-dialog").showModal();
    $("copy-value").focus();
    $("copy-value").select();
  }
}
function copyMessageLink() {
  const link = firstHttpLink(state.message?.body);
  if (!link) return;
  void copyValue(link, "Link", () => state.message?.body?.includes(link));
}
function confirmDeleteUser(user) {
  if (mutation || !state.session || !canDeleteTarget(user)) return;
  confirmation = { kind: "user", id: user.id, username: user.username };
  text("confirm-title", "Hapus pengguna?");
  text(
    "confirm-description",
    `Akun ${user.username} beserta inbox dan pesannya akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.`,
  );
  setError("delete-error", "");
  $("confirm-dialog").showModal();
  $("cancel-delete").focus();
}
function confirmDelete(kind) {
  if (mutation || !state.session || state.inspectedUser) return;
  const item = kind === "inbox" ? state.inbox : state.message;
  if (!item) return;
  confirmation = { kind, id: item.id, inboxId: state.inbox.id };
  text("confirm-title", kind === "inbox" ? "Hapus kotak masuk?" : "Hapus pesan?");
  text(
    "confirm-description",
    kind === "inbox"
      ? `Alamat ${item.address} dan semua pesannya akan dihapus. Tindakan ini tidak dapat dibatalkan.`
      : `Pesan “${item.subject || "(Tanpa subjek)"}” akan dihapus permanen.`,
  );
  setError("delete-error", "");
  $("confirm-dialog").showModal();
  $("cancel-delete").focus();
}
async function deleteConfirmed() {
  if (mutation || !confirmation || !state.session) return;
  if (confirmation.kind !== "user" && state.inspectedUser) return;
  const target = confirmation;
  const ticket = Symbol("delete");
  const version = epoch;
  // Mobile back navigation may already have aborted this loading reader.
  const interruptedReader =
    state.messageId && !state.message && $("retry-reader").hidden ? readerRevision : null;
  mutation = ticket;
  abortRequest("inboxes");
  abortRequest("messages");
  abortRequest("detail");
  updateControls();
  text("confirm-delete", "Menghapus…");
  try {
    if (target.kind === "all") {
      await api(`/inboxes/${encodeURIComponent(target.id)}/messages`, {
        method: "DELETE",
        slot: "mutation",
      });
      $("confirm-dialog").close();
      confirmation = null;
      state.messages = [];
      state.nextCursor = null;
      state.messageId = null;
      clearReader();
      renderMessages();
      void loadInboxes(true);
      view("messages", "messages-title");
      announce("Semua pesan dihapus.");
      return;
    }
    const path =
      target.kind === "inbox" ? "inboxes" : target.kind === "message" ? "messages" : "admin/users";
    await api(`/${path}/${encodeURIComponent(target.id)}`, {
      method: "DELETE",
      slot: "mutation",
    });
    $("confirm-dialog").close();
    confirmation = null;
    if (target.kind === "user") {
      state.users = state.users.filter((item) => item.id !== target.id);
      renderUsers();
      announce("Pengguna dihapus.");
      return;
    }
    if (target.kind === "inbox") {
      state.inboxes = state.inboxes.filter((item) => item.id !== target.id);
      if (state.inbox?.id === target.id) {
        clearInbox();
        view("inboxes", "inbox-search");
      }
    } else {
      state.messages = state.messages.filter((item) => item.id !== target.id);
      const inbox = state.inboxes.find((item) => item.id === target.inboxId);
      if (inbox) inbox.messageCount = Math.max(0, inbox.messageCount - 1);
      if (state.messageId === target.id) {
        clearReader();
        view("messages", "messages-title");
      }
    }
    state.inboxStatus = "ready";
    state.messagesStatus = "ready";
    renderInboxes();
    renderMessages();
    announce(target.kind === "inbox" ? "Kotak masuk dihapus." : "Pesan dihapus.");
  } catch (error) {
    if (!isCanceled(error)) {
      setError("delete-error", errorText(error));
      if (
        version === epoch &&
        interruptedReader === readerRevision &&
        state.inbox?.id === target.inboxId &&
        state.messageId &&
        !state.message &&
        !requests.has("detail")
      ) {
        text("reader-state", "Pemuatan terhenti. Silakan coba lagi.");
        show("reader-state");
        show("retry-reader");
      }
    }
  } finally {
    if (mutation === ticket) mutation = null;
    text("confirm-delete", "Ya, hapus");
    updateControls();
  }
}
const POLL_MS = 3000;
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
function startPolling() {
  stopPolling();
  const visible = document.visibilityState === "visible";
  // A temporary inbox is checked every 3s while the tab is visible, so an arrival
  // reaches the sound and the list almost immediately instead of up to 30s later.
  if (!state.session || !visible) return;
  pollTimer = setInterval(() => {
    if (
      document.visibilityState !== "visible" ||
      !state.session ||
      mutation ||
      pendingReads.size ||
      !navigator.onLine
    )
      return;
    void loadInboxes(true);
    if (state.inbox) void loadMessages({ quiet: true });
  }, POLL_MS);
}

// Only these non-secret preferences are persisted. Storage can be blocked by the browser.
function preference(key, value) {
  try {
    if (value !== undefined) localStorage.setItem(`plato.${key}`, value);
    return localStorage.getItem(`plato.${key}`);
  } catch {
    return null;
  }
}
function applyTheme() {
  if (!["light", "dark", "system"].includes(theme)) theme = "system";
  document.documentElement.dataset.theme =
    theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
  $("login-theme").value = theme;
  $("workspace-theme").value = theme;
}
function clearPasswords() {
  for (const id of ["current-password", "new-password", "confirm-password"]) $(id).value = "";
  setError("password-error", "");
}
function clearCooldowns() {
  clearInterval(cooldownTimer);
  cooldownTimer = null;
  cooldowns.login = 0;
  cooldowns.password = 0;
  renderCooldowns();
}
function setCooldown(kind, header) {
  const raw = header?.trim() || "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const date = /^[A-Za-z]{3},/.test(raw) ? Date.parse(raw) : NaN;
  // Invalid/missing Retry-After gets a conservative UI delay, never an automatic retry.
  const deadline = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : date;
  cooldowns[kind] = Number.isFinite(deadline) ? Math.max(Date.now(), deadline) : Date.now() + 60000;
  clearInterval(cooldownTimer);
  renderCooldowns();
  cooldownTimer = setInterval(renderCooldowns, 250);
}
function renderCooldowns() {
  let active = false;
  for (const kind of ["login", "password"]) {
    const seconds = Math.max(0, Math.ceil((cooldowns[kind] - Date.now()) / 1000));
    active ||= seconds > 0;
    text(
      `${kind}-retry`,
      seconds ? `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.` : "",
    );
    show(`${kind}-retry`, seconds > 0);
  }
  if (!active) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  updateControls();
}
let sessionsBusy = false;
let auditBusy = false;

const auditLabels = {
  "user.create": "membuat akun",
  "user.delete": "menghapus akun",
  "user.password_reset": "mereset kata sandi",
  "user.roles": "mengubah peran",
  "auth.password_change": "mengganti kata sandi",
  "auth.password_reset": "reset kata sandi",
};

function deviceLabel(userAgent) {
  const value = userAgent || "";
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /OPR\//.test(value)
      ? "Opera"
      : /Chrome\//.test(value)
        ? "Chrome"
        : /Firefox\//.test(value)
          ? "Firefox"
          : /Safari\//.test(value)
            ? "Safari"
            : "Peramban";
  const system = /Windows/.test(value)
    ? "Windows"
    : /Android/.test(value)
      ? "Android"
      : /iPhone|iPad/.test(value)
        ? "iOS"
        : /Mac OS X/.test(value)
          ? "macOS"
          : /Linux/.test(value)
            ? "Linux"
            : "perangkat";
  return `${browser} · ${system}`;
}

function clearSessions() {
  $("sessions-list").replaceChildren();
  text("sessions-status", "");
}

function renderSessions(sessions) {
  const list = $("sessions-list");
  if (!sessions.length) {
    list.replaceChildren(element("li", "small", "Tidak ada sesi lain."));
    return;
  }
  list.replaceChildren(
    ...sessions.map((item) => {
      const li = element("li", "session-row");
      const main = element("div", "session-main");
      main.append(element("strong", "", deviceLabel(item.userAgent)));
      main.append(
        element(
          "span",
          "inbox-date",
          `IP ${item.ip || "tidak diketahui"} · mulai ${formatDate(item.createdAt, true)}`,
        ),
      );
      li.append(main);
      if (item.current) li.append(element("span", "badge", "perangkat ini"));
      else {
        const revoke = element("button", "small-button danger-text", "Cabut");
        revoke.type = "button";
        revoke.setAttribute("aria-label", "Cabut sesi ini");
        revoke.addEventListener("click", () => void revokeOneSession(item.id));
        li.append(revoke);
      }
      return li;
    }),
  );
}

async function loadSessions() {
  if (!state.session || sessionsBusy) return;
  sessionsBusy = true;
  text("sessions-status", "Memuat sesi.");
  try {
    const data = await api("/auth/sessions", { slot: "sessions" });
    if (!Array.isArray(data?.sessions)) throw new Error("Daftar sesi tidak valid.");
    renderSessions(data.sessions);
    text("sessions-status", "");
  } catch (error) {
    if (!isCanceled(error)) text("sessions-status", errorText(error));
  } finally {
    sessionsBusy = false;
  }
}

async function revokeOneSession(id) {
  if (sessionsBusy) return;
  sessionsBusy = true;
  text("sessions-status", "Mencabut sesi.");
  try {
    await api(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE", slot: "sessions" });
    text("sessions-status", "Sesi dicabut.");
  } catch (error) {
    if (!isCanceled(error)) text("sessions-status", errorText(error));
  } finally {
    sessionsBusy = false;
  }
  void loadSessions();
}

async function revokeOtherSessions() {
  if (sessionsBusy) return;
  sessionsBusy = true;
  text("sessions-status", "Mencabut sesi lain.");
  try {
    const data = await api("/auth/sessions/others", {
      method: "DELETE",
      slot: "sessions",
    });
    text("sessions-status", `${data?.revoked ?? 0} sesi lain dicabut.`);
  } catch (error) {
    if (!isCanceled(error)) text("sessions-status", errorText(error));
  } finally {
    sessionsBusy = false;
  }
  void loadSessions();
}

function openAudit() {
  if (!isOwner() || auditBusy) return;
  setError("audit-error", "");
  text("audit-status", "Memuat riwayat.");
  $("audit-list").replaceChildren();
  $("audit-dialog").showModal();
  void loadAudit();
}

async function loadAudit() {
  if (!isOwner() || auditBusy) return;
  auditBusy = true;
  text("audit-status", "Memuat riwayat.");
  setError("audit-error", "");
  try {
    const data = await api("/admin/audit", { slot: "audit" });
    if (!Array.isArray(data?.entries)) throw new Error("Riwayat tidak valid.");
    const list = $("audit-list");
    if (!data.entries.length)
      list.replaceChildren(element("li", "small", "Belum ada aksi tercatat."));
    else
      list.replaceChildren(
        ...data.entries.map((entry) => {
          const li = element("li", "audit-row");
          const line = element(
            "strong",
            "",
            `${entry.actor} ${auditLabels[entry.action] ?? entry.action}${entry.target ? ` ${entry.target}` : ""}`,
          );
          li.append(line);
          li.append(
            element("span", "inbox-date", `${formatDate(entry.createdAt)} · IP ${entry.ip}`),
          );
          return li;
        }),
      );
    text("audit-status", "");
  } catch (error) {
    if (!isCanceled(error)) {
      text("audit-status", "");
      setError("audit-error", errorText(error));
    }
  } finally {
    auditBusy = false;
  }
}
let pendingLink = "";

function shortenUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`.slice(0, 52);
  } catch {
    return value.slice(0, 52);
  }
}

function renderBody(message) {
  const target = $("message-body");
  target.replaceChildren();
  const body = message.body || "(Pesan ini tidak berisi teks.)";
  const pattern = /https?:\/\/[^\s<>"'\])]+/gi;
  let last = 0;
  let match = pattern.exec(body);
  while (match) {
    const raw = match[0];
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (match.index > last) target.append(document.createTextNode(body.slice(last, match.index)));
    const chip = element("button", "link-chip", shortenUrl(url));
    chip.type = "button";
    chip.title = url;
    chip.addEventListener("click", () => confirmLink(url));
    target.append(chip);
    last = match.index + url.length;
    if (last < match.index + raw.length)
      target.append(document.createTextNode(raw.slice(url.length)));
    match = pattern.exec(body);
  }
  if (last < body.length) target.append(document.createTextNode(body.slice(last)));
}

function confirmLink(url) {
  pendingLink = url;
  let host = "domain tidak dikenal";
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the fallback */
  }
  text("link-host", host);
  text("link-url", url);
  $("link-dialog").showModal();
  $("cancel-link").focus();
}

function openPendingLink() {
  if (!pendingLink) return;
  window.open(pendingLink, "_blank", "noopener,noreferrer");
  $("link-dialog").close();
}

function copyPendingLink() {
  if (!pendingLink) return;
  void copyValue(pendingLink, "Link", () => true);
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachments(message) {
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  $("attachments-list").replaceChildren(
    ...files.map((file) => {
      const li = element("li", "attachment-row");
      li.append(element("strong", "", file.name || "lampiran"));
      li.append(
        element("span", "inbox-date", `${file.type || "tak dikenal"} · ${formatSize(file.size)}`),
      );
      return li;
    }),
  );
  show("attachments-section", files.length > 0);
}

function renderSafeHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  for (const selector of [
    "script",
    "style",
    "link",
    "meta",
    "base",
    "iframe",
    "frame",
    "object",
    "embed",
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "form",
    "input",
    "button",
    "svg",
    "math",
  ])
    for (const node of doc.querySelectorAll(selector)) node.remove();
  for (const node of doc.body.querySelectorAll("*"))
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
  const css =
    "html,body{margin:0;background:#fff;color:#131416;font:14px/1.6 'IBM Plex Sans',system-ui,sans-serif}body{padding:16px;overflow-wrap:anywhere}";
  $("message-html").srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>${css}</style>${doc.body.innerHTML}`;
}

function setHtmlView(enabled, message = state.message) {
  if (!message) return;
  if (enabled) {
    renderSafeHtml(message.html);
    show("message-body", false);
    show("message-html");
  } else {
    show("message-html", false);
    show("message-body");
  }
  $("view-text").setAttribute("aria-pressed", String(!enabled));
  $("view-html").setAttribute("aria-pressed", String(enabled));
}

function setupHtmlToggle(message) {
  const available = typeof message.html === "string" && message.html.trim().length > 0;
  show("view-text", available);
  show("view-html", available);
  setHtmlView(false, message);
}

function updateReaderNav() {
  const index = state.messages.findIndex((item) => item.id === state.messageId);
  const previous = index > 0 ? state.messages[index - 1] : null;
  const next = index >= 0 && index < state.messages.length - 1 ? state.messages[index + 1] : null;
  $("prev-message").disabled = !previous;
  $("next-message").disabled = !next;
  $("prev-message").dataset.id = previous?.id ?? "";
  $("next-message").dataset.id = next?.id ?? "";
}

function stepMessage(delta) {
  const index = state.messages.findIndex((item) => item.id === state.messageId);
  if (index < 0) return;
  const target = state.messages[index + delta];
  if (target) void readMessage(target.id);
}

function moveMessageSelection(delta) {
  const items = [...document.querySelectorAll("#message-list .message-item")];
  if (!items.length) return;
  let index = items.findIndex((item) => item.getAttribute("aria-current") === "true");
  if (index < 0) index = delta > 0 ? -1 : items.length;
  index = Math.max(0, Math.min(items.length - 1, index + delta));
  for (const [position, item] of items.entries())
    item.setAttribute("aria-current", String(position === index));
  items[index].scrollIntoView({ block: "nearest" });
}

function setUnreadFilter(enabled) {
  state.unreadOnly = enabled;
  $("filter-unread").setAttribute("aria-pressed", String(enabled));
  state.nextCursor = null;
  state.pageCount = 1;
  void loadMessages();
}

async function markAllRead() {
  if (mutation || !state.inbox || !state.messages.length) return;
  const ticket = Symbol("mark-all");
  mutation = ticket;
  updateControls();
  try {
    await api(`/inboxes/${encodeURIComponent(state.inbox.id)}/read-all`, {
      method: "POST",
      body: {},
      slot: "mutation",
    });
    for (const message of state.messages) message.isRead = true;
    if (state.message) state.message.isRead = true;
    renderMessages();
    updateControls();
    void loadInboxes(true);
    if (state.unreadOnly) void loadMessages();
    announce("Semua pesan ditandai dibaca.");
  } catch (error) {
    if (!isCanceled(error)) announce(errorText(error));
  } finally {
    if (mutation === ticket) mutation = null;
    updateControls();
  }
}

function confirmDeleteAll() {
  if (mutation || !state.inbox) return;
  confirmation = { kind: "all", id: state.inbox.id };
  text("confirm-title", "Hapus semua pesan?");
  text(
    "confirm-description",
    `Semua pesan di ${state.inbox.address} akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.`,
  );
  setError("delete-error", "");
  $("confirm-dialog").showModal();
  $("cancel-delete").focus();
}

function openForward() {
  if (!state.inbox || mutation) return;
  $("forward-url").value = state.inbox.webhookUrl || "";
  setError("forward-error", "");
  text("forward-status", "");
  $("forward-dialog").showModal();
  $("forward-url").focus();
}

async function saveForward(event) {
  event.preventDefault();
  if (!state.inbox || mutation) return;
  const value = $("forward-url").value.trim();
  setError("forward-error", "");
  text("forward-status", "Menyimpan.");
  try {
    const data = await api(`/inboxes/${encodeURIComponent(state.inbox.id)}/webhook`, {
      method: "PUT",
      body: { url: value || null },
      slot: "mutation",
    });
    state.inbox.webhookUrl = data?.webhook ? value : null;
    renderInboxes();
    text("forward-status", "");
    $("forward-dialog").close();
    announce(value ? "Penerusan diaktifkan." : "Penerusan dimatikan.");
  } catch (error) {
    if (!isCanceled(error)) {
      setError("forward-error", errorText(error));
      text("forward-status", "");
    }
  }
}

function updateTitle() {
  const unread = state.inboxes.reduce((total, inbox) => total + (inbox.unreadCount || 0), 0);
  document.title = unread > 0 ? `(${unread}) Haldgoff Mail` : "Haldgoff Mail — Kotak masuk privat";
}
function openPassword() {
  if (!state.session || mutation) return;
  clearPasswords();
  renderCooldowns();
  $("password-dialog").showModal();
  void loadSessions();
  $("current-password").focus();
}
async function changePassword(event) {
  event.preventDefault();
  if (!state.session || passwordBusy || mutation || cooldowns.password > Date.now()) return;
  const currentPassword = $("current-password").value;
  const newPassword = $("new-password").value;
  let message = "";
  if (!currentPassword) message = "Isi kata sandi saat ini.";
  else if (newPassword.length < 5 || newPassword.length > 1024 || !newPassword.trim())
    message = "Kata sandi baru harus 5–1024 karakter dan tidak boleh kosong.";
  else if (newPassword === currentPassword)
    message = "Kata sandi baru harus berbeda dari kata sandi saat ini.";
  else if (newPassword !== $("confirm-password").value)
    message = "Konfirmasi kata sandi belum sama.";
  setError("password-error", message);
  if (message) return;
  const ticket = Symbol("password");
  const version = epoch;
  mutation = ticket;
  passwordBusy = true;
  const interrupted = {
    inboxes: requests.has("inboxes"),
    messages: requests.has("messages"),
    detail: requests.has("detail"),
  };
  // Avoid a concurrent poll interpreting password revocation as unexpected session expiry.
  for (const slot of ["inboxes", "messages", "detail", "session-check"]) abortRequest(slot);
  updateControls();
  try {
    await api("/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
      slot: "password",
      expireSession: false,
    });
    resetPrivate();
    loginRequired = true;
    broadcastAuthChange();
    logoutFailed = false;
    setError("login-error", "");
    text("login-success", "Kata sandi berhasil diubah. Masuk kembali dengan kata sandi baru.");
    show("login-success");
    $("password").focus();
  } catch (error) {
    if (!isCanceled(error)) {
      setError("password-error", errorText(error));
      // Aborted reads still need a deliberate recovery path if the account change fails.
      const retry = "Pemuatan terhenti. Silakan coba lagi.";
      if (interrupted.inboxes) {
        state.inboxStatus = "error";
        state.inboxError = retry;
        renderInboxes();
      }
      if (interrupted.messages) {
        state.messagesStatus = "error";
        state.messagesError = retry;
        renderMessages();
      }
      if (interrupted.detail && state.messageId && !state.message) {
        text("reader-state", retry);
        show("retry-reader");
      }
      if (error.status === 429) setCooldown("password", error.retryAfter);
      // 401 can mean a wrong current password, not an expired session.
      if (error.status === 401) {
        try {
          reconcileSession(await api("/auth/session", { slot: "password-session" }));
        } catch (sessionError) {
          if (!isCanceled(sessionError))
            setError(
              "password-error",
              `${errorText(error)} Sesi belum dapat diperiksa. Coba lagi.`,
            );
        }
      }
    }
  } finally {
    if (mutation === ticket) mutation = null;
    if (version === epoch) passwordBusy = false;
    updateControls();
  }
}
function beginRefresh(kind) {
  const ticket = Symbol(kind);
  refresh.set(kind, { ...refresh.get(kind), ticket, pending: true });
  return ticket;
}
function endRefresh(kind, ticket, success) {
  const item = refresh.get(kind);
  if (item?.ticket !== ticket) return;
  item.pending = false;
  item.failed = !success;
  if (success) item.lastSuccess = Date.now();
}
function cancelRefresh(kind, ticket) {
  const item = refresh.get(kind);
  if (item?.ticket === ticket) item.pending = false;
}
function searchMessages(event) {
  event?.preventDefault();
  clearTimeout(searchTimer);
  searchTimer = null;
  if (!state.inbox) return;
  const query = $("message-search").value.slice(0, 200);
  if (state.query !== query) {
    abortRequest("messages");
    clearReader();
    state.query = query;
    state.messages = [];
    state.nextCursor = null;
    state.pageCount = 1;
    state.messageRetry = {};
    state.messagesStatus = "idle";
    refresh.delete("messages");
    renderMessages();
  }
  if (event?.type === "input") {
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void loadMessages();
    }, 350);
  } else void loadMessages();
}
async function toggleFavorite(id) {
  if (!state.session || mutation || state.inspectedUser) return;
  const inbox = state.inboxes.find((item) => item.id === id);
  if (!inbox) return;
  const favorite = !inbox.favorite;
  const ticket = Symbol("favorite");
  mutation = ticket;
  // Keep inbox/destructive operations serialized, but allow message intents.
  favoriteMutation = ticket;
  abortRequest("inboxes");
  updateControls();
  try {
    await api(`/inboxes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { favorite },
      slot: "mutation",
    });
    inbox.favorite = favorite;
    renderInboxes();
    announce(
      favorite ? "Kotak masuk ditambahkan ke favorit." : "Kotak masuk dihapus dari favorit.",
    );
  } catch (error) {
    if (!isCanceled(error)) announce(errorText(error));
  } finally {
    if (mutation === ticket) mutation = null;
    if (favoriteMutation === ticket) favoriteMutation = null;
    updateControls();
  }
}
async function setRead(id, inboxId, isRead) {
  if (
    !state.session ||
    (mutation && mutation !== favoriteMutation) ||
    state.inspectedUser ||
    pendingReads.has(id)
  )
    return;
  const version = epoch;
  const wasRead =
    state.messageId === id
      ? state.message?.isRead
      : state.messages.find((item) => item.id === id)?.isRead;
  pendingReads.add(id);
  abortRequest("inboxes");
  setError("read-error", "");
  updateControls();
  try {
    await api(`/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { isRead },
      slot: `read:${id}`,
    });
    readRevision += 1;
    readChanges.set(id, { revision: readRevision, isRead });
    const item = state.messages.find((message) => message.id === id);
    if (item) item.isRead = isRead;
    if (state.messageId === id && state.message) state.message.isRead = isRead;
    const inbox = state.inboxes.find((item) => item.id === inboxId);
    if (inbox && typeof wasRead === "boolean" && wasRead !== isRead)
      inbox.unreadCount = Math.max(0, (inbox.unreadCount || 0) + (isRead ? -1 : 1));
    renderInboxes();
    renderMessages();
  } catch (error) {
    if (!isCanceled(error) && state.inbox?.id === inboxId && state.messageId === id)
      setError(
        "read-error",
        `${errorText(error)} Status baca belum tersimpan. Coba tombol tandai lagi.`,
      );
  } finally {
    if (version === epoch) {
      pendingReads.delete(id);
      updateControls();
      void loadInboxes(true);
    }
  }
}
function renderOtp(message) {
  const candidates = new Set();
  // Match nearby words within a sentence, never arbitrary long IDs, embedded digits or years.
  const keyword = /\b(?:otp|verification|verify|verifikasi|kode|login|one[- ]time)\b/i;
  for (const sentence of `${message.subject || ""}\n${message.body || ""}`.split(/[\n.!?]/)) {
    for (const match of sentence.matchAll(/(?<![\w-])\d{4,8}(?![\w-])/g)) {
      const value = match[0];
      if (value.length === 4 && Number(value) >= 1900 && Number(value) <= 2099) continue;
      const before = sentence.slice(Math.max(0, match.index - 48), match.index);
      const after = sentence.slice(match.index + value.length, match.index + value.length + 48);
      if (!keyword.test(before) && !keyword.test(after)) continue;
      if (
        /\b(?:tracking|order|invoice|reference|shipment|tahun|year|phone|telepon)\b/i.test(
          `${before} ${after}`,
        )
      )
        continue;
      candidates.add(value);
    }
  }
  $("otp-candidates").replaceChildren();
  for (const value of candidates) {
    const button = element("button", "small-button", value);
    button.type = "button";
    button.setAttribute("aria-label", `Salin kode ${value}`);
    button.addEventListener(
      "click",
      () =>
        void copyValue(
          value,
          "Kode OTP",
          () => state.messageId === message.id && state.inbox?.id === message.inboxId,
        ),
    );
    $("otp-candidates").append(button);
  }
  show("otp-section", candidates.size > 0);
}
function renderNotifications() {
  const supported = typeof Notification !== "undefined";
  const denied = supported && Notification.permission === "denied";
  const enabled = supported && Notification.permission === "granted" && notificationsEnabled;
  $("notification-toggle").disabled =
    Boolean(state.inspectedUser) || !supported || denied || notificationBusy;
  $("notification-toggle").setAttribute("aria-pressed", String(enabled));
  text(
    "notification-status",
    state.inspectedUser
      ? "Notifikasi dijeda saat melihat inbox anggota."
      : !supported
        ? "Browser tidak mendukung notifikasi."
        : denied
          ? "Izin notifikasi ditolak. Ubah izin melalui pengaturan browser."
          : notificationBusy
            ? "Menunggu izin browser…"
            : notificationFailure ||
              (enabled ? "Notifikasi aktif." : "Notifikasi nonaktif. Aktifkan untuk meminta izin."),
  );
}
async function toggleNotifications() {
  if (
    !state.session ||
    state.inspectedUser ||
    notificationBusy ||
    typeof Notification === "undefined" ||
    Notification.permission === "denied"
  )
    return;
  const version = epoch;
  notificationFailure = "";
  if (notificationsEnabled && Notification.permission === "granted") {
    notificationsEnabled = false;
    preference("notifications", "false");
    renderNotifications();
    return;
  }
  notificationBusy = true;
  renderNotifications();
  try {
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (version !== epoch || !state.session) return;
    notificationsEnabled = permission === "granted";
    preference("notifications", String(notificationsEnabled));
  } catch {
    if (version === epoch) notificationFailure = "Notifikasi tidak tersedia di browser ini.";
  } finally {
    if (version === epoch) {
      notificationBusy = false;
      renderNotifications();
    }
  }
}
function unlockAudio() {
  try {
    if (!audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioContext = new AudioContext();
    }
    if (audioContext.state === "suspended") void audioContext.resume();
  } catch {
    // Audio is a best-effort enhancement; the unread UI still works.
  }
}

// One entry per selectable tone: a list of beeps, each with its own start offset.
const SOUND_TONES = {
  chime: [
    { frequency: 880, delay: 0, duration: 0.12 },
    { frequency: 1174.66, delay: 0.14, duration: 0.14 },
  ],
  bell: [{ frequency: 1046.5, delay: 0, duration: 0.4 }],
  blip: [
    { frequency: 660, delay: 0, duration: 0.07 },
    { frequency: 990, delay: 0.09, duration: 0.08 },
  ],
  marimba: [
    { frequency: 523.25, delay: 0, duration: 0.22 },
    { frequency: 659.25, delay: 0.11, duration: 0.22 },
    { frequency: 783.99, delay: 0.22, duration: 0.28 },
  ],
};

// Plays from an already-decoded buffer when the operator supplied their own file,
// so there is no fetch or decode between the arrival and the sound.
function playNotificationSound() {
  if (!soundEnabled) return;
  unlockAudio();
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    // A suspended context only happens before the first gesture. Resume and play
    // immediately after, so the first arrival is not silent.
    void audioContext.resume().then(() => playNotificationSound()).catch(() => {});
    return;
  }
  if (audioContext.state !== "running") return;
  const context = audioContext;
  const volume = Math.max(0, Math.min(1, soundVolume));
  if (volume === 0) return;

  if (soundTone === "kustom") {
    if (!customSoundBuffer) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = customSoundBuffer;
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start(); // starts on the next render quantum: no scheduling delay
    return;
  }

  for (const { frequency, delay, duration } of SOUND_TONES[soundTone] ?? SOUND_TONES.chime) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const at = context.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18 * volume, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }
}

// The page CSP is connect-src 'self', so a data: URL cannot be fetched and a
// custom tone would never decode. Parse the data URL ourselves instead.
function bytesFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  let binary;
  try {
    binary = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Chunked because spreading a 400 KB array into String.fromCharCode overflows the stack.
function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function decodeCustomSound(dataUrl) {
  if (!dataUrl) {
    customSoundBuffer = null;
    return false;
  }
  unlockAudio();
  if (!audioContext) return false;
  const bytes = bytesFromDataUrl(dataUrl);
  if (!bytes || !bytes.length) {
    customSoundBuffer = null;
    return false;
  }
  try {
    // decodeAudioData detaches its input, so hand it a private copy.
    customSoundBuffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
    return true;
  } catch {
    customSoundBuffer = null;
    return false;
  }
}

function renderSound() {
  const button = $("sound-toggle");
  button.setAttribute("aria-pressed", String(soundEnabled));
  button.textContent = soundEnabled ? "Suara aktif" : "Suara mati";
  const select = $("sound-tone");
  if (select) select.value = soundTone;
  const range = $("sound-volume");
  if (range) range.value = String(Math.round(soundVolume * 100));
  const pick = $("sound-file-pick");
  if (pick) pick.hidden = soundTone !== "kustom";
  const note = $("sound-custom-note");
  if (note) note.hidden = !(soundTone === "kustom" && !customSoundBuffer);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  preference("sound", String(soundEnabled));
  renderSound();
  if (soundEnabled) {
    unlockAudio();
    playNotificationSound();
  }
}

function checkNotifications(inboxes, polling) {
  if (state.inspectedUser) return;
  let arrived = false;
  let unreadArrived = false;
  for (const inbox of inboxes) {
    const latest = inbox.latestArrival;
    const unread = Number(inbox.unreadCount) || 0;
    const previousUnread = unreadWatermarks.get(inbox.id);
    if (previousUnread !== undefined && unread > previousUnread) unreadArrived = true;
    unreadWatermarks.set(inbox.id, unread);
    // Never infer arrivals from IDs/counts or coerce a missing sequence to zero.
    if (!Number.isSafeInteger(latest) || latest < 0) continue;
    const previous = notificationWatermarks.get(inbox.id);
    if (previous !== undefined && latest > previous) arrived = true;
    // First discovery establishes a baseline. Deletion/expiry can decrease the
    // live maximum (even to zero), but the session watermark must never decrease.
    notificationWatermarks.set(inbox.id, Math.max(previous ?? 0, latest));
  }
  if (!state.session) return;
  if (soundEnabled && (arrived || unreadArrived)) playNotificationSound();
  if (!arrived || !polling) return;
  if (
    !notificationsEnabled ||
    !polling ||
    document.visibilityState !== "visible" ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification("Haldgoff Mail", {
      body: "Ada pesan baru. Buka aplikasi untuk membaca.",
    });
    openNotifications.add(notification);
    notification.onclose = () => openNotifications.delete(notification);
  } catch {
    notificationFailure = "Browser ini tidak dapat menampilkan notifikasi saat aplikasi terbuka.";
    renderNotifications();
  }
}

const roleLabels = {
  peasant: "Quark",
  member: "Voyager",
  member_paid: "Stardust",
  dev: "Astral",
  admin: "Cosmos",
  owner: "Celestial",
};
const roleOrder = Object.keys(roleLabels);
function validRoles(roles) {
  return (
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.every((role) => roleOrder.includes(role)) &&
    new Set(roles).size === roles.length
  );
}
function rolesOf(user) {
  // An explicit roles field is authoritative, even if malformed. Never elevate
  // via the compatibility field when the new field is present.
  if (user && Object.hasOwn(user, "roles"))
    return validRoles(user.roles) ? roleOrder.filter((role) => user.roles.includes(role)) : [];
  return user?.role === "owner" ? ["owner"] : user?.role === "user" ? ["member"] : [];
}
function isOwner() {
  return rolesOf(state.session?.user).includes("owner");
}
function isPeasant() {
  return rolesOf(state.session?.user).includes("peasant");
}
function canDeleteInbox() {
  const roles = rolesOf(state.session?.user);
  return roles.some((role) => role === "admin" || role === "dev" || role === "owner");
}
function inboxQuotaReached() {
  const roles = rolesOf(state.session?.user);
  if (roles.some((role) => role === "admin" || role === "dev" || role === "owner")) return false;
  if (roles.includes("peasant")) return true;
  if (roles.includes("member_paid")) {
    const year = new Date().getUTCFullYear();
    return (
      state.inboxes.filter(
        (inbox) => new Date((inbox.createdAt ?? 0) * 1000).getUTCFullYear() === year,
      ).length >= 100
    );
  }
  if (roles.includes("member")) return state.inboxes.length >= 6;
  return false;
}
function canManageUsers() {
  return isOwner() || rolesOf(state.session?.user).includes("admin");
}
function canDeleteUsers() {
  return (
    isOwner() || rolesOf(state.session?.user).some((role) => role === "admin" || role === "dev")
  );
}
function canDeleteTarget(user) {
  if (!canDeleteUsers() || !user || user.id === "owner") return false;
  if (user.id === state.session?.user?.id) return false;
  const roles = rolesOf(user);
  return (
    roles.length > 0 && (isOwner() || !roles.some((role) => role === "admin" || role === "owner"))
  );
}
function validRoleList(roles) {
  return (
    Array.isArray(roles) &&
    roles.every((role) => roleOrder.includes(role)) &&
    new Set(roles).size === roles.length
  );
}
function firstHttpLink(body) {
  const match = /https?:\/\/[^\s<>"'\])]+/i.exec(body || "");
  return match ? match[0].replace(/[.,;:!?]+$/, "") : "";
}
function canDiagnose() {
  return isOwner() || rolesOf(state.session?.user).includes("dev");
}
function canManageTarget(user) {
  const roles = rolesOf(user);
  return (
    canManageUsers() &&
    user?.id !== "owner" &&
    roles.length > 0 &&
    (isOwner() || !roles.some((role) => role === "admin" || role === "owner"))
  );
}
function renderRoleBadges(container, roles) {
  container.replaceChildren(
    ...roles.map((role) => element("span", "badge role-badge", roleLabels[role])),
  );
}
function renderRoleChoices(id, selected) {
  const container = $(id);
  container.replaceChildren();
  for (const role of state.assignableRoles) {
    const label = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.name = "roles";
    input.value = role;
    input.defaultChecked = selected.includes(role);
    input.addEventListener("change", () => {
      if (!input.checked) return;
      if (role === "peasant") {
        for (const other of container.querySelectorAll("input")) {
          if (other !== input) other.checked = false;
        }
        return;
      }
      const peasant = container.querySelector('input[value="peasant"]');
      if (peasant) peasant.checked = false;
      if (role === "member_paid" || role === "member") {
        const sibling = container.querySelector(
          role === "member_paid" ? 'input[value="member"]' : 'input[value="member_paid"]',
        );
        if (sibling) sibling.checked = false;
      }
    });
    label.append(input, element("span", "", roleLabels[role]));
    container.append(label);
  }
}
function selectedRoles(id) {
  const selected = [...$(id).querySelectorAll("input:checked")].map((input) => input.value);
  return validRoles(selected) && selected.every((role) => state.assignableRoles.includes(role))
    ? roleOrder.filter((role) => selected.includes(role))
    : [];
}
function requireRoleLogin() {
  resetPrivate();
  loginRequired = true;
  setError("login-error", "");
  text("login-success", "Peran akun berubah. Silakan masuk kembali.");
  show("login-success");
  $("password").focus();
}
function validMemberPassword(password) {
  return password.length >= 5 && password.length <= 1024 && Boolean(password.trim());
}
function userSummary(user) {
  if (
    !user ||
    typeof user.id !== "string" ||
    !user.id ||
    typeof user.username !== "string" ||
    !rolesOf(user).length ||
    !(user.createdAt === null || Number.isFinite(user.createdAt))
  )
    throw new Error("Data pengguna tidak valid. Silakan coba lagi.");
  // Only the contract's public account fields may enter UI state.
  return { id: user.id, username: user.username, roles: rolesOf(user), createdAt: user.createdAt };
}
function clearResetUser() {
  abortRequest("user-reset");
  userResetBusy = null;
  resetUser = null;
  $("reset-user-password").value = "";
  text("reset-user-help", "");
  setError("reset-user-error", "");
  $("reset-user-submit").disabled = false;
  text("reset-user-submit", "Reset kata sandi");
}
function clearUsers() {
  abortRequest("users");
  abortRequest("user-create");
  clearResetUser();
  clearRoleUser();
  if ($("role-dialog").open) $("role-dialog").close();
  if ($("reset-user-dialog").open) $("reset-user-dialog").close();
  userCreateBusy = null;
  state.users = [];
  state.usersReady = false;
  state.assignableRoles = [];
  $("create-roles").replaceChildren();
  $("create-role-fieldset").removeAttribute("aria-invalid");
  $("users-list").replaceChildren();
  $("user-create-form").reset();
  for (const id of ["users-count", "users-status", "user-create-status"]) text(id, "");
  for (const id of ["users-error", "user-create-error"]) setError(id, "");
  show("retry-users", false);
  updateUserControls();
}
function updateUserControls() {
  const count = state.users.filter((user) => user.id !== "owner").length;
  $("user-create-submit").disabled =
    !canManageUsers() ||
    !state.usersReady ||
    !state.assignableRoles.length ||
    requests.has("users") ||
    Boolean(userCreateBusy) ||
    count >= 100;
  text("user-create-submit", userCreateBusy ? "Membuat…" : "Buat pengguna");
  $("retry-users").disabled = requests.has("users");
  $("reset-user-submit").disabled = Boolean(userResetBusy);
  text("reset-user-submit", userResetBusy ? "Menyimpan…" : "Reset kata sandi");
  $("role-submit").disabled = Boolean(roleBusy);
  $("edit-role-fieldset").disabled = Boolean(roleBusy);
  text("role-submit", roleBusy ? "Menyimpan…" : "Simpan peran");
  $("create-role-fieldset").disabled = Boolean(userCreateBusy) || !state.usersReady;
}
function renderUsers() {
  const fragment = document.createDocumentFragment();
  for (const user of state.users) {
    const li = element("li");
    li.append(
      element("strong", "", user.username),
      element(
        "span",
        "inbox-date",
        user.id === "owner"
          ? "Celestial utama dilindungi"
          : `Dibuat ${formatDate(user.createdAt, true)}`,
      ),
    );
    const badges = element("div", "role-badges");
    renderRoleBadges(badges, rolesOf(user));
    li.append(badges);
    const actions = element("div", "toolbar");
    if (isOwner()) {
      const inspect = element("button", "small-button", "Lihat inbox");
      inspect.type = "button";
      inspect.setAttribute("aria-label", `Lihat inbox ${user.username}`);
      inspect.addEventListener("click", () => switchScope(user));
      actions.append(inspect);
    }
    if (canManageTarget(user)) {
      const edit = element("button", "small-button", "Ubah peran");
      edit.type = "button";
      edit.setAttribute("aria-label", `Ubah peran ${user.username}`);
      edit.dataset.roleUser = user.id;
      edit.addEventListener("click", () => openRoleUser(user));
      actions.append(edit);
      const reset = element("button", "small-button", "Reset kata sandi");
      reset.type = "button";
      reset.setAttribute("aria-label", `Reset kata sandi ${user.username}`);
      reset.addEventListener("click", () => openResetUser(user));
      actions.append(reset);
    } else if (user.id !== "owner" && canManageUsers()) {
      li.append(element("span", "inbox-date", "Hanya Celestial dapat mengelola akun ini."));
    }
    if (canDeleteTarget(user)) {
      const remove = element("button", "small-button danger-text", "Hapus");
      remove.type = "button";
      remove.setAttribute("aria-label", `Hapus pengguna ${user.username}`);
      remove.addEventListener("click", () => confirmDeleteUser(user));
      actions.append(remove);
    }
    li.append(actions);
    fragment.append(li);
  }
  $("users-list").replaceChildren(fragment);
  text(
    "users-count",
    `${state.users.filter((user) => user.id !== "owner").length}/100 akun tambahan`,
  );
  updateUserControls();
}
function switchScope(user = null) {
  if (!isOwner()) return;
  if (user && !state.users.some((item) => item.id === user.id)) return;
  const session = state.session;
  startSession(session, user?.id === session.user.id ? null : user);
  $("inbox-search").focus();
}
function openUsers() {
  if (!canManageUsers() && !canDeleteUsers()) return;
  clearUsers();
  $("users-dialog").showModal();
  show("user-create-form", canManageUsers());
  $("user-username").focus();
  void loadUsers();
}
async function loadUsers() {
  if (
    (!canManageUsers() && !canDeleteUsers()) ||
    !$("users-dialog").open ||
    requests.has("users") ||
    userCreateBusy ||
    roleBusy
  )
    return;
  setError("users-error", "");
  show("retry-users", false);
  text("users-status", "Memuat pengguna…");
  try {
    const promise = api("/admin/users", { slot: "users" });
    updateUserControls();
    const data = await promise;
    if (!Array.isArray(data?.users) || !validRoleList(data.assignableRoles))
      throw new Error("Daftar pengguna atau pilihan peran tidak valid.");
    state.users = data.users.map(userSummary);
    state.assignableRoles = roleOrder.filter(
      (role) =>
        data.assignableRoles.includes(role) &&
        (isOwner() ||
          role === "peasant" ||
          role === "member" ||
          role === "member_paid" ||
          role === "dev"),
    );
    state.usersReady = true;
    renderRoleChoices("create-roles", ["member"]);
    text("users-status", "");
    renderUsers();
  } catch (error) {
    if (!isCanceled(error)) {
      text("users-status", "");
      setError("users-error", errorText(error));
      show("retry-users");
    }
  } finally {
    updateUserControls();
  }
}
async function createUser(event) {
  event.preventDefault();
  if (
    !canManageUsers() ||
    !$("users-dialog").open ||
    !state.usersReady ||
    userCreateBusy ||
    state.users.filter((user) => user.id !== "owner").length >= 100
  )
    return;
  const username = $("user-username").value.trim().toLowerCase();
  const password = $("user-password").value;
  const roles = selectedRoles("create-roles");
  const selected = [...$("create-roles").querySelectorAll("input:checked")].map(
    (input) => input.value,
  );
  let message = "";
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username))
    message = "Gunakan nama pengguna 3–32 karakter yang diizinkan, diawali huruf atau angka.";
  else if (username === state.users.find((user) => user.id === "owner")?.username.toLowerCase())
    message = "Nama Celestial dicadangkan. Pilih nama lain.";
  else if (!validMemberPassword(password))
    message = "Kata sandi harus 5–1024 karakter dan tidak boleh kosong.";
  else if (selected.includes("peasant") && selected.length > 1)
    message = "Quark harus dipilih sendiri, tanpa peran lain.";
  else if (!roles.length) message = "Pilih minimal satu peran yang tersedia.";
  $("create-role-fieldset").setAttribute("aria-invalid", String(!roles.length));
  setError("user-create-error", message);
  text("user-create-status", "");
  if (message) return;
  const ticket = Symbol("user-create");
  userCreateBusy = ticket;
  abortRequest("users");
  updateUserControls();
  try {
    const data = await api("/admin/users", {
      method: "POST",
      body: { username, password, roles },
      slot: "user-create",
    });
    if (userCreateBusy !== ticket) return;
    const user = userSummary(data?.user);
    if (user.id === "owner") throw new Error("Respons pengguna baru tidak valid.");
    state.users = [...state.users.filter((item) => item.id !== user.id), user];
    $("user-create-form").reset();
    renderUsers();
    text(
      "user-create-status",
      data?.inbox?.address
        ? `Pengguna dan kotak masuk ${data.inbox.address} berhasil dibuat.`
        : "Pengguna berhasil dibuat.",
    );
  } catch (error) {
    if (!isCanceled(error)) setError("user-create-error", errorText(error));
  } finally {
    if (userCreateBusy === ticket) {
      userCreateBusy = null;
      $("user-password").value = "";
      updateUserControls();
    }
  }
}
function clearRoleUser() {
  abortRequest("user-roles");
  roleBusy = null;
  roleUser = null;
  $("edit-roles").replaceChildren();
  $("edit-role-fieldset").removeAttribute("aria-invalid");
  text("role-help", "");
  setError("role-error", "");
  updateUserControls();
}
function openRoleUser(user) {
  if (!canManageTarget(user) || !state.usersReady || !$("users-dialog").open) return;
  // Never silently discard roles absent from the server's assignable choices.
  if (rolesOf(user).some((role) => !state.assignableRoles.includes(role))) {
    setError("users-error", "Peran akun ini tidak dapat diubah dengan pilihan yang tersedia.");
    return;
  }
  clearRoleUser();
  roleUser = user;
  $("user-password").value = "";
  text(
    "role-help",
    `Peran untuk ${user.username}. Quark harus dipilih sendiri dan mendapat alamat ${user.username}@${state.session?.mailDomain ?? "domain"}. Pilih minimal satu peran. Semua sesi akun ini akan keluar setelah perubahan. Jika ditutup saat menyimpan, periksa hasil sebelum mencoba lagi.`,
  );
  renderRoleChoices("edit-roles", rolesOf(user));
  $("role-dialog").showModal();
  (
    $("edit-roles").querySelector("input:checked") ?? $("edit-roles").querySelector("input")
  )?.focus();
}
async function updateUserRoles(event) {
  event.preventDefault();
  if (!canManageTarget(roleUser) || roleBusy || !$("role-dialog").open) return;
  const roles = selectedRoles("edit-roles");
  const selected = [...$("edit-roles").querySelectorAll("input:checked")].map(
    (input) => input.value,
  );
  if (selected.includes("peasant") && selected.length > 1) {
    $("edit-role-fieldset").setAttribute("aria-invalid", "true");
    setError("role-error", "Quark harus dipilih sendiri, tanpa peran lain.");
    return;
  }
  $("edit-role-fieldset").setAttribute("aria-invalid", String(!roles.length));
  setError("role-error", roles.length ? "" : "Pilih minimal satu peran yang tersedia.");
  if (!roles.length) return;
  const target = roleUser;
  const ticket = Symbol("user-roles");
  roleBusy = ticket;
  abortRequest("users");
  updateUserControls();
  try {
    const data = await api(`/admin/users/${encodeURIComponent(target.id)}/roles`, {
      method: "PATCH",
      body: { roles },
      slot: "user-roles",
    });
    if (roleBusy !== ticket) return;
    // PATCH returns a principal; createdAt belongs to the directory response.
    const user = userSummary({ ...data?.user, createdAt: target.createdAt });
    if (user.id !== target.id) throw new Error("Respons peran pengguna tidak valid.");
    if (user.id === state.session?.user.id) {
      requireRoleLogin();
      broadcastAuthChange();
      return;
    }
    state.users = state.users.map((item) => (item.id === user.id ? user : item));
    $("role-dialog").close();
    clearRoleUser();
    renderUsers();
    // The row was replaced; explicitly restore focus to its new action.
    [...$("users-list").querySelectorAll("button[data-role-user]")]
      .find((button) => button.dataset.roleUser === user.id)
      ?.focus();
    text("user-create-status", "Peran berhasil diubah. Sesi akun tersebut telah keluar.");
  } catch (error) {
    if (!isCanceled(error)) setError("role-error", errorText(error));
  } finally {
    if (roleBusy === ticket) {
      roleBusy = null;
      updateUserControls();
    }
  }
}
function clearDiagnostics() {
  abortRequest("diagnostics");
  $("diagnostics-data").replaceChildren();
  text("diagnostics-status", "");
  setError("diagnostics-error", "");
  $("refresh-diagnostics").disabled = false;
}
function openDiagnostics() {
  if (!canDiagnose()) return;
  clearDiagnostics();
  $("diagnostics-dialog").showModal();
  $("close-diagnostics").focus();
  void loadDiagnostics();
}
async function loadDiagnostics() {
  if (!canDiagnose() || !$("diagnostics-dialog").open || requests.has("diagnostics")) return;
  const version = epoch;
  $("diagnostics-data").replaceChildren();
  setError("diagnostics-error", "");
  text("diagnostics-status", "Memuat diagnostik…");
  $("refresh-diagnostics").disabled = true;
  try {
    const data = await api("/dev/diagnostics", { slot: "diagnostics" });
    const app = data?.application;
    const counts = data?.counts;
    if (
      data?.ok !== true ||
      data?.database?.ok !== true ||
      typeof app?.name !== "string" ||
      typeof app?.mailDomain !== "string" ||
      !Number.isSafeInteger(app?.retentionDays) ||
      app.retentionDays < 0 ||
      ![counts?.users, counts?.inboxes, counts?.messages].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error("Invalid diagnostics");
    // Explicit fields only: never render raw JSON, exception bodies, or extra
    // fields returned by a newer/misconfigured server. Data is not persisted.
    for (const [label, value] of [
      ["Aplikasi", app.name],
      ["Domain email", app.mailDomain],
      ["Retensi", `${app.retentionDays} hari`],
      ["Database", "Tersedia"],
      ["Pengguna", counts.users],
      ["Kotak masuk", counts.inboxes],
      ["Pesan", counts.messages],
    ]) {
      const row = element("div");
      row.append(element("dt", "", label), element("dd", "", value));
      $("diagnostics-data").append(row);
    }
    text("diagnostics-status", "");
  } catch (error) {
    if (!isCanceled(error)) {
      text("diagnostics-status", "");
      setError("diagnostics-error", "Diagnostik tidak tersedia. Silakan coba lagi.");
    }
  } finally {
    if (version === epoch && !requests.has("diagnostics"))
      $("refresh-diagnostics").disabled = false;
  }
}
function openResetUser(user) {
  if (!canManageTarget(user) || !$("users-dialog").open) return;
  clearResetUser();
  $("user-password").value = "";
  resetUser = user;
  text(
    "reset-user-help",
    `Kata sandi baru untuk ${user.username}. Semua sesi anggota ini akan keluar; sesi pengguna lain tetap aktif. Jika ditutup saat menyimpan, periksa hasil sebelum mencoba lagi.`,
  );
  $("reset-user-dialog").showModal();
  $("reset-user-password").focus();
}
async function resetUserPassword(event) {
  event.preventDefault();
  if (!canManageTarget(resetUser) || userResetBusy || !$("reset-user-dialog").open) return;
  const password = $("reset-user-password").value;
  if (!validMemberPassword(password)) {
    setError("reset-user-error", "Kata sandi harus 5–1024 karakter dan tidak boleh kosong.");
    return;
  }
  const ticket = Symbol("user-reset");
  const targetId = resetUser.id;
  userResetBusy = ticket;
  setError("reset-user-error", "");
  updateUserControls();
  try {
    await api(`/admin/users/${encodeURIComponent(targetId)}/password`, {
      method: "POST",
      body: { password },
      slot: "user-reset",
    });
    if (userResetBusy !== ticket) return;
    if (targetId === state.session?.user.id) {
      resetPrivate();
      loginRequired = true;
      broadcastAuthChange();
      logoutFailed = false;
      setError("login-error", "");
      text("login-success", "Kata sandi berhasil diubah. Masuk kembali dengan kata sandi baru.");
      show("login-success");
      $("password").focus();
      return;
    }
    $("reset-user-dialog").close();
    clearResetUser();
    text(
      "user-create-status",
      "Kata sandi anggota berhasil direset. Sesi anggota tersebut telah keluar.",
    );
  } catch (error) {
    if (!isCanceled(error)) setError("reset-user-error", errorText(error));
  } finally {
    if (userResetBusy === ticket) {
      userResetBusy = null;
      $("reset-user-password").value = "";
      updateUserControls();
    }
  }
}

$("manage-users").addEventListener("click", openUsers);
$("open-diagnostics").addEventListener("click", openDiagnostics);
$("refresh-diagnostics").addEventListener("click", () => void loadDiagnostics());
$("close-diagnostics").addEventListener("click", () => {
  $("diagnostics-dialog").close();
  clearDiagnostics();
});
$("role-form").addEventListener("submit", updateUserRoles);
$("close-role").addEventListener("click", () => {
  $("role-dialog").close();
  clearRoleUser();
});
$("return-own-inboxes").addEventListener("click", () => switchScope());
$("retry-users").addEventListener("click", () => void loadUsers());
$("user-create-form").addEventListener("submit", createUser);
$("reset-user-form").addEventListener("submit", resetUserPassword);
$("close-users").addEventListener("click", () => {
  $("users-dialog").close();
  clearUsers();
});
$("close-reset-user").addEventListener("click", () => {
  $("reset-user-dialog").close();
  clearResetUser();
});
for (const event of ["cancel", "close"]) {
  $("role-dialog").addEventListener(event, () => {
    if (event === "cancel" || !$("role-dialog").open) clearRoleUser();
  });
  $("diagnostics-dialog").addEventListener(event, () => {
    if (event === "cancel" || !$("diagnostics-dialog").open) clearDiagnostics();
  });
  $("users-dialog").addEventListener(event, () => {
    if (event === "cancel" || !$("users-dialog").open) clearUsers();
  });
  $("reset-user-dialog").addEventListener(event, () => {
    if (event === "cancel" || !$("reset-user-dialog").open) clearResetUser();
  });
}
for (const id of ["user-username", "user-password"])
  $(id).addEventListener("input", () => setError("user-create-error", ""));
$("local-part").addEventListener("input", () => {
  setError("create-error", "");
  $("local-part").removeAttribute("aria-invalid");
});
// --- Password reset -------------------------------------------------------
let resetToken = null;
let resetBusy = false;

function openForgot() {
  setError("forgot-error", "");
  show("forgot-status", false);
  $("forgot-username").value = $("username").value.trim();
  $("forgot-dialog").showModal();
  $("forgot-username").focus();
}

async function submitForgot(event) {
  event.preventDefault();
  const username = $("forgot-username").value.trim();
  if (authBusy || !username) return;
  authBusy = true;
  setError("forgot-error", "");
  show("forgot-status", false);
  text("forgot-submit", "Mengirim…");
  try {
    await api("/auth/forgot", {
      method: "POST",
      body: { username },
      slot: "auth",
      expectedUserId: null,
    });
    $("forgot-username").value = "";
    text(
      "forgot-status",
      "Kalau akun itu ada, tautan reset sudah dikirim ke email pemilik. Periksa inbox.",
    );
    show("forgot-status");
  } catch (error) {
    if (!isCanceled(error)) setError("forgot-error", errorText(error));
  } finally {
    authBusy = false;
    text("forgot-submit", "Kirim tautan");
    updateControls();
  }
}

function readResetToken() {
  const value = new URLSearchParams(location.search).get("reset");
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function clearResetToken() {
  const url = new URL(location.href);
  url.searchParams.delete("reset");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function openReset(token) {
  resetToken = token;
  resetBusy = false;
  setError("reset-error", "");
  show("reset-status", false);
  $("reset-password").value = "";
  $("reset-confirm").value = "";
  for (const node of $("reset-form").querySelectorAll("input, button")) node.disabled = false;
  if (!$("reset-dialog").open) $("reset-dialog").showModal();
  $("reset-password").focus();
}

async function submitReset(event) {
  event.preventDefault();
  if (resetBusy || !resetToken) return;
  const password = $("reset-password").value;
  if (password !== $("reset-confirm").value) {
    setError("reset-error", "Konfirmasi kata sandi tidak sama.");
    return;
  }
  resetBusy = true;
  setError("reset-error", "");
  show("reset-status", false);
  text("reset-submit", "Menyimpan…");
  try {
    await api("/auth/reset", {
      method: "POST",
      body: { token: resetToken, password },
      slot: "auth",
      expectedUserId: null,
    });
    resetToken = null;
    clearResetToken();
    $("reset-password").value = "";
    $("reset-confirm").value = "";
    for (const node of $("reset-form").querySelectorAll("input, button")) node.disabled = true;
    $("cancel-reset").disabled = false;
    text("reset-status", "Kata sandi berhasil diubah. Silakan masuk dengan kata sandi baru.");
    show("reset-status");
    $("cancel-reset").focus();
  } catch (error) {
    if (!isCanceled(error)) setError("reset-error", errorText(error));
  } finally {
    resetBusy = false;
    text("reset-submit", "Simpan kata sandi");
    updateControls();
  }
}
$("account-settings").addEventListener("click", openPassword);
$("password-form").addEventListener("submit", changePassword);
$("cancel-password").addEventListener("click", () => {
  $("password-dialog").close();
  clearPasswords();
});
$("password-dialog").addEventListener("cancel", (event) => {
  if (passwordBusy) event.preventDefault();
  else clearPasswords();
});
$("password-dialog").addEventListener("close", () => {
  clearPasswords();
  clearSessions();
});
$("revoke-others").addEventListener("click", revokeOtherSessions);
$("open-audit").addEventListener("click", openAudit);$("close-audit").addEventListener("click", () => $("audit-dialog").close());
$("refresh-audit").addEventListener("click", () => void loadAudit());
$("audit-dialog").addEventListener("close", () => {
  $("audit-list").replaceChildren();
  text("audit-status", "");
  setError("audit-error", "");
});
$("forgot-open").addEventListener("click", openForgot);
$("forgot-form").addEventListener("submit", submitForgot);
$("cancel-forgot").addEventListener("click", () => $("forgot-dialog").close());
$("forgot-username").addEventListener("input", () => setError("forgot-error", ""));
$("reset-form").addEventListener("submit", submitReset);
$("cancel-reset").addEventListener("click", () => $("reset-dialog").close());
$("reset-password").addEventListener("input", () => setError("reset-error", ""));
$("reset-confirm").addEventListener("input", () => setError("reset-error", ""));
$("copy-dialog").addEventListener("close", () => {
  $("copy-value").value = "";
});
$("copy-dialog").addEventListener("cancel", () => {
  $("copy-value").value = "";
});
$("copy-link").addEventListener("click", copyMessageLink);
$("toggle-read").addEventListener("click", () => {
  if (state.message) void setRead(state.message.id, state.inbox.id, !state.message.isRead);
});
$("message-search-form").addEventListener("submit", searchMessages);
$("message-search").addEventListener("input", searchMessages);
$("notification-toggle").addEventListener("click", toggleNotifications);
$("sound-toggle").addEventListener("click", toggleSound);
for (const id of ["login-theme", "workspace-theme"])
  $(id).addEventListener("change", () => {
    theme = $(id).value;
    preference("theme", theme);
    applyTheme();
  });
systemTheme.addEventListener("change", applyTheme);

window.addEventListener("storage", (event) => {
  if (event.key === authSignalKey && event.newValue) receiveAuthChange(event.newValue);
  if (event.key === "plato.theme") {
    theme = preference("theme") || "system";
    applyTheme();
  }
  if (event.key === "plato.notifications") {
    notificationsEnabled = preference("notifications") === "true";
    renderNotifications();
  }
});
try {
  if (typeof BroadcastChannel !== "undefined") {
    authChannel = new BroadcastChannel("plato.auth");
    authChannel.addEventListener("message", (event) => receiveAuthChange(event.data));
  }
} catch {
  // Storage and focus/visibility revalidation remain available.
}
window.addEventListener("focus", () => void revalidateSession());
applyTheme();
renderNotifications();
renderSound();
document.addEventListener("pointerdown", unlockAudio, { once: true, capture: true });
document.addEventListener("keydown", unlockAudio, { once: true, capture: true });

$("login-form").addEventListener("submit", login);
$("retry-session").addEventListener("click", restoreSession);
$("logout").addEventListener("click", logout);
$("retry-logout").addEventListener("click", logout);
$("inbox-search").addEventListener("input", renderInboxes);
$("new-inbox").addEventListener("click", openCreate);
$("create-form").addEventListener("submit", createInbox);
$("cancel-create").addEventListener("click", () => $("create-dialog").close());
$("copy-address").addEventListener("click", copyAddress);
$("close-copy").addEventListener("click", () => $("copy-dialog").close());
$("delete-inbox").addEventListener("click", () => confirmDelete("inbox"));
$("delete-message").addEventListener("click", () => confirmDelete("message"));
$("confirm-delete").addEventListener("click", deleteConfirmed);
$("cancel-delete").addEventListener("click", () => {
  confirmation = null;
  $("confirm-dialog").close();
});
$("refresh-inboxes").addEventListener("click", () => void loadInboxes());
$("retry-inboxes").addEventListener("click", () => void loadInboxes());
$("refresh-messages").addEventListener("click", () => void loadMessages());
$("retry-messages").addEventListener(
  "click",
  () => void loadMessages({ ...state.messageRetry, quiet: false }),
);
$("load-more").addEventListener("click", () => void loadMessages({ more: true }));
$("retry-reader").addEventListener("click", () => {
  if (state.messageId) void readMessage(state.messageId);
});
$("back-inboxes").addEventListener("click", () => view("inboxes", "inbox-search"));
$("back-messages").addEventListener("click", () => {
  abortRequest("detail");
  view("messages", "messages-title");
});
for (const id of ["create-dialog", "confirm-dialog"])
  $(id).addEventListener("cancel", (event) => {
    if (mutation) event.preventDefault();
  });
document.addEventListener("visibilitychange", () => {
  startPolling();
  if (document.visibilityState === "visible") void revalidateSession();
});
window.addEventListener("pagehide", () => {
  resetPrivate();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void restoreSession();
});
function handleShortcut(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
    return;
  if (!$("workspace") || $("workspace").hidden) return;
  const currentView = $("workspace").dataset.view;
  if (event.key === "j" && currentView === "messages") {
    event.preventDefault();
    moveMessageSelection(1);
  } else if (event.key === "k" && currentView === "messages") {
    event.preventDefault();
    moveMessageSelection(-1);
  } else if (event.key === "Enter" && currentView === "messages") {
    const item = document.querySelector('#message-list .message-item[aria-current="true"]');
    if (item) {
      event.preventDefault();
      item.click();
    }
  } else if (event.key === "e" && currentView === "reader") {
    event.preventDefault();
    confirmDelete("message");
  } else if (event.key === "/") {
    event.preventDefault();
    (currentView === "messages" || currentView === "reader"
      ? $("message-search")
      : $("inbox-search")
    ).focus();
  } else if (event.key === "r" && currentView !== "inboxes") {
    event.preventDefault();
    void loadMessages();
  } else if (event.key === "u" && currentView === "reader" && state.message) {
    event.preventDefault();
    void setRead(state.message.id, state.inbox.id, !state.message.isRead);
  } else if (event.key === "Escape") {
    if (currentView === "reader") view("messages", "messages-title");
    else if (currentView === "messages") view("inboxes", "inbox-search");
  }
}

$("filter-unread").addEventListener("click", () => setUnreadFilter(!state.unreadOnly));
$("mark-all-read").addEventListener("click", () => void markAllRead());
$("delete-all-messages").addEventListener("click", confirmDeleteAll);
$("forward-inbox").addEventListener("click", openForward);
$("forward-form").addEventListener("submit", saveForward);
$("cancel-forward").addEventListener("click", () => $("forward-dialog").close());
$("clear-forward").addEventListener("click", () => {
  $("forward-url").value = "";
  $("forward-form").requestSubmit();
});
$("cancel-link").addEventListener("click", () => $("link-dialog").close());
$("open-link").addEventListener("click", openPendingLink);
$("copy-link-target").addEventListener("click", copyPendingLink);
$("view-text").addEventListener("click", () => setHtmlView(false));
$("view-html").addEventListener("click", () => setHtmlView(true));
$("prev-message").addEventListener("click", () => stepMessage(-1));
$("next-message").addEventListener("click", () => stepMessage(1));
document.addEventListener("keydown", handleShortcut);
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* offline shell is optional */
  });
const initialResetToken = readResetToken();
if (initialResetToken) openReset(initialResetToken);
void restoreSession();

// ---------- API keys (bot access) ----------
async function loadApiKeys() {
  try {
    const data = await api("/keys");
    renderApiKeys(Array.isArray(data.keys) ? data.keys : []);
    setError("api-error", "");
  } catch (error) {
    setError("api-error", errorText(error));
  }
}
function renderApiKeys(keys) {
  const list = $("api-list");
  list.replaceChildren();
  const active = keys.filter((key) => !key.revoked_at).length;
  text("api-status", keys.length ? `${active} kunci aktif dari ${keys.length}.` : "Belum ada kunci.");
  for (const key of keys) {
    const row = element("li", "api-row");
    const main = element("div", "api-main");
    const seen = key.last_used_at
      ? `terakhir dipakai ${formatDate(key.last_used_at, true)}`
      : "belum dipakai";
    main.append(
      element("span", "api-name", key.name),
      element("span", "small muted", `${key.prefix}\u2026 \u00b7 ${key.revoked_at ? "dicabut" : seen}`),
    );
    row.append(main);
    if (!key.revoked_at) {
      const revoke = element("button", "small-button danger-text", "Cabut");
      revoke.type = "button";
      revoke.addEventListener("click", () => void revokeApiKey(key.id));
      row.append(revoke);
    }
    list.append(row);
  }
}
async function createApiKey() {
  const name = $("api-name").value.trim();
  if (!name) {
    setError("api-error", "Nama kunci wajib diisi.");
    return;
  }
  try {
    const data = await api("/keys", { method: "POST", body: { name } });
    $("api-token").value = data.token;
    show("api-token-box", true);
    $("api-name").value = "";
    setError("api-error", "");
    announce("Kunci API dibuat. Salin sekarang.");
    await loadApiKeys();
  } catch (error) {
    setError("api-error", errorText(error));
  }
}
async function revokeApiKey(id) {
  try {
    await api(`/keys/${id}`, { method: "DELETE", slot: "api-revoke" });
    announce("Kunci dicabut.");
    await loadApiKeys();
  } catch (error) {
    setError("api-error", errorText(error));
  }
}
$("open-api").addEventListener("click", () => {
  $("api-dialog").showModal();
  show("api-token-box", false);
  $("api-token").value = "";
  setError("api-error", "");
  void loadApiKeys();
});
$("close-api").addEventListener("click", () => $("api-dialog").close());
$("api-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void createApiKey();
});

// ---------- Notification tone settings ----------
const CUSTOM_SOUND_LIMIT = 400 * 1024;

function openSoundSettings() {
  $("sound-dialog").showModal();
  setError("sound-error", "");
  renderSound();
}
async function chooseSoundTone(value) {
  soundTone = ["chime", "bell", "blip", "marimba", "kustom"].includes(value) ? value : "chime";
  preference("sound-tone", soundTone);
  if (soundTone === "kustom") {
    const stored = preference("sound-custom");
    if (stored && !customSoundBuffer) {
      const ok = await decodeCustomSound(stored);
      if (!ok) setError("sound-error", "File nada tersimpan tidak bisa dibaca. Pilih ulang.");
    }
    if (!stored) setError("sound-error", "Pilih file audio dulu untuk nada kustom.");
  } else {
    setError("sound-error", "");
  }
  renderSound();
}
function setSoundVolume(value) {
  const percent = Math.max(0, Math.min(100, Number(value)));
  soundVolume = (Number.isFinite(percent) ? percent : 70) / 100;
  preference("sound-volume", String(Math.round(soundVolume * 100)));
}
async function handleSoundFile(file) {
  if (!file) return;
  if (file.size > CUSTOM_SOUND_LIMIT) {
    setError("sound-error", "File terlalu besar. Maksimum 400 KB.");
    return;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    setError("sound-error", "File tidak bisa dibaca.");
    return;
  }
  if (!bytes.length) {
    setError("sound-error", "File kosong.");
    return;
  }
  unlockAudio();
  if (!audioContext) {
    setError("sound-error", "Browser ini tidak menyediakan Web Audio.");
    return;
  }
  // Decode from the bytes we already hold: no object URL, no data: fetch.
  let buffer;
  try {
    buffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
  } catch {
    setError("sound-error", "Format audio tidak didukung. Coba MP3, WAV, OGG atau M4A.");
    return;
  }
  const dataUrl = `data:${file.type || "audio/mpeg"};base64,${base64FromBytes(bytes)}`;
  try {
    preference("sound-custom", dataUrl);
  } catch {
    setError("sound-error", "Nada gagal disimpan (penyimpanan penuh). Pakai file yang lebih kecil.");
    return;
  }
  customSoundBuffer = buffer;
  preference("sound-tone", "kustom");
  soundTone = "kustom";
  setError("sound-error", "");
  renderSound();
  playNotificationSound();
  announce(`Nada kustom dipakai (${Math.round(buffer.duration * 10) / 10} detik).`);
}
$("sound-settings").addEventListener("click", openSoundSettings);
$("close-sound").addEventListener("click", () => $("sound-dialog").close());
$("sound-tone").addEventListener("change", (event) => void chooseSoundTone(event.target.value));
$("sound-volume").addEventListener("input", (event) => setSoundVolume(event.target.value));
$("sound-volume").addEventListener("change", () => playNotificationSound());
$("sound-test").addEventListener("click", () => {
  unlockAudio();
  playNotificationSound();
});
$("sound-file-pick").addEventListener("click", () => $("sound-file").click());
$("sound-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  void handleSoundFile(file);
});

// Restore the stored tone before the first arrival so the very first sound is right.
if (soundTone === "kustom") {
  const stored = preference("sound-custom");
  if (stored) void decodeCustomSound(stored).then(() => renderSound());
}
renderSound();

// Keep the audio context warm: a suspended context would swallow the first beep.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") unlockAudio();
});
// Browsers only start audio after a user gesture. The first pointerdown (the login
// click) opens the context and decodes the stored custom tone, so the first arrival
// after login is not silent.
document.addEventListener(
  "pointerdown",
  () => {
    unlockAudio();
    const stored = soundTone === "kustom" ? preference("sound-custom") : null;
    if (stored && !customSoundBuffer) void decodeCustomSound(stored);
  },
  { once: true, capture: true },
);
