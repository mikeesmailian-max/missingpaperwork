import {
  AccountingFollowup,
  authenticatedEmail,
  isConfigured,
  previewCases,
  supabaseRequest,
} from "../../../lib/accounting";

type ScanRun = {
  completed_at: string | null;
  messages_scanned: number;
  cases_created: number;
  cases_updated: number;
  replies_found: number;
};

export async function GET() {
  if (!(await isConfigured())) {
    return Response.json({
      cases: previewCases,
      scan: {
        completed_at: "2026-08-15T19:00:00Z",
        messages_scanned: 500,
        cases_created: 18,
        cases_updated: 0,
        replies_found: 9,
      },
      fixture: true,
    });
  }

  try {
    const [cases, scans] = await Promise.all([
      supabaseRequest<AccountingFollowup[]>(
        "accounting_followups?select=*&order=priority.asc,request_sent_at.desc",
      ),
      supabaseRequest<ScanRun[]>(
        "accounting_scan_runs?select=completed_at,messages_scanned,cases_created,cases_updated,replies_found&order=started_at.desc&limit=1",
      ),
    ]);
    return Response.json({ cases, scan: scans[0] ?? null, fixture: false });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load cases." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  if (!(await isConfigured())) {
    return Response.json(
      { error: "Actions are disabled in preview mode." },
      { status: 409 },
    );
  }

  try {
    const body = (await request.json()) as {
      id?: string;
      action?: "receive" | "complete" | "reopen" | "snooze";
      note?: string;
    };
    if (!body.id || !body.action) {
      return Response.json({ error: "Case and action are required." }, { status: 400 });
    }

    const actor = authenticatedEmail(request);
    const now = new Date().toISOString();
    let update: Record<string, unknown>;

    const currentRows = await supabaseRequest<AccountingFollowup[]>(
      `accounting_followups?id=eq.${encodeURIComponent(body.id)}&select=*`,
    );
    const current = currentRows[0];
    if (!current) return Response.json({ error: "Case not found." }, { status: 404 });

    if (body.action === "receive") {
      if (current.status === "paperwork_received") {
        return Response.json({ case: current, unchanged: true });
      }
      update = {
        status: "paperwork_received",
        paperwork_received_at: now,
        paperwork_received_by: actor,
        paperwork_source_message_id: current.latest_outlook_message_id ?? null,
        next_follow_up_at: null,
        updated_at: now,
      };
    } else if (body.action === "complete") {
      if (current.status === "completed") {
        return Response.json({ case: current, unchanged: true });
      }
      if (current.status !== "paperwork_received") {
        return Response.json(
          { error: "Mark the paperwork received before accounting approval." },
          { status: 409 },
        );
      }
      update = {
        status: "completed",
        completed_at: now,
        completed_by: actor,
        completion_note: body.note?.trim() || "Accounting reviewed and approved the complete paperwork packet.",
        resolution_confirmed_at: now,
        resolution_source_message_id: current.paperwork_source_message_id ?? current.latest_outlook_message_id ?? null,
        purge_after: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        next_follow_up_at: null,
        updated_at: now,
      };
    } else if (body.action === "reopen") {
      update = {
        status: "open",
        completed_at: null,
        completed_by: null,
        completion_note: null,
        resolution_confirmed_at: null,
        resolution_source_message_id: null,
        paperwork_received_at: null,
        paperwork_received_by: null,
        paperwork_source_message_id: null,
        purge_after: null,
        updated_at: now,
      };
    } else {
      const wake = new Date();
      wake.setUTCDate(wake.getUTCDate() + 3);
      wake.setUTCHours(17, 0, 0, 0);
      update = {
        status: "snoozed",
        next_follow_up_at: wake.toISOString(),
        updated_at: now,
      };
    }

    const rows = await supabaseRequest<AccountingFollowup[]>(
      `accounting_followups?id=eq.${encodeURIComponent(body.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(update),
      },
    );
    if (!rows[0]) return Response.json({ error: "Case not found." }, { status: 404 });

    await supabaseRequest("accounting_followup_events", {
      method: "POST",
      body: JSON.stringify({
        followup_id: body.id,
        event_type: body.action,
        actor,
        note: body.note?.trim() || null,
        occurred_at: now,
      }),
    });

    return Response.json({ case: rows[0] });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to update case." },
      { status: 500 },
    );
  }
}
