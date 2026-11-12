import { proxyJson } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";
export const POST = proxyJson("/api/write/suggestions");
