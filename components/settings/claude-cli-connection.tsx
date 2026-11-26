"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";

interface ClaudeCliStatus { installed: boolean; loggedIn: boolean; email?: string; plan?: string; pending?: boolean }

/** Claude via the local `claude` CLI. Connect runs the CLI's own browser sign-in
 *  (`claude auth login`); the app never sees the credential. */
export function ClaudeCliConnection() {
	const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/api/claude-cli").then((r) => r.json()).then((body: ClaudeCliStatus) => { if (live) setStatus(body); }).catch(() => { if (live) setStatus({ installed: false, loggedIn: false }); });
		return () => { live = false; };
	}, []);
	async function act(action: "login" | "logout") {
		if (busy) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/claude-cli", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? "failed");
			setStatus(body);
			if (action === "login" && !body.loggedIn) setError("Sign-in did not complete. Try again.");
			notifySettingsSaved("keys");
		} catch { setError("The connection could not be changed. Try again."); }
		finally { setBusy(false); }
	}
	const connected = status?.installed === true && status.loggedIn;
	return <div className="flex flex-col gap-2" data-testid="claude-cli-connection">
		<div className="flex flex-wrap items-center gap-3">
			<span className="font-ui text-xs text-foreground">Claude</span>
			{status === null
				? <span className="font-ui text-xs text-muted-foreground">checking…</span>
				: !status.installed
				? <span className="font-ui text-xs text-muted-foreground">Claude Code is not installed. Install it, then reopen this page.</span>
				: <Button type="button" size="xs" variant={connected ? "ghost" : "outline"} className={`cursor-pointer disabled:cursor-not-allowed ${connected ? "text-muted-foreground hover:text-foreground" : ""}`} disabled={busy} data-testid="claude-cli-action" onClick={() => void act(connected ? "logout" : "login")}>
					{busy ? (connected ? "Disconnecting…" : "Waiting for browser sign-in…") : connected ? "Disconnect" : "Connect"}
				</Button>}
			{connected && <span className="font-ui text-xs text-muted-foreground">Connected{status?.email ? ` as ${status.email}` : ""}{status?.plan ? ` (${status.plan})` : ""}</span>}
		</div>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
	</div>;
}
