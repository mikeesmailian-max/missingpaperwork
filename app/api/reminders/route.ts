import {
  AccountingFollowup,
  authenticatedEmail,
  config,
  createSecureToken,
  escapeHtml,
  isConfigured,
  nextBusinessFollowup,
  reminderIsPaused,
  sha256,
  supabaseRequest,
} from "../../../lib/accounting";

function formatMoney(amount: number | null, currency = "USD") {
  if (amount === null) return "Not provided";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

function formatReceivedDate(value: string | null) {
  if (!value) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));
}

type StoredPdfAttachment = {
  filename: string;
  content_type: "application/pdf";
  content_base64: string;
};

function usablePdfAttachments(rows: StoredPdfAttachment[]) {
  const selected: StoredPdfAttachment[] = [];
  let estimatedBytes = 0;
  for (const row of rows) {
    if (!row.filename.toLowerCase().endsWith(".pdf") || !row.content_base64) continue;
    const nextBytes = Math.ceil((row.content_base64.length * 3) / 4);
    if (estimatedBytes + nextBytes > 35_000_000) continue;
    selected.push(row);
    estimatedBytes += nextBytes;
  }
  return selected;
}

export async function POST(request: Request) {
  if (!(await isConfigured())) {
    return Response.json(
      { error: "Sending is disabled in preview mode." },
      { status: 409 },
    );
  }

  try {
    const body = (await request.json()) as {
      id?: string;
      recipient?: string;
      message?: string;
      requestId?: string;
    };
    if (!body.id || !body.recipient) {
      return Response.json(
        { error: "A case and recipient are required." },
        { status: 400 },
      );
    }

    const rows = await supabaseRequest<AccountingFollowup[]>(
      `accounting_followups?id=eq.${encodeURIComponent(body.id)}&select=*`,
    );
    const followup = rows[0];
    if (!followup) return Response.json({ error: "Case not found." }, { status: 404 });

    if (reminderIsPaused(followup)) {
      return Response.json(
        {
          error: `Reminders are paused until ${formatReceivedDate(followup.reminder_paused_until ?? null)} because a reply was received.`,
        },
        { status: 409 },
      );
    }

    if (["reply_received", "needs_review", "paperwork_received", "completed"].includes(followup.status)) {
      return Response.json(
        { error: "A reply or paperwork is already waiting for accounting review. No reminder was sent." },
        { status: 409 },
      );
    }

    const allowedRecipients = [
      followup.carrier_email,
      followup.factoring_email,
    ].filter(Boolean) as string[];
    if (
      !allowedRecipients.some(
        (email) => email.toLowerCase() === body.recipient?.toLowerCase(),
      )
    ) {
      return Response.json(
        { error: "Choose a saved carrier or factoring-company email." },
        { status: 400 },
      );
    }

    const requestId = body.requestId?.trim() || crypto.randomUUID();
    if (followup.last_reminder_request_id === requestId) {
      return Response.json({ case: followup, duplicatePrevented: true });
    }

    const runtime = await config();
    if (!runtime.RESEND_API_KEY) {
      return Response.json({ error: "Resend is not configured." }, { status: 500 });
    }

    const invoiceLine = followup.carrier_invoice_number
      ? `Carrier invoice: ${followup.carrier_invoice_number}`
      : "Carrier invoice: Not yet provided";
    const invoiceAmount = formatMoney(
      followup.invoice_amount,
      followup.currency_code,
    );
    const receivedDate = formatReceivedDate(followup.invoice_received_at);
    const missing = followup.missing_documents.join(", ");
    const customMessage = body.message?.trim();
    const escalationLevel = Math.min(3, Math.max(1, followup.attempt_count + 1));
    const stage =
      escalationLevel === 1
        ? {
            label: "FIRST REQUEST",
            heading: "Paperwork needed to process your invoice",
            banner: "PAPERWORK REQUIRED",
            bannerDetail: "Please send the missing documents so payment can be processed",
            subject: `Paperwork required: Load ${followup.load_number} / Invoice ${followup.carrier_invoice_number || "not provided"}`,
          }
        : escalationLevel === 2
          ? {
              label: "SECOND REQUEST",
              heading: "Second request for missing paperwork",
              banner: "INVOICE PAYMENT REMAINS ON HOLD",
              bannerDetail: "We still need the documents listed below",
              subject: `Second request: Load ${followup.load_number} / Invoice ${followup.carrier_invoice_number || "not provided"}`,
            }
          : {
              label: "FINAL NOTICE",
              heading: "Final paperwork notice before escalation",
              banner: "FINAL NOTICE — PAYMENT ON HOLD",
              bannerDetail: "Immediate action is required to complete this invoice packet",
              subject: `Final notice: Load ${followup.load_number} / Invoice ${followup.carrier_invoice_number || "not provided"}`,
            };
    const uploadToken = createSecureToken();
    const uploadTokenHash = await sha256(uploadToken);
    const uploadExpiresAt = new Date(Date.now() + 21 * 86_400_000).toISOString();
    const submissionUrl = new URL(`/submit/${uploadToken}`, request.url).toString();
    const storedAttachments = await supabaseRequest<StoredPdfAttachment[]>(
      `accounting_followup_attachments?followup_id=eq.${encodeURIComponent(followup.id)}&content_type=eq.application%2Fpdf&select=filename,content_type,content_base64&order=created_at.asc`,
    );
    const pdfAttachments = usablePdfAttachments(storedAttachments);
    const text = [
      `${stage.label}: ${stage.banner}`,
      "",
      "Hello,",
      "",
      `We are following up on Mega Fleet load ${followup.load_number}.`,
      invoiceLine,
      `Invoice amount: ${invoiceAmount}`,
      `Invoice received: ${receivedDate}`,
      `Missing documentation: ${missing}.`,
      "",
      customMessage ||
        "Please send the complete, legible documentation so we can finish reviewing and processing this carrier invoice.",
      "",
      "We cannot process or schedule payment until all required documentation is received.",
      "",
      `Upload the missing paperwork securely: ${submissionUrl}`,
      "",
      "Thank you,",
      "Mega Fleet Accounting",
    ].join("\n");
    const html = `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Missing paperwork for load ${escapeHtml(followup.load_number)}</title>
        </head>
        <body style="margin:0;padding:0;background:#f2f5f3;font-family:Arial,Helvetica,sans-serif;color:#17221c">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f2f5f3">
            <tr>
              <td align="center" style="padding:32px 14px">
                <table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;background:#ffffff;border:1px solid #dbe4de;border-radius:18px;overflow:hidden">
                  <tr>
                    <td style="padding:26px 30px;background:#123f2d;color:#ffffff">
                      <p style="margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#b9d8c6">Mega Fleet Accounting · ${stage.label}</p>
                      <h1 style="margin:0;font-size:25px;line-height:1.25">${stage.heading}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:28px 30px 10px">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 22px;background:#9f2f2a;border-radius:12px">
                        <tr>
                          <td align="center" style="padding:20px 16px;color:#ffffff">
                            <p style="margin:0;font-size:24px;line-height:1.2;font-weight:900;letter-spacing:.4px">${stage.banner}</p>
                            <p style="margin:8px 0 0;font-size:15px;line-height:1.4;font-weight:700;color:#ffe1df">${stage.bannerDetail}</p>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello,</p>
                      <p style="margin:0;font-size:15px;line-height:1.6;color:#46534b">We received the carrier invoice below, but the file is incomplete. Please review the details and reply with the requested documentation.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:18px 30px">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #dfe6e1;border-radius:12px;border-collapse:separate;overflow:hidden">
                        <tr>
                          <td style="padding:13px 16px;background:#f5f8f6;border-bottom:1px solid #dfe6e1;font-size:12px;font-weight:700;color:#66736b;text-transform:uppercase;letter-spacing:.7px">Mega Fleet load number</td>
                          <td align="right" style="padding:13px 16px;background:#f5f8f6;border-bottom:1px solid #dfe6e1;font-size:18px;font-weight:800;color:#123f2d">${escapeHtml(followup.load_number)}</td>
                        </tr>
                        <tr>
                          <td style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:13px;color:#66736b">Carrier</td>
                          <td align="right" style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:14px;font-weight:700">${escapeHtml(followup.carrier_name)}</td>
                        </tr>
                        <tr>
                          <td style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:13px;color:#66736b">Carrier invoice number</td>
                          <td align="right" style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:14px;font-weight:700">${escapeHtml(followup.carrier_invoice_number || "Not provided")}</td>
                        </tr>
                        <tr>
                          <td style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:13px;color:#66736b">Invoice amount</td>
                          <td align="right" style="padding:12px 16px;border-bottom:1px solid #edf1ee;font-size:14px;font-weight:700">${escapeHtml(invoiceAmount)}</td>
                        </tr>
                        <tr>
                          <td style="padding:12px 16px;font-size:13px;color:#66736b">Invoice received</td>
                          <td align="right" style="padding:12px 16px;font-size:14px;font-weight:700">${escapeHtml(receivedDate)}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 30px 18px">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#fff5e7;border:1px solid #f0d6ad;border-radius:12px">
                        <tr>
                          <td style="padding:16px 18px">
                            <p style="margin:0 0 7px;font-size:12px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:#9a560a">Missing documentation</p>
                            <p style="margin:0;font-size:15px;line-height:1.55;font-weight:700;color:#5d3b16">${escapeHtml(missing)}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 30px 28px">
                      <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334139">${escapeHtml(customMessage || "Please reply to this email with complete, legible copies of the missing documentation so we can finish reviewing the invoice.")}</p>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#fceceb;border-radius:10px">
                        <tr>
                          <td style="padding:14px 16px;font-size:14px;line-height:1.5;font-weight:700;color:#91332f">Payment cannot be processed or scheduled until all required documentation is received and reviewed.</td>
                        </tr>
                      </table>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:20px">
                        <tr>
                          <td align="center">
                            <a href="${escapeHtml(submissionUrl)}" style="display:inline-block;padding:15px 24px;background-color:#176746;border-radius:9px;color:#ffffff;font-size:16px;line-height:20px;font-weight:800;text-decoration:none">Submit Missing Paperwork</a>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:12px 0 0;font-size:12px;line-height:1.5;text-align:center;color:#6b776f">This secure link is tied to load ${escapeHtml(followup.load_number)} and expires in 21 days.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:20px 30px;background:#f5f8f6;border-top:1px solid #e3e9e5;font-size:13px;line-height:1.6;color:#647169">
                      Thank you,<br><strong style="color:#243128">Mega Fleet Accounting</strong><br>accounting@megafleetcorp.com
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>`;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify({
        from:
          runtime.RESEND_FROM_EMAIL ||
          "Mega Fleet Accounting <accounting@megafleetcorp.com>",
        to: [body.recipient],
        cc: ["accounting@megafleetcorp.com"],
        reply_to: runtime.RESEND_REPLY_TO || "accounting@megafleetcorp.com",
        subject: stage.subject,
        text,
        html,
        ...(pdfAttachments.length
          ? {
              attachments: pdfAttachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content_base64,
              })),
            }
          : {}),
        tags: [
          { name: "workflow", value: "carrier-paperwork" },
          { name: "load", value: followup.load_number },
        ],
      }),
    });
    const resendRaw = await resendResponse.text();
    const resendResult = (resendRaw.trim() ? JSON.parse(resendRaw) : {}) as {
      id?: string;
      message?: string;
    };
    if (!resendResponse.ok || !resendResult.id) {
      throw new Error(resendResult.message || "Resend rejected the reminder.");
    }

    const now = new Date().toISOString();
    const updated = await supabaseRequest<AccountingFollowup[]>(
      `accounting_followups?id=eq.${encodeURIComponent(followup.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "awaiting_reply",
          attempt_count: followup.attempt_count + 1,
          escalation_level: escalationLevel,
          request_sent_at: now,
          next_follow_up_at: nextBusinessFollowup(),
          resend_message_id: resendResult.id,
          email_delivery_status: "sent",
          last_reminder_recipient: body.recipient,
          last_reminder_request_id: requestId,
          email_sent_at: now,
          email_delivered_at: null,
          email_opened_at: null,
          email_bounced_at: null,
          last_delivery_check_at: now,
          alternate_contact_needed: false,
          upload_token_hash: uploadTokenHash,
          upload_token_expires_at: uploadExpiresAt,
          updated_at: now,
        }),
      },
    );

    await supabaseRequest("accounting_followup_events", {
      method: "POST",
      body: JSON.stringify({
        followup_id: followup.id,
        event_type: "reminder_sent",
        actor: authenticatedEmail(request),
        note: `${stage.label} sent to ${body.recipient}; accounting@megafleetcorp.com copied; ${pdfAttachments.length} PDF attachment(s) included; secure upload link added`,
        payload: {
          recipient: body.recipient,
          cc: ["accounting@megafleetcorp.com"],
          pdf_attachments: pdfAttachments.map((attachment) => attachment.filename),
          resend_id: resendResult.id,
          escalation_level: escalationLevel,
          upload_expires_at: uploadExpiresAt,
        },
        occurred_at: now,
      }),
    });

    return Response.json({ case: updated[0], messageId: resendResult.id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to send reminder." },
      { status: 500 },
    );
  }
}
