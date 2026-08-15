import {
  AccountingFollowup,
  isConfigured,
  sha256,
  supabaseRequest,
} from "../../../lib/accounting";

type SubmissionRow = AccountingFollowup & {
  upload_token_hash?: string | null;
};

async function findCase(token: string) {
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const hash = await sha256(token.toLowerCase());
  const rows = await supabaseRequest<SubmissionRow[]>(
    `accounting_followups?upload_token_hash=eq.${encodeURIComponent(hash)}&select=*`,
  );
  return rows[0] ?? null;
}

function validateCase(item: SubmissionRow | null) {
  if (!item) return "This upload link is invalid.";
  if (item.status === "completed") return "This invoice packet has already been completed.";
  if (!item.upload_token_expires_at || new Date(item.upload_token_expires_at).getTime() <= Date.now()) {
    return "This upload link has expired. Please contact accounting@megafleetcorp.com for a new link.";
  }
  return null;
}

export async function GET(request: Request) {
  if (!(await isConfigured())) return Response.json({ error: "Uploads are not configured." }, { status: 503 });
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    const item = await findCase(token);
    const invalid = validateCase(item);
    if (invalid || !item) return Response.json({ error: invalid }, { status: 404 });
    return Response.json({
      load_number: item.load_number,
      carrier_name: item.carrier_name,
      carrier_invoice_number: item.carrier_invoice_number,
      missing_documents: item.missing_documents,
      expires_at: item.upload_token_expires_at,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to validate upload link." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isConfigured())) return Response.json({ error: "Uploads are not configured." }, { status: 503 });
  try {
    const form = await request.formData();
    const token = String(form.get("token") || "");
    const item = await findCase(token);
    const invalid = validateCase(item);
    if (invalid || !item) return Response.json({ error: invalid }, { status: 404 });

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (!files.length || files.length > 5) {
      return Response.json({ error: "Choose between 1 and 5 PDF files." }, { status: 400 });
    }

    let totalBytes = 0;
    const attachments: Array<Record<string, unknown>> = [];
    for (const file of files) {
      totalBytes += file.size;
      if (file.size <= 0 || file.size > 10_000_000 || totalBytes > 25_000_000) {
        return Response.json({ error: "Each PDF must be under 10 MB and the combined upload must be under 25 MB." }, { status: 413 });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPdf = file.type === "application/pdf" && String.fromCharCode(...bytes.slice(0, 4)) === "%PDF";
      if (!isPdf) return Response.json({ error: `${file.name} is not a valid PDF.` }, { status: 400 });
      const safeName = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 140) || "paperwork.pdf";
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      attachments.push({
        followup_id: item.id,
        filename: safeName,
        content_type: "application/pdf",
        content_base64: btoa(binary),
        source_message_id: `carrier-upload:${new Date().toISOString()}`,
      });
    }

    await supabaseRequest("accounting_followup_attachments", {
      method: "POST",
      body: JSON.stringify(attachments),
    });

    const now = new Date().toISOString();
    const names = [...new Set([...(item.pdf_names || []), ...attachments.map((entry) => String(entry.filename))])];
    await supabaseRequest(`accounting_followups?id=eq.${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "needs_review",
        carrier_upload_received_at: now,
        carrier_upload_count: (item.carrier_upload_count || 0) + attachments.length,
        attachment_count: item.attachment_count + attachments.length,
        pdf_names: names,
        next_follow_up_at: null,
        reminder_paused_at: now,
        reminder_paused_until: null,
        reminder_pause_reason: "Carrier submitted paperwork through the secure upload page; accounting review is required.",
        staff_note: `Carrier uploaded ${attachments.length} PDF${attachments.length === 1 ? "" : "s"}. Review the packet before approving payment.`,
        updated_at: now,
      }),
    });
    await supabaseRequest("accounting_followup_events", {
      method: "POST",
      body: JSON.stringify({
        followup_id: item.id,
        event_type: "carrier_upload_received",
        actor: item.last_reminder_recipient || "carrier upload link",
        note: `${attachments.length} PDF${attachments.length === 1 ? "" : "s"} submitted for accounting review`,
        payload: { filenames: attachments.map((entry) => entry.filename) },
        occurred_at: now,
      }),
    });
    return Response.json({ ok: true, uploaded: attachments.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to upload paperwork." }, { status: 500 });
  }
}
