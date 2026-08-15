"use client";

import { useEffect, useState } from "react";

type SubmissionCase = {
  load_number: string;
  carrier_name: string;
  carrier_invoice_number: string | null;
  missing_documents: string[];
  expires_at: string;
};

export default function CarrierSubmission({ token }: { token: string }) {
  const [item, setItem] = useState<SubmissionCase | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(`/api/submissions?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as SubmissionCase & { error?: string };
        if (!response.ok) throw new Error(payload.error || "This upload link is not available.");
        if (active) setItem(payload);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to open this upload link.");
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [token]);

  async function submit() {
    if (!files.length) return;
    setSending(true);
    setError("");
    try {
      const form = new FormData();
      form.set("token", token);
      files.forEach((file) => form.append("files", file));
      const response = await fetch("/api/submissions", { method: "POST", body: form });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The paperwork could not be uploaded.");
      setComplete(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The paperwork could not be uploaded.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="submission-shell">
      <section className="submission-card">
        <header className="submission-header">
          <span>MEGA FLEET ACCOUNTING</span>
          <h1>Submit missing paperwork</h1>
          <p>Upload clear PDF copies so accounting can finish reviewing your invoice.</p>
        </header>

        {loading ? (
          <div className="submission-state">Checking your secure upload link…</div>
        ) : error && !item ? (
          <div className="submission-error"><strong>Upload link unavailable</strong><p>{error}</p></div>
        ) : complete ? (
          <div className="submission-success">
            <span>✓</span>
            <h2>Paperwork received</h2>
            <p>Your PDFs were added to load {item?.load_number}. Mega Fleet Accounting will review them before releasing the invoice for processing.</p>
          </div>
        ) : item ? (
          <>
            <div className="submission-summary">
              <div><span>Mega Fleet load</span><strong>{item.load_number}</strong></div>
              <div><span>Carrier invoice</span><strong>{item.carrier_invoice_number || "Not provided"}</strong></div>
              <div className="wide"><span>Carrier</span><strong>{item.carrier_name}</strong></div>
            </div>
            <section className="submission-missing">
              <span>DOCUMENTS NEEDED</span>
              <ul>{item.missing_documents.map((document) => <li key={document}>{document}</li>)}</ul>
            </section>
            <label className="upload-zone">
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                onChange={(event) => setFiles(Array.from(event.target.files || []).slice(0, 5))}
              />
              <strong>{files.length ? `${files.length} PDF${files.length === 1 ? "" : "s"} selected` : "Choose PDF paperwork"}</strong>
              <span>Up to 5 PDFs · 10 MB each</span>
            </label>
            {files.length > 0 && (
              <ul className="selected-files">{files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}</ul>
            )}
            {error && <div className="submission-inline-error" role="alert">{error}</div>}
            <button className="submission-button" disabled={!files.length || sending} onClick={() => void submit()}>
              {sending ? "Uploading…" : "Submit paperwork"}
            </button>
            <p className="submission-footnote">Submitting files does not automatically approve the invoice. Mega Fleet Accounting must confirm the packet is complete.</p>
          </>
        ) : null}
      </section>
    </main>
  );
}
