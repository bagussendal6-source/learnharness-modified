import { claudeCliActionResponse, claudeCliStatusResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = claudeCliStatusResponse;
export const POST = claudeCliActionResponse;
