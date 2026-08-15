"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountingFollowup, FollowupStatus } from "../lib/accounting";

type ScanRun = {
  completed_at: string | null;
  messages_scanned: number;
  cases_created: number;
  cases_updated: number;
  replies_found: number;
};

type Filter = "active" | "contacted" | FollowupStatus | "all";
type NavSection = "home" | "followups" | "contacted" | "completed" | "schedule";

type CasesPayload = {
  cases?: AccountingFollowup[];
  scan?: ScanRun | null;
  error?: string;
};

const statusCopy: Record<FollowupStatus, string> = {
  open: "Needs owner",
  awaiting_reply: "Awaiting paperwork",
  reply_received: "Reply received",
  needs_review: "Needs review",
  paperwork_received: "Paperwork received",
  completed: "Completed",
  snoozed: "Snoozed",
};

function shortDate(value: string | null) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

function calendarDate(value: string | null) {
  if (!value) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

function money(value: number | null, currency = "USD") {
  if (value === null) return "Not provided";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function daysWaiting(value: string | null) {
  if (!value) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000),
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function reminderDraft(item: AccountingFollowup) {
  const prefix = item.attempt_count >= 2 ? "Final request: " : item.attempt_count === 1 ? "Second request: " : "";
  return `${prefix}Please send ${item.missing_documents.join(", ")} for Mega Fleet load ${item.load_number}. We cannot finish reviewing or schedule payment until the complete, legible paperwork is received.`;
}

function isReminderPaused(item: AccountingFollowup) {
  return Boolean(
    item.reminder_paused_until &&
      new Date(item.reminder_paused_until).getTime() > Date.now(),
  );
}

function deliveryLabel(item: AccountingFollowup) {
  if (item.last_reply_at) return "Replied";
  if (!item.last_reminder_recipient) return item.request_sent_at ? "Requested" : "Not contacted";
  return (item.email_delivery_status || "sent").replace("_", " ");
}

async function fetchCases() {
  const response = await fetch("/api/cases", { cache: "no-store" });
  const payload = await readResponseJson<CasesPayload>(response);
  if (!response.ok) throw new Error(payload?.error || `Unable to load the queue (${response.status}).`);
  if (!payload) throw new Error("The accounting server returned an empty response. Please refresh again.");
  return payload;
}

async function readResponseJson<T>(response: Response): Promise<T | undefined> {
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`The accounting server returned an invalid response (${response.status}).`);
  }
}

