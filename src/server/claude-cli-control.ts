/**
 * Claude CLI sign-in control (backs /api/claude-cli).
 *
 *  GET  → { installed, loggedIn, email?, plan?, pending }
 *  POST {action: "login" | "logout"} → "login" opens the CLI's own browser
 *         sign-in and waits for it; resolves to the new status.
 *
 * The login belongs to the `claude` CLI (`claude auth …`); this only drives it.
 * No credential ever passes through the app.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { claudeCliBinary, setClaudeCliLogin } from "../agent/claude-cli.ts";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
let login: { child: ChildProcess; done: Promise<void> } | undefined;

function cliEnv(): NodeJS.ProcessEnv {
	return { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
}
function run(binary: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(binary, args, { timeout: 20_000, env: cliEnv() }, (_error, stdout) => resolve(String(stdout ?? "")));
	});
}

async function status() {
	const binary = claudeCliBinary();
	if (!binary) return { installed: false, loggedIn: false, pending: false };
	let info: { loggedIn?: boolean; email?: string; subscriptionType?: string } = {};
	try { info = JSON.parse(await run(binary, ["auth", "status"])); } catch { /* not signed in / unreadable */ }
	setClaudeCliLogin(info.loggedIn === true);
	return { installed: true, loggedIn: info.loggedIn === true, email: info.email, plan: info.subscriptionType, pending: login !== undefined };
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function claudeCliStatusResponse(): Promise<Response> {
	return Response.json(await status(), { headers: NO_STORE });
}

export async function claudeCliActionResponse(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	const binary = claudeCliBinary();
	if (!binary) return Response.json({ error: "The `claude` CLI was not found." }, { status: 404 });
	if (body?.action === "login") {
		if (!login) {
			const child = spawn(binary, ["auth", "login", "--claudeai"], { stdio: "ignore", env: cliEnv() });
			const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
			const done = new Promise<void>((resolve) => child.once("close", () => { clearTimeout(timer); login = undefined; resolve(); }));
			login = { child, done };
		}
		await login.done;
	} else if (body?.action === "logout") {
		await run(binary, ["auth", "logout"]);
	} else {
		return Response.json({ error: "action must be login or logout" }, { status: 400 });
	}
	return Response.json(await status(), { headers: NO_STORE });
}
