import { config, supabaseRequest } from "../../../../lib/accounting";

type ResendWebhook = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    [key: string]: unknown;
  };
};

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyWebhook(request: Request, payload: string, secret: string) {
  const id = request.headers.get("svix-id") || "";
  const timestamp = request.headers.get("svix-timestamp") || "";
  const signatures = request.headers.get("svix-signature") || "";
  if (!id || !timestamp || !signatures) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

  const key = decodeBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, signed);
  const expected = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return signatures
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter(Boolean)
    .some((candidate) => constantTimeEqual(candidate, expected));
}

export async function POST(request: Request) {
  const runtime = await config();
  if (!runtime.RESEND_WEBHOOK_SECRET) {
    return Response.json({ error: "Webhook verification is not configured." }, { status: 503 });
  }
  const raw = await request.text();
  if (!(await verifyWebhook(request, raw, runtime.RESEND_WEBHOOK_SECRET))) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  try {
    const event = JSON.parse(raw) as ResendWebhook;
    const emailId = event.data?.email_id;
    const eventId = request.headers.get("svix-id") || crypto.randomUUID();
    if (!emailId || !event.type.startsWith("email.")) return Response.json({ ok: true, ignored: true });

    const existing = await supabaseRequest<Array<{ id: string }>>(
      `accounting_followup_events?message_id=eq.${encodeURIComponent(eventId)}&select=id&limit=1`,
    );
    if (existing.length) return Response.json({ ok: true, duplicate: true });

    const cases = await supabaseRequest<Array<{ id: string }>>(
      `accounting_followups?resend_message_id=eq.${encodeURIComponent(emailId)}&select=id&limit=1`,
    );
    const followup = cases[0];
    if (!followup) return Response.json({ ok: true, unmatched: true });

    const now = event.created_at || new Date().toISOString();
    const update: Record<string, unknown> = { last_delivery_check_at: now, updated_at: now };
    if (event.type === "email.sent") update.email_delivery_status = "sent";
    if (event.type === "email.delivered") {
      update.email_delivery_status = "delivered";
      update.email_delivered_at = now;
    }
    if (event.type === "email.opened") {
      update.email_delivery_status = "opened";
      update.email_opened_at = now;
    }
    if (event.type === "email.bounced") {
      update.email_delivery_status = "bounced";
      update.email_bounced_at = now;
      update.alternate_contact_needed = true;
    }
    if (event.type === "email.complained") {
      update.email_delivery_status = "complained";
      update.email_complained_at = now;
      update.alternate_contact_needed = true;
    }
    if (event.type === "email.failed" || event.type === "email.suppressed") {
      update.email_delivery_status = "failed";
      update.email_failed_at = now;
      update.alternate_contact_needed = true;
    }

    await supabaseRequest(`accounting_followups?id=eq.${encodeURIComponent(followup.id)}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    });
    await supabaseRequest("accounting_followup_events", {
      method: "POST",
      body: JSON.stringify({
        followup_id: followup.id,
        event_type: event.type,
        actor: "Resend",
        note: `Resend reported ${event.type.replace("email.", "")}`,
        message_id: eventId,
        payload: { resend_email_id: emailId, to: event.data?.to || [] },
        occurred_at: now,
      }),
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Webhook processing failed." }, { status: 500 });
  }
}
