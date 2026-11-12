import { proxyStream } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";
export const POST = proxyStream("/api/batch-index");