export default function AccountingDashboard() {
  const [cases, setCases] = useState<AccountingFollowup[]>([]);
  const [scan, setScan] = useState<ScanRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [activeNav, setActiveNav] = useState<NavSection>("home");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sendCase, setSendCase] = useState<AccountingFollowup | null>(null);
  const [completeCase, setCompleteCase] = useState<AccountingFollowup | null>(null);
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [sendRequestId, setSendRequestId] = useState("");
  const [completionNote, setCompletionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState("");

  const loadCases = useCallback(async () => {
    try {
      const payload = await fetchCases();
      setError("");
      setCases(payload.cases ?? []);
      setScan(payload.scan ?? null);
      setSelectedId((current) =>
        current && payload.cases?.some((item) => item.id === current)
          ? current
          : null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchCases()
      .then((payload) => {
        if (!active) return;
        setError("");
        setCases(payload.cases ?? []);
        setScan(payload.scan ?? null);
        setSelectedId(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load the queue.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selected = cases.find((item) => item.id === selectedId) ?? null;

  const summary = useMemo(() => {
    const active = cases.filter((item) => item.status !== "completed");
    return {
      active: active.length,
      waiting: active.filter((item) => item.status === "awaiting_reply").length,
      review: active.filter((item) => item.status === "needs_review" || item.status === "paperwork_received").length,
      received: active.filter((item) => item.status === "paperwork_received").length,
      high: active.filter((item) => item.priority === "high").length,
      completed: cases.filter((item) => item.status === "completed").length,
      contacted: cases.filter((item) => Boolean(item.request_sent_at || item.attempt_count > 0 || item.last_reminder_recipient)).length,
    };
  }, [cases]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return cases.filter((item) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "contacted"
          ? Boolean(item.request_sent_at || item.attempt_count > 0 || item.last_reminder_recipient)
          : false) ||
        (filter === "active"
          ? item.status !== "completed"
          : item.status === filter);
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [
        item.load_number,
        item.carrier_name,
        item.carrier_invoice_number,
        item.invoice_amount,
        item.carrier_email,
        item.factoring_company,
        item.factoring_email,
        item.staff_note,
        ...item.missing_documents,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [cases, filter, search]);

  function replaceCase(updated: AccountingFollowup, select = true) {
    setCases((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    if (select) setSelectedId(updated.id);
  }

  function goHome() {
    setSelectedId(null);
    setSearch("");
    setFilter("active");
    setActiveNav("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openQueueView(nextFilter: Filter, section: NavSection) {
    setFilter(nextFilter);
    setSelectedId(null);
    setActiveNav(section);
    window.requestAnimationFrame(() => {
      document.getElementById("follow-ups")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function openSchedule() {
    setSelectedId(null);
    setActiveNav("schedule");
    document.getElementById("schedule")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function refreshDashboard() {
    setRefreshing(true);
    await loadCases();
    setRefreshing(false);
    setToast("Dashboard refreshed with the latest accounting data.");
  }

  function openSend(item: AccountingFollowup) {
    const defaultRecipient = item.factoring_email || item.carrier_email || "";
    setSendCase(item);
    setRecipient(defaultRecipient);
    setMessage(reminderDraft(item));
    setSendRequestId(crypto.randomUUID());
    setError("");
  }

  async function sendReminder() {
    if (!sendCase || !recipient) return;
    const sendingCase = sendCase;
    const requestId = sendRequestId || crypto.randomUUID();
    if (!sendRequestId) setSendRequestId(requestId);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sendingCase.id, recipient, message, requestId }),
      });
      const payload = await readResponseJson<{
        case?: AccountingFollowup;
        error?: string;
      }>(response);
      let updated = payload?.case;
      if (!updated) {
        const recovered = await fetchCases().catch(() => undefined);
        updated = recovered?.cases?.find(
          (item) => item.id === sendingCase.id && item.last_reminder_request_id === requestId,
        );
      }
      if (!response.ok && !updated) {
        throw new Error(payload?.error || `The reminder request failed (${response.status}).`);
      }
      if (!updated) {
        throw new Error("The server did not confirm the reminder. Refresh before trying again to avoid a duplicate email.");
      }
      replaceCase(updated);
      setSendCase(null);
      setSendRequestId("");
      setToast(`Reminder sent for load ${sendingCase.load_number}.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The reminder was not sent.");
    } finally {
      setBusy(false);
    }
  }

  async function updateCase(
    item: AccountingFollowup,
    action: "receive" | "complete" | "reopen" | "snooze",
    note = "",
  ) {
    if (action === "complete") {
      setCompleteCase(null);
      setSelectedId(null);
      setToast(`Saving accounting approval for load ${item.load_number}…`);
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/cases", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action, note }),
      });
      const payload = await readResponseJson<{
        case?: AccountingFollowup;
        error?: string;
      }>(response);
      let updated = payload?.case;
      if (!updated) {
        const expectedStatus = action === "receive" ? "paperwork_received" : action === "complete" ? "completed" : action === "reopen" ? "open" : "snoozed";
        const recovered = await fetchCases().catch(() => undefined);
        updated = recovered?.cases?.find((candidate) => candidate.id === item.id && candidate.status === expectedStatus);
      }
      if (!response.ok && !updated) {
        throw new Error(payload?.error || `The case update failed (${response.status}).`);
      }
      if (!updated) {
        throw new Error("The server did not confirm the update. Refresh the dashboard before trying again.");
      }
      replaceCase(updated, action !== "complete");
      if (action === "receive") {
        setSelectedId(null);
        setFilter("paperwork_received");
        setActiveNav("followups");
      }
      if (action === "complete") {
        setSelectedId(null);
        setFilter("completed");
        setActiveNav("completed");
        window.requestAnimationFrame(() => {
          document.getElementById("follow-ups")?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
      setCompleteCase(null);
      setCompletionNote("");
      const words =
        action === "receive"
          ? "marked as paperwork received"
          : action === "complete"
          ? "marked complete"
          : action === "snooze"
            ? "snoozed"
            : "reopened";
      setToast(`Load ${item.load_number} ${words}.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "The case was not updated.");
      if (action === "complete") setCompleteCase(item);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="rail" aria-label="Mega Fleet navigation">
        <div className="brand-mark" aria-label="Mega Fleet">MF</div>
        <div className="rail-actions">
          <Link className={activeNav === "home" ? "rail-icon active" : "rail-icon"} aria-label="Home" href="/" onClick={goHome}>
            <span aria-hidden="true">⌂</span><span>Home</span>
          </Link>
          <button className={activeNav === "followups" ? "rail-icon active" : "rail-icon"} onClick={() => openQueueView("active", "followups")}>
            <span aria-hidden="true">✓</span><span>Follow-ups</span><b>{summary.active}</b>
          </button>
          <button className={activeNav === "contacted" ? "rail-icon active" : "rail-icon"} onClick={() => openQueueView("contacted", "contacted")}>
            <span aria-hidden="true">✉</span><span>Contacted</span><b>{summary.contacted}</b>
          </button>
          <button className={activeNav === "completed" ? "rail-icon active" : "rail-icon"} onClick={() => openQueueView("completed", "completed")}>
            <span aria-hidden="true">✓</span><span>Completed</span><b>{summary.completed}</b>
          </button>
          <button className={activeNav === "schedule" ? "rail-icon active" : "rail-icon"} onClick={openSchedule}>
            <span aria-hidden="true">◷</span><span>Schedule</span>
          </button>
        </div>
        <div className="rail-avatar">ME</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Mega Fleet Accounting</div>
            <h1>Carrier paperwork control</h1>
            <p className="subhead">
              One place for every incomplete invoice packet and every follow-up.
            </p>
          </div>
          <div className="topbar-actions">
            <Link className="home-button" href="/" aria-label="Go to dashboard home" onClick={goHome}>
              <span aria-hidden="true">⌂</span> Home
            </Link>
            <div className="connection-pill"><span /> Outlook + Resend connected</div>
            <button className="secondary-button" onClick={() => void refreshDashboard()} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh dashboard"}
            </button>
          </div>
        </header>

        <section className="scan-strip" id="schedule" aria-label="Automation status">
          <div className="scan-status">
            <span className="live-dot" />
            <div>
              <strong>Mailbox monitor is active</strong>
              <span>Inbox/Accounting</span>
            </div>
          </div>
          <div className="scan-stat">
            <span>Schedule</span>
            <strong>Mon / Wed / Fri · 10:00 AM PT</strong>
          </div>
          <div className="scan-stat">
            <span>Last scan</span>
            <strong>{scan?.completed_at ? shortDate(scan.completed_at) : "Not run yet"}</strong>
          </div>
          <div className="scan-stat">
            <span>Mailbox coverage</span>
            <strong>{scan?.messages_scanned ?? 0} messages reviewed</strong>
          </div>
        </section>

        <section className="metric-grid" aria-label="Follow-up summary">
          <article className="metric-card primary">
            <span className="metric-label">Active to-do list</span>
            <strong>{summary.active}</strong>
            <small>Incomplete carrier packets</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">Awaiting paperwork</span>
            <strong>{summary.waiting}</strong>
            <small>Carrier or factor owes a reply</small>
          </article>
          <article className="metric-card amber">
            <span className="metric-label">Documents to review</span>
            <strong>{summary.review}</strong>
            <small>Replies or PDFs were received</small>
          </article>
          <article className="metric-card red">
            <span className="metric-label">High priority</span>
            <strong>{summary.high}</strong>
            <small>Payment is blocked</small>
          </article>
        </section>

        <section className="queue-panel" id="follow-ups">
          <div className="queue-toolbar">
            <div>
              <div className="eyebrow">Live work queue</div>
              <h2>Paperwork follow-ups</h2>
            </div>
            <label className="search-box">
              <span>Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Load, carrier, invoice or document"
              />
            </label>
          </div>

          <div className="filter-row" role="tablist" aria-label="Case status filters">
            {[
              ["active", `Active ${summary.active}`],
              ["contacted", `Contacted ${summary.contacted}`],
              ["awaiting_reply", `Awaiting ${summary.waiting}`],
              ["needs_review", `Review ${summary.review}`],
              ["paperwork_received", `Received ${summary.received}`],
              ["snoozed", "Snoozed"],
              ["completed", `Completed ${summary.completed}`],
              ["all", "All"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "filter-chip active" : "filter-chip"}
                onClick={() => {
                  setFilter(value as Filter);
                  setActiveNav(value === "completed" ? "completed" : value === "contacted" ? "contacted" : "followups");
                }}
                role="tab"
                aria-selected={filter === value}
              >
                {label}
              </button>
            ))}
          </div>

          {error && <div className="error-banner" role="alert">{error}</div>}

          <div className={selected ? "queue-layout with-detail" : "queue-layout"}>
            <div className="table-wrap">
              {loading ? (
                <div className="loading-state">Loading the accounting queue…</div>
              ) : visible.length === 0 ? (
                <div className="empty-state">
                  <strong>No cases match this view.</strong>
                  <span>Try a different filter or search term.</span>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Load / priority</th>
                      <th>Carrier</th>
                      <th>Carrier invoice</th>
                      <th>Amount</th>
                      <th>Missing paperwork</th>
                      <th>Latest activity</th>
                      <th>Contacted</th>
                      <th>Status</th>
                      <th><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr
                        key={item.id}
                        className={selectedId === item.id ? "selected-row" : ""}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <td>
                          <div className="load-cell">
                            <span className={`priority-dot ${item.priority}`} />
                            <div>
                              <strong>{item.load_number}</strong>
                              <small>{item.priority === "high" ? "Payment blocked" : `${daysWaiting(item.request_sent_at)}d open`}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="carrier-cell">
                            <span className="company-avatar">{initials(item.carrier_name)}</span>
                            <div>
                              <strong>{item.carrier_name}</strong>
                              <small>{item.factoring_company || item.carrier_email || "Contact needed"}</small>
                            </div>
                          </div>
                        </td>
                        <td><span className={item.carrier_invoice_number ? "invoice-number" : "muted"}>{item.carrier_invoice_number || "Missing"}</span></td>
                        <td><span className={item.invoice_amount !== null ? "invoice-number" : "muted"}>{money(item.invoice_amount, item.currency_code)}</span></td>
                        <td>
                          <div className="doc-list">
                            {item.missing_documents.slice(0, 2).map((doc) => <span key={doc}>{doc}</span>)}
                            {item.missing_documents.length > 2 && <span>+{item.missing_documents.length - 2}</span>}
                          </div>
                        </td>
                        <td>
                          <div className="activity-cell">
                            <strong>{item.escalation_level === 3 ? "Escalated" : item.last_reply_at ? "Reply received" : `Request ${item.attempt_count}`}</strong>
                            <small>{shortDate(item.last_reply_at || item.request_sent_at)}</small>
                          </div>
                        </td>
                        <td>
                          <div className="activity-cell contacted-cell">
                            <strong>{deliveryLabel(item)}</strong>
                            <small>{item.last_reminder_recipient || (item.request_sent_at ? shortDate(item.request_sent_at) : "—")}</small>
                          </div>
                        </td>
                        <td><span className={`status-pill ${item.status}`}>{statusCopy[item.status]}</span></td>
                        <td>
                          <button
                            className="row-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(item.id);
                            }}
                            aria-label={`Open load ${item.load_number}`}
                          >
                            →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {selected && (
              <aside className="detail-panel" aria-label={`Details for load ${selected.load_number}`}>
                <div className="detail-heading">
                  <div>
                    <span className="eyebrow">Mega Fleet load</span>
                    <h3>{selected.load_number}</h3>
                  </div>
                  <button className="close-button" onClick={() => setSelectedId(null)} aria-label="Close details">×</button>
                </div>

                <div className="detail-company">
                  <span className="company-avatar large">{initials(selected.carrier_name)}</span>
                  <div>
                    <strong>{selected.carrier_name}</strong>
                    <span>Carrier invoice {selected.carrier_invoice_number || "not provided"}</span>
                  </div>
                </div>

                <div className={`detail-callout ${selected.status}`}>
                  <strong>{statusCopy[selected.status]}</strong>
                  <p>{selected.staff_note}</p>
                </div>

                {isReminderPaused(selected) && (
                  <section className="reply-pause-card">
                    <span>REMINDERS PAUSED</span>
                    <strong>Waiting until {calendarDate(selected.reminder_paused_until ?? null)}</strong>
                    <p>{selected.reminder_pause_reason || selected.last_reply_summary || "A reply was received and the case is waiting for the promised paperwork."}</p>
                    {selected.last_reply_sender && <small>Reply from {selected.last_reply_sender}</small>}
                  </section>
                )}

                <section className="detail-section">
                  <h4>Document completeness check</h4>
                  {selected.document_checklist?.length ? (
                    <div className="checklist-grid">
                      {selected.document_checklist.map((item) => (
                        <div className={`checklist-item ${item.status}`} key={`${item.document}-${item.status}`}>
                          <span>{item.status === "present" ? "✓" : item.status === "missing" ? "!" : "?"}</span>
                          <div><strong>{item.document}</strong>{item.evidence && <small>{item.evidence}</small>}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="missing-grid">
                      {selected.missing_documents.map((doc) => (
                        <div key={doc}><span>!</span>{doc}</div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="detail-section two-col">
                  <div>
                    <h4>Invoice amount</h4>
                    <p>{money(selected.invoice_amount, selected.currency_code)}</p>
                  </div>
                  <div>
                    <h4>Invoice received</h4>
                    <p>{calendarDate(selected.invoice_received_at)}</p>
                  </div>
                </section>

                <section className="detail-section two-col">
                  <div>
                    <h4>Email delivery</h4>
                    <p className={`delivery-status ${selected.last_reply_at ? "replied" : selected.email_delivery_status || "not-sent"}`}>
                      {deliveryLabel(selected)}
                    </p>
                    {selected.last_reminder_recipient && <small>{selected.last_reminder_recipient}</small>}
                  </div>
                  <div>
                    <h4>Escalation</h4>
                    <p>{selected.escalation_level === 3 ? "Internal escalation" : selected.escalation_level === 2 ? "Second reminder due" : selected.escalation_level === 1 ? "First reminder due" : "Not escalated"}</p>
                    {selected.alternate_contact_needed && <small className="contact-alert">Alternate contact required</small>}
                  </div>
                </section>

                <section className="detail-section two-col">
                  <div>
                    <h4>Carrier contact</h4>
                    <p>{selected.carrier_email || "Not identified yet"}</p>
                  </div>
                  <div>
                    <h4>Factoring contact</h4>
                    <p>{selected.factoring_email || "Not on this case"}</p>
                  </div>
                </section>

                <section className="detail-section">
                  <h4>Follow-up history</h4>
                  <ol className="timeline">
                    <li>
                      <span />
                      <div><strong>Missing paperwork requested</strong><small>{selected.requested_by || "Mega Fleet Accounting"} · {shortDate(selected.request_sent_at)}</small></div>
                    </li>
                    {selected.last_reply_at && (
                      <li>
                        <span />
                        <div><strong>Reply detected{selected.last_reply_sender ? ` from ${selected.last_reply_sender}` : ""}</strong><small>{selected.last_reply_summary || "Reply received"} · {shortDate(selected.last_reply_at)}</small></div>
                      </li>
                    )}
                    {selected.promised_document_at && (
                      <li className="future">
                        <span />
                        <div><strong>Paperwork promised</strong><small>{calendarDate(selected.promised_document_at)}</small></div>
                      </li>
                    )}
                    {Boolean(selected.carrier_upload_count) && (
                      <li>
                        <span />
                        <div><strong>Carrier uploaded {selected.carrier_upload_count} file{selected.carrier_upload_count === 1 ? "" : "s"}</strong><small>{shortDate(selected.carrier_upload_received_at ?? null)}</small></div>
                      </li>
                    )}
                    {selected.next_follow_up_at && (
                      <li className="future">
                        <span />
                        <div><strong>Next follow-up due</strong><small>{shortDate(selected.next_follow_up_at)}</small></div>
                      </li>
                    )}
                  </ol>
                </section>

                {selected.status === "completed" && (
                  <section className="detail-section retention-note">
                    <h4>Completed-case retention</h4>
                    <p>Completed {shortDate(selected.completed_at)}</p>
                    <small>{selected.purge_after ? `Automatically deletes ${calendarDate(selected.purge_after)}` : "Scheduled for automatic deletion after 30 days"}</small>
                  </section>
                )}

                {selected.pdf_names.length > 0 && (
                  <section className="detail-section">
                    <h4>PDFs found in Outlook</h4>
                    {selected.pdf_names.map((name) => (
                      <div className="file-row" key={name}><span>PDF</span><strong>{name}</strong></div>
                    ))}
                  </section>
                )}

                <div className="detail-actions">
                  {selected.status !== "completed" ? (
                    <>
                      {selected.status !== "paperwork_received" && (
                        <button
                          className="primary-button"
                          onClick={() => openSend(selected)}
                          disabled={(!selected.carrier_email && !selected.factoring_email) || isReminderPaused(selected)}
                        >
                          {isReminderPaused(selected) ? "Reminder paused" : selected.attempt_count >= 2 ? "Send final notice" : selected.attempt_count === 1 ? "Send second request" : "Send reminder"}
                        </button>
                      )}
                      {selected.status === "paperwork_received" ? (
                        <button className="complete-button" onClick={() => { setCompleteCase(selected); setCompletionNote(""); }}>
                          Approve & complete
                        </button>
                      ) : (
                        <button className="secondary-button" onClick={() => void updateCase(selected, "receive")}>
                          Mark paperwork received
                        </button>
                      )}
                      <button className="text-button" onClick={() => void updateCase(selected, "snooze")}>Snooze 3 days</button>
                    </>
                  ) : (
                    <button className="secondary-button" onClick={() => void updateCase(selected, "reopen")}>Reopen case</button>
                  )}
                  {selected.outlook_web_link && selected.outlook_web_link !== "#" && (
                    <a className="text-link" href={selected.outlook_web_link} target="_blank" rel="noreferrer">Open in Outlook ↗</a>
                  )}
                </div>
              </aside>
            )}
          </div>
        </section>
      </section>

      {sendCase && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setSendCase(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="send-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">Resend email</span><h2 id="send-title">Send paperwork reminder</h2></div>
              <button className="close-button" onClick={() => setSendCase(null)} aria-label="Close">×</button>
            </div>
            <div className="email-preview-summary">
              <span>Load <strong>{sendCase.load_number}</strong></span>
              <span>Invoice <strong>{sendCase.carrier_invoice_number || "missing"}</strong></span>
              <span>Amount <strong>{money(sendCase.invoice_amount, sendCase.currency_code)}</strong></span>
              <span>Received <strong>{calendarDate(sendCase.invoice_received_at)}</strong></span>
            </div>
            <label className="form-field">
              <span>Send to</span>
              <select value={recipient} onChange={(event) => setRecipient(event.target.value)}>
                {sendCase.factoring_email && <option value={sendCase.factoring_email}>{sendCase.factoring_company || "Factoring company"} — {sendCase.factoring_email}</option>}
                {sendCase.carrier_email && <option value={sendCase.carrier_email}>{sendCase.carrier_name} — {sendCase.carrier_email}</option>}
              </select>
            </label>
            <label className="form-field">
              <span>Message</span>
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={6} />
            </label>
            <div className="warning-note">
              The email uses the correct escalation level, includes a secure paperwork-upload button, lists the load and carrier invoice numbers, copies accounting@megafleetcorp.com, and attaches saved PDFs when available.
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setSendCase(null)} disabled={busy}>Cancel</button>
              <button className="primary-button" onClick={() => void sendReminder()} disabled={busy || !recipient}>{busy ? "Sending…" : "Send email"}</button>
            </div>
          </section>
        </div>
      )}

      {completeCase && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setCompleteCase(null)}>
          <section className="modal compact" role="dialog" aria-modal="true" aria-labelledby="complete-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">Accounting approval</span><h2 id="complete-title">Approve load {completeCase.load_number}?</h2></div>
              <button className="close-button" onClick={() => setCompleteCase(null)} aria-label="Close">×</button>
            </div>
            <p className="modal-copy">Confirm that accounting reviewed the received paperwork and found the packet complete. Approval removes the load from the active queue, keeps it in Completed for 30 days, and then automatically deletes the case and stored PDFs.</p>
            {error && <div className="error-banner modal-error" role="alert">{error}</div>}
            <label className="form-field">
              <span>Completion note</span>
              <textarea value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} rows={3} placeholder="Example: All signed POD pages reviewed and accepted." />
            </label>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setCompleteCase(null)} disabled={busy}>Cancel</button>
              <button className="complete-button" onClick={() => void updateCase(completeCase, "complete", completionNote)} disabled={busy}>{busy ? "Saving…" : "Approve & complete"}</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}
